import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { safeExec } from "./lib/safeExec";

/**
 * @notice Redeploy NoctisExchange only (keep existing vault + balances)
 * @dev Vault owner may be a Safe — setExchange is executed via Safe when needed.
 */
async function main() {
  console.log("🔄 Upgrading NoctisExchange (keeping existing vault)...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Account balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH\n"
  );

  const network = await ethers.provider.getNetwork();
  const networkKey =
    network.chainId === 11155111n
      ? "sepolia"
      : network.chainId === 421614n
        ? "arbitrumSepolia"
        : network.chainId === 42161n
          ? "arbitrumOne"
          : `chain-${network.chainId}`;

  console.log("Network:", networkKey);
  console.log("Chain ID:", network.chainId.toString(), "\n");

  const ssotPath = path.join(__dirname, "..", "deployments", `${networkKey}.json`);
  if (!fs.existsSync(ssotPath)) {
    console.error(`❌ Missing SSOT: ${ssotPath}`);
    process.exit(1);
  }
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  const EXISTING_VAULT = ssot.contracts.NoctisVault as string;
  const OLD_EXCHANGE = ssot.contracts.NoctisExchange as string;
  const USDT = ssot.contracts.USDT as string;
  const UNISWAP_V2_ROUTER = ssot.contracts.UniswapV2Router as string;
  const ETH_USD_PRICE_FEED = ssot.contracts.EthUsdPriceFeed as string;
  const SEQUENCER_UPTIME_FEED = ssot.contracts.SequencerUptimeFeed as string;
  const FEE_RECIPIENT =
    (ssot.contracts.feeRecipient as string) ||
    (ssot.ops?.feeRecipientSafe as string) ||
    deployer.address;
  const OWNER_SAFE = (ssot.ops?.ownerSafe as string) || FEE_RECIPIENT;
  const RELAYER = (ssot.ops?.relayer as string) || "";

  console.log("📋 Existing vault:", EXISTING_VAULT);
  console.log("📋 Old exchange:", OLD_EXCHANGE);
  console.log("📋 Safe / feeRecipient:", FEE_RECIPIENT);
  console.log("📋 Relayer:", RELAYER || "(set later)");

  console.log("\n📝 Deploying new NoctisExchange...");
  const NoctisExchangeFactory = await ethers.getContractFactory("NoctisExchange");
  const exchange = await NoctisExchangeFactory.deploy(
    EXISTING_VAULT,
    UNISWAP_V2_ROUTER,
    ETH_USD_PRICE_FEED,
    SEQUENCER_UPTIME_FEED
  );
  await exchange.waitForDeployment();
  const exchangeAddress = await exchange.getAddress();
  const deployTx = exchange.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;
  const startBlock = receipt?.blockNumber ?? 0;
  console.log("✅ New NoctisExchange deployed to:", exchangeAddress);
  console.log("   Deploy block:", startBlock);

  const vault = await ethers.getContractAt("NoctisVault", EXISTING_VAULT);
  const vaultOwner = await vault.owner();
  console.log("\n🔗 Vault owner:", vaultOwner);

  const setExchangeIface = vault.interface;
  const allowData = setExchangeIface.encodeFunctionData("setExchange", [
    exchangeAddress,
    true,
  ]);
  const revokeData = setExchangeIface.encodeFunctionData("setExchange", [
    OLD_EXCHANGE,
    false,
  ]);

  if (vaultOwner.toLowerCase() === deployer.address.toLowerCase()) {
    const allowTx = await vault.connect(deployer).setExchange(exchangeAddress, true);
    await allowTx.wait();
    console.log("✅ Vault setExchange(true) via EOA");
    try {
      const revokeTx = await vault.connect(deployer).setExchange(OLD_EXCHANGE, false);
      await revokeTx.wait();
      console.log("✅ Vault setExchange(false) old exchange via EOA");
    } catch (e: any) {
      console.log("   Note: could not revoke old exchange:", e.shortMessage || e.message);
    }
  } else if (vaultOwner.toLowerCase() === OWNER_SAFE.toLowerCase()) {
    console.log("🔐 Vault owned by Safe — exec setExchange via Safe...");
    const h1 = await safeExec(OWNER_SAFE, deployer, EXISTING_VAULT, allowData);
    console.log("✅ Safe setExchange(true)", h1);
    try {
      const h2 = await safeExec(OWNER_SAFE, deployer, EXISTING_VAULT, revokeData);
      console.log("✅ Safe setExchange(false) old", h2);
    } catch (e: any) {
      console.log("   Note: could not revoke old exchange:", e.shortMessage || e.message);
    }
  } else {
    throw new Error(`Unexpected vault owner ${vaultOwner} — cannot setExchange`);
  }

  // Fee recipient → Safe
  if (FEE_RECIPIENT && FEE_RECIPIENT.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log("\n💰 setFeeRecipient:", FEE_RECIPIENT);
    const feeTx = await exchange.connect(deployer).setFeeRecipient(FEE_RECIPIENT);
    await feeTx.wait();
    console.log("✅ feeRecipient set");
  }

  // Grant RELAYER_ROLE to dedicated keeper
  if (RELAYER) {
    console.log("\n🔑 Grant RELAYER_ROLE:", RELAYER);
    const RELAYER_ROLE = await exchange.RELAYER_ROLE();
    const tx = await exchange.grantRole(RELAYER_ROLE, RELAYER);
    await tx.wait();
    console.log("✅ RELAYER_ROLE granted", tx.hash);
  }

  // Wire existing Timelock before admin leaves deployer (B2)
  const EXISTING_TIMELOCK =
    (ssot.contracts.TimelockController as string) ||
    (ssot.ops?.timelock as string) ||
    "";
  if (EXISTING_TIMELOCK && EXISTING_TIMELOCK !== ethers.ZeroAddress) {
    console.log("\n⏱️  setTimelock:", EXISTING_TIMELOCK);
    const tlTx = await exchange.setTimelock(EXISTING_TIMELOCK);
    await tlTx.wait();
    console.log("✅ Timelock configured", tlTx.hash);
  }

  // Transfer admin roles to Safe (B1 pattern)
  console.log("\n🛡️  Transfer Exchange admin roles → Safe");
  const roles = [
    await exchange.DEFAULT_ADMIN_ROLE(),
    await exchange.PAUSER_ROLE(),
    await exchange.KEEPER_MANAGER_ROLE(),
    await exchange.PARAMS_ROLE(),
  ];
  for (const role of roles) {
    if (!(await exchange.hasRole(role, OWNER_SAFE))) {
      const tx = await exchange.grantRole(role, OWNER_SAFE);
      await tx.wait();
    }
  }
  // Revoke from deployer (DEFAULT_ADMIN last)
  const DEFAULT_ADMIN = await exchange.DEFAULT_ADMIN_ROLE();
  for (const role of roles) {
    if (role === DEFAULT_ADMIN) continue;
    if (await exchange.hasRole(role, deployer.address)) {
      const tx = await exchange.revokeRole(role, deployer.address);
      await tx.wait();
    }
  }
  if (await exchange.hasRole(DEFAULT_ADMIN, deployer.address)) {
    const tx = await exchange.revokeRole(DEFAULT_ADMIN, deployer.address);
    await tx.wait();
    console.log("✅ DEFAULT_ADMIN revoked from deployer");
  }

  const previous = {
    NoctisVault: EXISTING_VAULT,
    NoctisExchange: OLD_EXCHANGE,
    note: "Exchange redeployed with EIP-170 size trim (~22.2kb); vault unchanged",
    ...(ssot.previous ? { older: ssot.previous } : {}),
  };

  const deployment = {
    network: networkKey,
    chainId: Number(network.chainId),
    updatedAt: new Date().toISOString().slice(0, 10),
    contracts: {
      NoctisVault: EXISTING_VAULT,
      NoctisExchange: exchangeAddress,
      USDT,
      UniswapV2Router: UNISWAP_V2_ROUTER,
      EthUsdPriceFeed: ETH_USD_PRICE_FEED,
      SequencerUptimeFeed: SEQUENCER_UPTIME_FEED,
      feeRecipient: FEE_RECIPIENT,
      feeBps: ssot.contracts.feeBps ?? 5,
      ...(EXISTING_TIMELOCK
        ? { TimelockController: EXISTING_TIMELOCK }
        : {}),
    },
    subgraph: {
      ...(ssot.subgraph || {}),
      exchangeStartBlock: startBlock,
      vaultStartBlock: ssot.subgraph?.vaultStartBlock ?? startBlock,
    },
    previous,
    ops: {
      ...(ssot.ops || {}),
      ownerSafe: OWNER_SAFE,
      feeRecipientSafe: FEE_RECIPIENT,
      relayer: RELAYER || ssot.ops?.relayer,
      deployerAdmin: deployer.address,
      timelock: EXISTING_TIMELOCK || ssot.ops?.timelock,
      note: "Exchange BUY floor = min(oracle, Uniswap). Admin = Safe. Relayer keystore unchanged.",
      upgradedAt: new Date().toISOString(),
    },
    notes:
      "SSOT. Exchange BUY thin-pool floor fix. Sync frontend/.env.local, keeper/.env, subgraph.",
  };

  fs.writeFileSync(ssotPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\n📄 SSOT written: ${ssotPath}`);

  console.log("\n" + "=".repeat(60));
  console.log("📋 UPGRADE SUMMARY");
  console.log("=".repeat(60));
  console.log(`Network:              ${networkKey} (${network.chainId})`);
  console.log(`Vault (unchanged):    ${EXISTING_VAULT}`);
  console.log(`OLD Exchange:         ${OLD_EXCHANGE}`);
  console.log(`NEW Exchange:         ${exchangeAddress}`);
  console.log(`Deploy block:         ${startBlock}`);
  console.log("=".repeat(60));
  console.log("\n✨ Exchange upgrade complete!\n");

  return { exchangeAddress, exchange, startBlock };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
