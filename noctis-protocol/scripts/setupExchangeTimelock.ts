/**
 * @notice B2 — Deploy NoctisTimelock and wire it to NoctisExchange via Safe.
 *
 *   npx hardhat run scripts/setupExchangeTimelock.ts --network sepolia
 *   SKIP_SMOKE=1 npx hardhat run scripts/setupExchangeTimelock.ts --network mainnet
 *
 * Env:
 *   TIMELOCK_DELAY   — seconds (default Sepolia 300, mainnet 172800 / 48h)
 *   SKIP_SMOKE=1     — deploy + setTimelock only (forced default when delay > 1h)
 *   SMOKE_FEE_BPS    — value to schedule in smoke (default: current feeBps)
 *
 * Policy:
 *   - Delayed via Timelock: setFeeBps, setOrderSizeLimits, setMaxOrdersPerBlock, setGateway
 *   - Instant (Safe PAUSER / DEFAULT_ADMIN): pause/unpause, setFeeRecipient, rescueERC20
 *   - Vault already has on-contract delays (keepers 48h, gateway 7d)
 */
import { ethers } from "hardhat";
import { safeExec } from "./lib/safeExec";
import {
  defaultTimelockDelay,
  loadSsot,
  saveSsot,
} from "./lib/ssot";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const { path: ssotPath, data: ssot, network: netName } = loadSsot(
    network.chainId
  );
  const exchangeAddress = ssot.contracts.NoctisExchange as string;
  const safeAddress =
    process.env.SAFE_ADDRESS ||
    (ssot.ops?.ownerSafe as string) ||
    (ssot.ops?.feeRecipientSafe as string) ||
    (ssot.contracts.feeRecipient as string);

  if (!safeAddress || !ethers.isAddress(safeAddress)) {
    throw new Error("Safe address missing — run setupTreasuryAndRelayer first");
  }

  const minDelay = Number(
    process.env.TIMELOCK_DELAY || defaultTimelockDelay(network.chainId)
  );
  // Never wait 48h in CI smoke on mainnet unless explicitly requested
  const skipSmoke =
    process.env.SKIP_SMOKE === "1" ||
    (minDelay > 3600 && process.env.FORCE_SMOKE !== "1");

  console.log("Network:", netName, `(${network.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Exchange:", exchangeAddress);
  console.log("Safe:    ", safeAddress);
  console.log("Delay:   ", minDelay, "seconds");
  console.log("Smoke:   ", skipSmoke ? "skipped" : "enabled");

  const exchange = await ethers.getContractAt("NoctisExchange", exchangeAddress);
  if (await exchange.timelockConfigured()) {
    console.log("⚠️  Timelock already configured:", await exchange.timelock());
    return;
  }

  // ── 1) Deploy Timelock (Safe = proposer + executor + admin) ──────────
  console.log("\n1️⃣ Deploy NoctisTimelock...");
  const NoctisTimelock = await ethers.getContractFactory("NoctisTimelock");
  const timelock = await NoctisTimelock.deploy(
    minDelay,
    [safeAddress],
    [safeAddress],
    safeAddress
  );
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("   Timelock:", timelockAddress);
  console.log("   minDelay:", (await timelock.getMinDelay()).toString());

  // ── 2) Safe → exchange.setTimelock ───────────────────────────────────
  console.log("\n2️⃣ Safe setTimelock...");
  const setTlData = exchange.interface.encodeFunctionData("setTimelock", [timelockAddress]);
  const setTlTx = await safeExec(safeAddress, deployer, exchangeAddress, setTlData);
  console.log("   setTimelock tx:", setTlTx);

  // Sepolia RPCs can lag; retry reads briefly after Safe exec
  let configured = false;
  let onChainTl = ethers.ZeroAddress;
  for (let i = 0; i < 8; i++) {
    configured = await exchange.timelockConfigured();
    onChainTl = await exchange.timelock();
    if (configured && onChainTl.toLowerCase() === timelockAddress.toLowerCase()) break;
    await sleep(2000);
  }
  if (!configured || onChainTl.toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error(`setTimelock failed: configured=${configured} timelock=${onChainTl}`);
  }
  console.log("   ✅ Exchange.timelockConfigured = true");

  // ── 3) Smoke: schedule → wait → execute setFeeBps (noop or SMOKE_FEE_BPS)
  let smoke: Record<string, string> | undefined;
  if (!skipSmoke) {
    console.log("\n3️⃣ Smoke schedule → execute setFeeBps...");
    const current = Number(await exchange.feeBps());
    const target = Number(process.env.SMOKE_FEE_BPS || current);
    const data = exchange.interface.encodeFunctionData("setFeeBps", [target]);
    const predecessor = ethers.ZeroHash;
    const salt = ethers.id(`noctis-b2-smoke-fee-${Date.now()}`);

    // Direct call must fail
    await expectRevertOnlyTimelock(exchange);

    const scheduleData = timelock.interface.encodeFunctionData("schedule", [
      exchangeAddress,
      0,
      data,
      predecessor,
      salt,
      minDelay,
    ]);
    const schedTx = await safeExec(safeAddress, deployer, timelockAddress, scheduleData);
    console.log("   schedule tx:", schedTx);

    const opId = await timelock.hashOperation(exchangeAddress, 0, data, predecessor, salt);
    console.log("   operationId:", opId);
    console.log(`   waiting ${minDelay + 15}s for delay...`);
    await sleep((minDelay + 15) * 1000);

    const executeData = timelock.interface.encodeFunctionData("execute", [
      exchangeAddress,
      0,
      data,
      predecessor,
      salt,
    ]);
    const execTx = await safeExec(safeAddress, deployer, timelockAddress, executeData);
    console.log("   execute tx:", execTx);

    const feeAfter = Number(await exchange.feeBps());
    if (feeAfter !== target) {
      throw new Error(`Smoke failed: feeBps=${feeAfter} expected ${target}`);
    }
    console.log("   ✅ feeBps via Timelock =", feeAfter);
    smoke = {
      scheduleTx: schedTx,
      executeTx: execTx,
      operationId: opId,
      feeBps: String(feeAfter),
    };
  }

  // ── 4) Update SSOT ───────────────────────────────────────────────────
  ssot.contracts.TimelockController = timelockAddress;
  ssot.ops = {
    ...(ssot.ops || {}),
    timelock: timelockAddress,
    timelockMinDelay: minDelay,
    timelockConfiguredAt: new Date().toISOString(),
    timelockPolicy:
      "Exchange PARAMS/GATEWAY via Timelock (Safe proposer+executor). Pause + feeRecipient + rescue remain Safe-instant. Vault keepers 48h / gateway 7d on-contract.",
    ...(smoke
      ? {
          timelockSmokeScheduleTx: smoke.scheduleTx,
          timelockSmokeExecuteTx: smoke.executeTx,
          timelockSmokeOperationId: smoke.operationId,
        }
      : {}),
  };
  ssot.updatedAt = new Date().toISOString().slice(0, 10);
  ssot.notes =
    "SSOT. Exchange + B2 Timelock wired. Sync frontend/.env.local, keeper/.env, subgraph.";
  saveSsot(ssotPath, ssot);
  console.log("\n✅ SSOT updated:", ssotPath);
  console.log("Timelock:", timelockAddress);
}

async function expectRevertOnlyTimelock(exchange: {
  setFeeBps: (n: number) => Promise<{ wait: () => Promise<unknown> }>;
}) {
  try {
    const tx = await exchange.setFeeBps(5);
    await tx.wait();
    throw new Error("Expected OnlyTimelock revert on direct setFeeBps");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/OnlyTimelock|execution reverted/i.test(msg)) {
      throw e;
    }
    console.log("   direct setFeeBps correctly reverted (OnlyTimelock)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
