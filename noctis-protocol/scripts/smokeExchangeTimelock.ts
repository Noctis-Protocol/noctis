/**
 * @notice B2 smoke: Safe schedule → wait → execute setFeeBps via existing Timelock.
 * Env: TIMELOCK_DELAY (default 300), SMOKE_FEE_BPS (default current)
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { safeExec } from "./lib/safeExec";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const ssotPath = path.join(__dirname, "..", "deployments", "sepolia.json");
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  const exchangeAddress = ssot.contracts.NoctisExchange as string;
  const safeAddress =
    (ssot.ops?.ownerSafe as string) || (ssot.contracts.feeRecipient as string);

  const exchange = await ethers.getContractAt("NoctisExchange", exchangeAddress);
  const timelockAddress = (await exchange.timelock()) as string;
  if (!(await exchange.timelockConfigured()) || timelockAddress === ethers.ZeroAddress) {
    throw new Error("Timelock not configured on Exchange");
  }
  const timelock = await ethers.getContractAt("NoctisTimelock", timelockAddress);
  const minDelay = Number(await timelock.getMinDelay());

  console.log("Exchange:", exchangeAddress);
  console.log("Timelock:", timelockAddress);
  console.log("Safe:    ", safeAddress);
  console.log("Delay:   ", minDelay);

  // Direct call must fail
  try {
    await (await exchange.setFeeBps(5)).wait();
    throw new Error("Expected OnlyTimelock");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/OnlyTimelock|execution reverted/i.test(msg)) throw e;
    console.log("✅ direct setFeeBps reverted");
  }

  const current = Number(await exchange.feeBps());
  const target = Number(process.env.SMOKE_FEE_BPS || current);
  const data = exchange.interface.encodeFunctionData("setFeeBps", [target]);
  const predecessor = ethers.ZeroHash;
  const salt = ethers.id(`noctis-b2-smoke-fee-${Date.now()}`);

  const scheduleData = timelock.interface.encodeFunctionData("schedule", [
    exchangeAddress,
    0,
    data,
    predecessor,
    salt,
    minDelay,
  ]);
  const schedTx = await safeExec(safeAddress, deployer, timelockAddress, scheduleData);
  console.log("schedule:", schedTx);

  const opId = await timelock.hashOperation(exchangeAddress, 0, data, predecessor, salt);
  console.log("operationId:", opId);
  console.log(`waiting ${minDelay + 20}s...`);
  await sleep((minDelay + 20) * 1000);

  const executeData = timelock.interface.encodeFunctionData("execute", [
    exchangeAddress,
    0,
    data,
    predecessor,
    salt,
  ]);
  const execTx = await safeExec(safeAddress, deployer, timelockAddress, executeData);
  console.log("execute:", execTx);

  const feeAfter = Number(await exchange.feeBps());
  if (feeAfter !== target) throw new Error(`feeBps=${feeAfter} expected ${target}`);
  console.log("✅ feeBps via Timelock =", feeAfter);

  ssot.contracts.TimelockController = timelockAddress;
  ssot.ops = {
    ...(ssot.ops || {}),
    timelock: timelockAddress,
    timelockMinDelay: minDelay,
    timelockConfiguredAt: ssot.ops?.timelockConfiguredAt || new Date().toISOString(),
    timelockPolicy:
      "Exchange PARAMS/GATEWAY via Timelock (Safe proposer+executor). Pause + feeRecipient + rescue remain Safe-instant. Vault keepers 48h / gateway 7d on-contract.",
    timelockSmokeScheduleTx: schedTx,
    timelockSmokeExecuteTx: execTx,
    timelockSmokeOperationId: opId,
  };
  ssot.updatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(ssotPath, JSON.stringify(ssot, null, 2) + "\n");
  console.log("SSOT updated");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
