import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * @notice Setup relayer roles for privacy-first swap architecture
 * @dev Grants KEEPER_MANAGER_ROLE, adds keeper, grants RELAYER_ROLE
 * 
 * The keeper/relayer address is derived from KEEPER_PRIVATE_KEY in .env
 * If not set, falls back to PRIVATE_KEY (deployer acts as keeper for testnet)
 * Addresses are loaded from deployments/<network>.json (SSOT).
 */
async function main() {
  console.log("🔐 Setting up relayer roles for privacy architecture...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const network = await ethers.provider.getNetwork();
  const networkKey =
    network.chainId === 11155111n
      ? "sepolia"
      : network.chainId === 421614n
        ? "arbitrumSepolia"
        : `chain-${network.chainId}`;
  const ssotPath = path.join(__dirname, "..", "deployments", `${networkKey}.json`);
  if (!fs.existsSync(ssotPath)) {
    console.error(`❌ Missing SSOT: ${ssotPath}`);
    process.exit(1);
  }
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  const VAULT_ADDRESS = ssot.contracts.NoctisVault as string;
  const EXCHANGE_ADDRESS = ssot.contracts.NoctisExchange as string;
  console.log("SSOT vault:", VAULT_ADDRESS);
  console.log("SSOT exchange:", EXCHANGE_ADDRESS);

  // Derive keeper address from KEEPER_PRIVATE_KEY or fallback to deployer
  const keeperPrivateKey = process.env.KEEPER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";
  if (!keeperPrivateKey) {
    console.error("❌ No KEEPER_PRIVATE_KEY or PRIVATE_KEY in .env");
    process.exit(1);
  }
  const keeperWallet = new ethers.Wallet(keeperPrivateKey);
  const keeperAddress = keeperWallet.address;
  console.log("Keeper/Relayer address:", keeperAddress);

  // Connect to contracts
  const exchange = await ethers.getContractAt("NoctisExchange", EXCHANGE_ADDRESS);

  // Get role hashes
  const DEFAULT_ADMIN_ROLE = await exchange.DEFAULT_ADMIN_ROLE();
  const KEEPER_MANAGER_ROLE = await exchange.KEEPER_MANAGER_ROLE();
  const RELAYER_ROLE = await exchange.RELAYER_ROLE();

  console.log("\nRole hashes:");
  console.log("  DEFAULT_ADMIN_ROLE:", DEFAULT_ADMIN_ROLE);
  console.log("  KEEPER_MANAGER_ROLE:", KEEPER_MANAGER_ROLE);
  console.log("  RELAYER_ROLE:", RELAYER_ROLE);

  // Step 1: Grant KEEPER_MANAGER_ROLE to deployer (so we can add keepers)
  console.log("\n1️⃣ Granting KEEPER_MANAGER_ROLE to deployer...");
  const hasKeeperManager = await exchange.hasRole(KEEPER_MANAGER_ROLE, deployer.address);
  if (hasKeeperManager) {
    console.log("   Already has KEEPER_MANAGER_ROLE ✅");
  } else {
    const tx1 = await exchange.grantRole(KEEPER_MANAGER_ROLE, deployer.address);
    await tx1.wait();
    console.log("   Granted ✅ (tx:", tx1.hash, ")");
  }

  // Step 2: Set minKeepers to 1 (testnet)
  console.log("\n2️⃣ Setting minKeepers to 1...");
  try {
    const tx2 = await exchange.setMinKeepers(1);
    await tx2.wait();
    console.log("   Set minKeepers=1 ✅ (tx:", tx2.hash, ")");
  } catch (e: any) {
    if (e.message.includes("already") || e.reason?.includes("already")) {
      console.log("   Already set ✅");
    } else {
      console.log("   Note:", e.reason || e.message);
    }
  }

  // Step 3: Add keeper
  console.log("\n3️⃣ Adding keeper:", keeperAddress);
  try {
    const tx3 = await exchange.addKeeper(keeperAddress);
    await tx3.wait();
    console.log("   Added keeper ✅ (tx:", tx3.hash, ")");
  } catch (e: any) {
    if (e.message.includes("already") || e.reason?.includes("KeeperAlreadyAuthorized")) {
      console.log("   Already authorized ✅");
    } else {
      console.log("   Note:", e.reason || e.message);
    }
  }

  // Step 4: Grant RELAYER_ROLE to keeper
  console.log("\n4️⃣ Granting RELAYER_ROLE to keeper...");
  const hasRelayer = await exchange.hasRole(RELAYER_ROLE, keeperAddress);
  if (hasRelayer) {
    console.log("   Already has RELAYER_ROLE ✅");
  } else {
    const tx4 = await exchange.grantRole(RELAYER_ROLE, keeperAddress);
    await tx4.wait();
    console.log("   Granted ✅ (tx:", tx4.hash, ")");
  }

  // Verify setup
  console.log("\n🔍 Verifying setup...");
  const hasRelayerRole = await exchange.hasRole(RELAYER_ROLE, keeperAddress);
  console.log("  Has RELAYER_ROLE:", hasRelayerRole ? "✅" : "❌");

  // Vault keepers (withdrawals) — separate from exchange keepers
  const vault = await ethers.getContractAt("NoctisVault", VAULT_ADDRESS);
  console.log("\n5️⃣ Adding vault keeper:", keeperAddress);
  try {
    const vtx = await vault.addKeeper(keeperAddress);
    await vtx.wait();
    console.log("   Vault keeper added ✅ (tx:", vtx.hash, ")");
  } catch (e: any) {
    console.log("   Note:", e.reason || e.shortMessage || e.message);
  }

  console.log("\n✨ Relayer setup complete!");
  console.log("\nNext steps:");
  console.log("1. Update keeper/.env with new VAULT_ADDRESS and EXCHANGE_ADDRESS");
  console.log("2. Update frontend/.env.local with new addresses");
  console.log("3. Start keeper: cd keeper && npm start");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
