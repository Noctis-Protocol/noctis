import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Wire the existing TimelockController (Safe proposer/executor, 300s min delay)
 * to NoctisExchangeV2, and verify the vault<->exchange authorization.
 * Deployer keeps PARAMS/ADMIN during the pilot; Safe handover is a post-pilot step.
 */
const TIMELOCK = "0x6fa358E424341F60338620f26AB297553E551A7D";

async function main() {
  const ssotPath = path.join(__dirname, "../deployments/sepolia.v2.json");
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  const c = ssot.contracts;

  const vault = await ethers.getContractAt("NoctisVaultV2", c.NoctisVaultV2);
  const exchange = await ethers.getContractAt("NoctisExchangeV2", c.NoctisExchangeV2);

  if (await exchange.timelockConfigured()) {
    console.log("Timelock already configured:", await exchange.timelock());
  } else {
    const tx = await exchange.setTimelock(TIMELOCK);
    await tx.wait();
    console.log("Timelock set on ExchangeV2:", TIMELOCK, "tx:", tx.hash);
    ssot.ops = ssot.ops ?? {};
    ssot.ops.timelock = TIMELOCK;
    ssot.ops.timelockConfiguredAt = new Date().toISOString();
    fs.writeFileSync(ssotPath, JSON.stringify(ssot, null, 2) + "\n");
  }

  // Sanity: exchange must be authorized on the vault for deduct/credit
  const authorized = await vault.authorizedExchanges(c.NoctisExchangeV2);
  console.log("vault.authorizedExchanges(exchange):", authorized);
  if (!authorized) {
    const tx = await vault.authorizeExchange(c.NoctisExchangeV2, true);
    await tx.wait();
    console.log("Exchange authorized on vault, tx:", tx.hash);
  }

  // Print NATIVE trade config for the smoke test
  const cfg = await exchange.tradeConfigs(ethers.ZeroAddress);
  console.log("NATIVE trade config:", cfg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
