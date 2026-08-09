/**
 * PRIVACY (phase B): enable the withdrawal batching window on NoctisVaultV2.
 * Claims are quantized to window boundaries so several users' payouts land
 * together, breaking the 1:1 fill->payout timing correlation.
 *
 *   WINDOW_SECONDS=300 npx hardhat run scripts/setWithdrawalBatchWindow.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const window = BigInt(process.env.WINDOW_SECONDS || "300");
  const ssotPath = path.join(__dirname, "../deployments/sepolia.v2.json");
  const ssot = JSON.parse(fs.readFileSync(ssotPath, "utf8"));
  const vault = await ethers.getContractAt("NoctisVaultV2", ssot.contracts.NoctisVaultV2);

  const current: bigint = await vault.withdrawalBatchWindow();
  if (current === window) {
    console.log(`withdrawalBatchWindow already ${window}s`);
    return;
  }
  const tx = await vault.setWithdrawalBatchWindow(window);
  await tx.wait();
  console.log(`withdrawalBatchWindow set to ${window}s, tx: ${tx.hash}`);

  ssot.ops = ssot.ops ?? {};
  ssot.ops.withdrawalBatchWindowSeconds = Number(window);
  fs.writeFileSync(ssotPath, JSON.stringify(ssot, null, 2) + "\n");
  console.log("SSOT updated");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
