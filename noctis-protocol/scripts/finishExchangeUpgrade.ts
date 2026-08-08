import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * @notice Finish a partially-applied Exchange upgrade.
 * @dev upgradeExchange.ts deploys the new Exchange and (via Safe) points the vault
 *      at it, but the FHEVM hardhat plugin's gas-estimation hook can abort the
 *      subsequent admin calls on a live network. This script completes ONLY the
 *      remaining, deployer-admin steps on an already-deployed Exchange and rewrites
 *      the SSOT. Run with SKIP_FHEVM=1 so the plugin provider extender is not loaded.
 *
 * Env:
 *   NEW_EXCHANGE   (required) address of the freshly deployed Exchange
 *   START_BLOCK    (optional) deploy block for subgraph startBlock
 */
async function main() {
  const NEW_EXCHANGE = process.env.NEW_EXCHANGE;
  if (!NEW_EXCHANGE) throw new Error("Set NEW_EXCHANGE=<address>");
  const startBlock = Number(process.env.START_BLOCK || "0");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const networkKey = network.chainId === 11155111n ? "sepolia" : `chain-${network.chainId}`;

  const ssotPath = path.join(__dirname, "..", "deployments", `${networkKey}.json`);
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));

  const EXISTING_VAULT = ssot.contracts.NoctisVault as string;
  const OLD_EXCHANGE = ssot.contracts.NoctisExchange as string;
  const USDT = ssot.contracts.USDT as string;
  const UNISWAP_V2_ROUTER = ssot.contracts.UniswapV2Router as string;
  const ETH_USD_PRICE_FEED = ssot.contracts.EthUsdPriceFeed as string;
  const SEQUENCER_UPTIME_FEED = ssot.contracts.SequencerUptimeFeed as string;
  const FEE_RECIPIENT =
    (ssot.ops?.feeRecipientSafe as string) || (ssot.contracts.feeRecipient as string);
  const OWNER_SAFE = (ssot.ops?.ownerSafe as string) || FEE_RECIPIENT;
  const RELAYER = (ssot.ops?.relayer as string) || "";
  const EXISTING_TIMELOCK =
    (ssot.contracts.TimelockController as string) || (ssot.ops?.timelock as string) || "";

  console.log("Deployer:", deployer.address);
  console.log("New exchange:", NEW_EXCHANGE);
  console.log("Owner Safe:", OWNER_SAFE);

  const exchange = await ethers.getContractAt("NoctisExchange", NEW_EXCHANGE);

  // M-2: setFeeRecipient is onlyTimelockOrRole(PARAMS_ROLE). While timelock is NOT
  // yet configured, a PARAMS_ROLE holder may call it. The constructor grants the
  // deployer only DEFAULT_ADMIN + PAUSER, so self-grant PARAMS_ROLE first (revoked
  // again by the role-transfer loop below). All PARAMS-gated config MUST run before
  // setTimelock, after which only the timelock can change these params.
  const PARAMS_ROLE = await exchange.PARAMS_ROLE();
  if (!(await exchange.hasRole(PARAMS_ROLE, deployer.address))) {
    const tx = await exchange.grantRole(PARAMS_ROLE, deployer.address);
    await tx.wait();
    console.log("✅ PARAMS_ROLE self-granted (temporary)", tx.hash);
  }

  // Fee recipient → Safe
  if (FEE_RECIPIENT && FEE_RECIPIENT.toLowerCase() !== deployer.address.toLowerCase()) {
    const cur = await exchange.feeRecipient();
    if (cur.toLowerCase() !== FEE_RECIPIENT.toLowerCase()) {
      const tx = await exchange.connect(deployer).setFeeRecipient(FEE_RECIPIENT);
      await tx.wait();
      console.log("✅ feeRecipient set", tx.hash);
    } else console.log("• feeRecipient already set");
  }

  // Grant RELAYER_ROLE
  if (RELAYER) {
    const RELAYER_ROLE = await exchange.RELAYER_ROLE();
    if (!(await exchange.hasRole(RELAYER_ROLE, RELAYER))) {
      const tx = await exchange.grantRole(RELAYER_ROLE, RELAYER);
      await tx.wait();
      console.log("✅ RELAYER_ROLE granted", tx.hash);
    } else console.log("• RELAYER_ROLE already granted");
  }

  // Wire Timelock before admin leaves deployer
  if (EXISTING_TIMELOCK && EXISTING_TIMELOCK !== ethers.ZeroAddress) {
    const curTl = await exchange.timelock();
    if (curTl.toLowerCase() !== EXISTING_TIMELOCK.toLowerCase()) {
      const tx = await exchange.setTimelock(EXISTING_TIMELOCK);
      await tx.wait();
      console.log("✅ Timelock set", tx.hash);
    } else console.log("• Timelock already set");
  }

  // Transfer admin roles → Safe
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
  console.log("✅ Roles granted to Safe");

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

  // Rewrite SSOT (preserve history)
  const previous = {
    NoctisVault: EXISTING_VAULT,
    NoctisExchange: OLD_EXCHANGE,
    note: "Exchange redeployed (C-1/M-2/S-1 audit fixes; EIP-170 size trim to 23.1kb); vault unchanged",
    ...(ssot.previous ? { older: ssot.previous } : {}),
  };
  const deployment = {
    network: networkKey,
    chainId: Number(network.chainId),
    updatedAt: new Date().toISOString().slice(0, 10),
    contracts: {
      NoctisVault: EXISTING_VAULT,
      NoctisExchange: NEW_EXCHANGE,
      USDT,
      UniswapV2Router: UNISWAP_V2_ROUTER,
      EthUsdPriceFeed: ETH_USD_PRICE_FEED,
      SequencerUptimeFeed: SEQUENCER_UPTIME_FEED,
      feeRecipient: FEE_RECIPIENT,
      feeBps: ssot.contracts.feeBps ?? 5,
      ...(EXISTING_TIMELOCK ? { TimelockController: EXISTING_TIMELOCK } : {}),
    },
    subgraph: {
      ...(ssot.subgraph || {}),
      exchangeStartBlock: startBlock || ssot.subgraph?.exchangeStartBlock,
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
      note: "Exchange redeployed with C-1/M-2/S-1 audit fixes. Admin = Safe.",
      upgradedAt: new Date().toISOString(),
    },
    notes: "SSOT. Sync frontend/.env.local, keeper/.env, subgraph from this file.",
  };
  fs.writeFileSync(ssotPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log("\n📄 SSOT updated:", ssotPath);
  console.log("OLD:", OLD_EXCHANGE, "\nNEW:", NEW_EXCHANGE, "\nstartBlock:", startBlock);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
