/**
 * @notice Deploy a 1/1 Safe as feeRecipient and split keeper/relayer key from deployer.
 * @dev Sepolia + Mainnet (Phase D). Uses @safe-global/protocol-kit.
 *
 *   npx hardhat run scripts/setupTreasuryAndRelayer.ts --network sepolia
 *   npx hardhat run scripts/setupTreasuryAndRelayer.ts --network mainnet
 *
 * Env:
 *   PRIVATE_KEY              — deployer / admin (DEFAULT_ADMIN_ROLE)
 *   KEEPER_PRIVATE_KEY       — if missing or same as PRIVATE_KEY, a new key is generated
 *   FORCE_NEW_KEEPER=1       — always generate a fresh keeper key
 *   FUND_KEEPER_ETH          — ETH to fund keeper (default 0.05 Sepolia / 0.15 mainnet)
 *   SKIP_SAFE=1              — only split/grant relayer (reuse existing feeRecipient Safe)
 *   KEEP_DEPLOYER_RELAYER=1  — do not revoke RELAYER_ROLE from deployer
 *   SAFE_ADDRESS             — optional: use existing Safe instead of deploying
 *
 * Updates deployments/<network>.json feeRecipient. Prints the new keeper key once;
 * writes it to keeper/.env when that file exists (does not commit secrets).
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { SafeFactory } from "@safe-global/protocol-kit";
import { loadSsot, rpcUrlForChain, saveSsot } from "./lib/ssot";

function loadEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function upsertEnvKey(filePath: string, key: string, value: string) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${key}=${value}\n`);
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  fs.writeFileSync(filePath, next.join("\n").replace(/\n+$/, "\n"));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const { path: ssotPath, data: ssot, network: netName } = loadSsot(network.chainId);
  const exchangeAddress = ssot.contracts.NoctisExchange as string;
  const vaultAddress = ssot.contracts.NoctisVault as string;

  console.log("Network:", netName, `(${network.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Exchange:", exchangeAddress);
  console.log("Vault:", vaultAddress);
  console.log("SSOT:", ssotPath);

  const exchange = await ethers.getContractAt("NoctisExchange", exchangeAddress);
  const vault = await ethers.getContractAt("NoctisVault", vaultAddress);

  // ── 1) Safe feeRecipient ─────────────────────────────────────────────
  let safeAddress =
    process.env.SAFE_ADDRESS ||
    (ssot.contracts.feeRecipient as string) ||
    "";
  const skipSafe = process.env.SKIP_SAFE === "1";
  const currentFee = await exchange.feeRecipient();
  console.log("\nCurrent feeRecipient:", currentFee);

  if (!skipSafe) {
    const rpc = rpcUrlForChain(network.chainId);
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY required to deploy / configure Safe");

    if (safeAddress && ethers.isAddress(safeAddress)) {
      const code = await ethers.provider.getCode(safeAddress);
      if (code === "0x") {
        throw new Error(`SAFE_ADDRESS has no code: ${safeAddress}`);
      }
      console.log("\n1️⃣ Using existing Safe:", safeAddress);
    } else {
      console.log("\n1️⃣ Deploying 1/1 Safe (owner = deployer)...");
      console.log("   RPC:", rpc);
      const factory = await SafeFactory.init({
        provider: rpc,
        signer: pk.startsWith("0x") ? pk : `0x${pk}`,
        safeVersion: "1.4.1",
      });

      const saltNonce = Date.now().toString();
      const safe = await factory.deploySafe({
        safeAccountConfig: {
          owners: [deployer.address],
          threshold: 1,
        },
        saltNonce,
      });
      safeAddress = await safe.getAddress();
      console.log("   Safe deployed:", safeAddress, "(saltNonce:", saltNonce + ")");
    }

    if (currentFee.toLowerCase() !== safeAddress.toLowerCase()) {
      console.log("\n2️⃣ setFeeRecipient → Safe");
      const tx = await exchange.setFeeRecipient(safeAddress);
      await tx.wait();
      console.log("   feeRecipient set ✅", tx.hash);
    } else {
      console.log("   feeRecipient already Safe ✅");
    }
  } else {
    safeAddress = currentFee;
    console.log("\n1️⃣ SKIP_SAFE=1 — keeping feeRecipient:", safeAddress);
  }

  // ── 2) Split keeper / relayer key ────────────────────────────────────
  console.log("\n3️⃣ Split relayer key from deployer...");
  const protocolEnv = loadEnvFile(path.join(__dirname, "..", ".env"));
  const keeperEnvPath = path.join(__dirname, "..", "..", "keeper", ".env");
  const keeperEnv = loadEnvFile(keeperEnvPath);

  const deployerPk = (process.env.PRIVATE_KEY || protocolEnv.PRIVATE_KEY || "").replace(/^0x/, "");
  let keeperPk = (
    process.env.KEEPER_PRIVATE_KEY ||
    keeperEnv.KEEPER_PRIVATE_KEY ||
    ""
  ).replace(/^0x/, "");

  const forceNew = process.env.FORCE_NEW_KEEPER === "1";
  const sameAsDeployer =
    !!keeperPk && !!deployerPk && keeperPk.toLowerCase() === deployerPk.toLowerCase();

  let generated = false;
  if (forceNew || !keeperPk || sameAsDeployer) {
    keeperPk = ethers.Wallet.createRandom().privateKey.replace(/^0x/, "");
    generated = true;
    console.log("   Generated new KEEPER_PRIVATE_KEY");
  } else {
    console.log("   Reusing existing KEEPER_PRIVATE_KEY (distinct from deployer)");
  }

  const keeperWallet = new ethers.Wallet(`0x${keeperPk}`, ethers.provider);
  console.log("   Keeper address:", keeperWallet.address);
  console.log("   sameAsDeployer before:", sameAsDeployer || forceNew ? "was same / forced" : "already split");

  if (generated) {
    console.log("\n   ⚠️  SAVE THIS KEY (shown once in logs; also written to keeper/.env):");
    console.log(`   KEEPER_PRIVATE_KEY=0x${keeperPk}`);
    if (fs.existsSync(keeperEnvPath)) {
      upsertEnvKey(keeperEnvPath, "KEEPER_PRIVATE_KEY", `0x${keeperPk}`);
      console.log("   Updated keeper/.env ✅");
    }
    // Local ops backup (gitignored — do not commit)
    const backupPath = path.join(
      __dirname,
      "..",
      "deployments",
      `.${netName}-keeper.key`
    );
    fs.writeFileSync(backupPath, `0x${keeperPk}\n`, { mode: 0o600 });
    console.log("   Backup:", backupPath, "(do not commit)");
  }

  // Fund keeper for gas
  const fundEth =
    process.env.FUND_KEEPER_ETH ||
    (netName === "mainnet" ? "0.15" : "0.05");
  const fundWei = ethers.parseEther(fundEth);
  const bal = await ethers.provider.getBalance(keeperWallet.address);
  if (bal < fundWei / 2n) {
    console.log(`\n4️⃣ Funding keeper with ${fundEth} ETH...`);
    const fundTx = await deployer.sendTransaction({
      to: keeperWallet.address,
      value: fundWei,
    });
    await fundTx.wait();
    console.log("   Funded ✅", fundTx.hash);
  } else {
    console.log("\n4️⃣ Keeper already funded ✅ balance:", ethers.formatEther(bal), "ETH");
  }

  // Roles
  const RELAYER_ROLE = await exchange.RELAYER_ROLE();

  console.log("\n5️⃣ Granting RELAYER_ROLE to keeper...");
  if (!(await exchange.hasRole(RELAYER_ROLE, keeperWallet.address))) {
    const t = await exchange.grantRole(RELAYER_ROLE, keeperWallet.address);
    await t.wait();
    console.log("   RELAYER_ROLE granted ✅", t.hash);
  } else {
    console.log("   RELAYER_ROLE already granted ✅");
  }

  console.log("\n6️⃣ Vault keepers (timelocked after first init)...");
  const vaultKeeperCount = await vault.getKeeperCount();
  const newIsVaultKeeper = await vault.isKeeper(keeperWallet.address);
  console.log("   vault keeper count:", vaultKeeperCount.toString());
  if (vaultKeeperCount === 0n) {
    const t = await vault.initializeKeepers([keeperWallet.address], 1);
    await t.wait();
    console.log("   initializeKeepers([newKeeper], 1) ✅", t.hash);
  } else if (!newIsVaultKeeper) {
    try {
      const t = await vault.proposeAddKeeperV2(keeperWallet.address);
      const receipt = await t.wait();
      console.log("   proposeAddKeeperV2(newKeeper) ✅", t.hash);
      console.log("   ⏳ executeKeeperChangeV2 after 48h timelock");
    } catch (e: any) {
      console.log("   proposeAddKeeperV2:", e.reason || e.shortMessage || e.message);
    }
  } else {
    console.log("   new keeper already on vault ✅");
  }

  // Revoke deployer as relayer/keeper when split
  if (
    process.env.KEEP_DEPLOYER_RELAYER !== "1" &&
    keeperWallet.address.toLowerCase() !== deployer.address.toLowerCase()
  ) {
    console.log("\n7️⃣ Revoking deployer from operational exchange roles...");
    if (await exchange.hasRole(RELAYER_ROLE, deployer.address)) {
      const t = await exchange.revokeRole(RELAYER_ROLE, deployer.address);
      await t.wait();
      console.log("   revoked RELAYER_ROLE from deployer ✅", t.hash);
    }
  }

  // SSOT update
  ssot.contracts.feeRecipient = safeAddress;
  ssot.updatedAt = new Date().toISOString().slice(0, 10);
  ssot.ops = {
    ...(ssot.ops || {}),
    feeRecipientSafe: safeAddress,
    relayer: keeperWallet.address,
    deployerAdmin: deployer.address,
    note: "feeRecipient is 1/1 Safe (deployer owner). Relayer key split from deployer.",
  };
  if (netName === "mainnet" && !ssot.ops.softCaps) {
    ssot.ops.softCaps = {
      maxDepositEth: "5",
      maxDepositUsdc: "20000",
      protocolTvlUsdSoft: "100000",
      note: "Ops pause if soft TVL breached; tighten via Safe.",
    };
  }
  ssot.notes =
    "SSOT for addresses. feeRecipient = Safe. Relayer is dedicated key (not deployer). Sync frontend/keeper/subgraph from this file.";
  saveSsot(ssotPath, ssot);
  console.log("\n📝 Updated", ssotPath);

  // Verify
  const feeNow = await exchange.feeRecipient();
  const hasRelayer = await exchange.hasRole(RELAYER_ROLE, keeperWallet.address);
  const deployerStillRelayer = await exchange.hasRole(RELAYER_ROLE, deployer.address);
  console.log("\n🔍 Verification");
  console.log("  feeRecipient:", feeNow, feeNow.toLowerCase() === safeAddress.toLowerCase() ? "✅" : "❌");
  console.log("  keeper RELAYER_ROLE:", hasRelayer ? "✅" : "❌");
  console.log("  deployer RELAYER_ROLE:", deployerStillRelayer ? "still set" : "revoked ✅");
  console.log("  keeper ≠ deployer:", keeperWallet.address.toLowerCase() !== deployer.address.toLowerCase() ? "✅" : "❌");

  console.log("\n✨ Done. Restart keeper: cd keeper && npm start");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
