/**
 * @notice Sepolia pause drill: pause → confirm whenNotPaused reverts → unpause
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const ssotPath = path.join(__dirname, "..", "deployments", "sepolia.json");
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  const [deployer] = await ethers.getSigners();
  const exchange = await ethers.getContractAt("NoctisExchange", ssot.contracts.NoctisExchange);

  const PAUSER = await exchange.PAUSER_ROLE();
  console.log("deployer", deployer.address);
  console.log("PAUSER_ROLE", await exchange.hasRole(PAUSER, deployer.address));
  console.log("paused before", await exchange.paused());

  const pauseTx = await exchange.pause();
  await pauseTx.wait();
  console.log("pause", pauseTx.hash, "paused=", await exchange.paused());

  let enforcedPause = false;
  try {
    await exchange.requestSwapExecution.staticCall(999999n);
  } catch (e: any) {
    const raw = `${e.data || ""} ${e.shortMessage || ""} ${e.message || ""}`;
    enforcedPause = raw.includes("0xd93c0665") || /EnforcedPause|paused/i.test(raw);
    console.log("requestSwapExecution while paused →", (e.shortMessage || e.message || "").slice(0, 180));
  }

  if (!enforcedPause) {
    try {
      await exchange.cancelOrder.staticCall(999999n);
    } catch (e: any) {
      const raw = `${e.data || ""} ${e.shortMessage || ""} ${e.message || ""}`;
      enforcedPause = raw.includes("0xd93c0665") || /EnforcedPause|paused/i.test(raw);
      console.log("cancelOrder while paused →", (e.shortMessage || e.message || "").slice(0, 180));
    }
  }

  console.log("EnforcedPause observed?", enforcedPause);

  const unpauseTx = await exchange.unpause();
  await unpauseTx.wait();
  console.log("unpause", unpauseTx.hash, "paused=", await exchange.paused());

  if (await exchange.paused()) throw new Error("Exchange still paused after drill");
  if (!enforcedPause) throw new Error("Expected EnforcedPause while paused — drill incomplete");

  // record in SSOT ops
  ssot.ops = {
    ...(ssot.ops || {}),
    lastPauseDrillAt: new Date().toISOString(),
    lastPauseDrillPauseTx: pauseTx.hash,
    lastPauseDrillUnpauseTx: unpauseTx.hash,
  };
  fs.writeFileSync(ssotPath, JSON.stringify(ssot, null, 2) + "\n");
  console.log("PAUSE DRILL OK");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
