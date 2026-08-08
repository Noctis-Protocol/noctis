/**
 * TIME HELPERS
 * 
 * Helper functions for time manipulation in tests.
 * Simplifies common patterns like skipping timelock delays.
 * 
 * @see TEST_REFACTORING_GUIDE.md for usage examples
 */

import { ethers } from "hardhat";
import { TEST_CONSTANTS } from "../constants";

/**
 * Increase the EVM time by the specified number of seconds
 * 
 * @param seconds - Number of seconds to advance
 * 
 * @example
 * await increaseTime(3600); // Advance 1 hour
 */
export async function increaseTime(seconds: number): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

/**
 * Skip the keeper delay (48 hours + 1 second)
 * 
 * @example
 * const tx = await vault.proposeAddKeeperV2(keeperAddress);
 * const proposalId = (await vault.keeperProposalCounter()) - 1n;
 * await skipKeeperDelay();
 * await vault.executeKeeperChangeV2(proposalId);
 */
export async function skipKeeperDelay(): Promise<void> {
  await increaseTime(TEST_CONSTANTS.TIMELOCK.SKIP_KEEPER);
}

/**
 * Skip the Gateway delay (7 days + 1 second)
 * 
 * @example
 * await vault.proposeGateway(gatewayAddress);
 * await skipGatewayDelay();
 * await vault.executeGatewayChange();
 */
export async function skipGatewayDelay(): Promise<void> {
  await increaseTime(TEST_CONSTANTS.TIMELOCK.SKIP_GATEWAY);
}

/**
 * Skip the withdrawal timeout (24 hours + 1 second)
 * 
 * @example
 * await vault.requestEncryptedWithdrawal(...);
 * await skipWithdrawalTimeout();
 * await vault.cancelWithdrawalRequest(requestId);
 */
export async function skipWithdrawalTimeout(): Promise<void> {
  await increaseTime(TEST_CONSTANTS.TIMELOCK.SKIP_WITHDRAWAL);
}

/**
 * Skip the Guardian delay (72 hours + 1 second)
 * 
 * @example
 * await vault.proposeGuardian(guardianAddress);
 * await skipGuardianDelay();
 * await vault.executeGuardianChange();
 */
export async function skipGuardianDelay(): Promise<void> {
  await increaseTime(TEST_CONSTANTS.TIMELOCK.SKIP_GUARDIAN);
}

/**
 * Get the current block timestamp
 * 
 * @returns Current block timestamp
 */
export async function getCurrentTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return block!.timestamp;
}

/**
 * Mine a specific number of blocks
 * 
 * @param blocks - Number of blocks to mine
 * 
 * @example
 * await mineBlocks(100); // Mine 100 blocks
 */
export async function mineBlocks(blocks: number): Promise<void> {
  for (let i = 0; i < blocks; i++) {
    await ethers.provider.send("evm_mine", []);
  }
}

/**
 * Set the next block timestamp
 * 
 * @param timestamp - Unix timestamp for next block
 * 
 * @example
 * await setNextBlockTimestamp(Date.now() / 1000 + 3600); // 1 hour from now
 */
export async function setNextBlockTimestamp(timestamp: number): Promise<void> {
  await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  await ethers.provider.send("evm_mine", []);
}

/**
 * Fast forward to a specific timestamp
 * 
 * @param timestamp - Target timestamp
 * 
 * @example
 * const futureTime = (await getCurrentTimestamp()) + 3600;
 * await fastForwardTo(futureTime);
 */
export async function fastForwardTo(timestamp: number): Promise<void> {
  const currentTime = await getCurrentTimestamp();
  if (timestamp > currentTime) {
    await increaseTime(timestamp - currentTime);
  }
}

/**
 * Take a snapshot of the current blockchain state
 * Returns a snapshot ID that can be used to revert
 * 
 * @returns Snapshot ID
 * 
 * @example
 * const snapshot = await takeSnapshot();
 * // ... do some tests ...
 * await revertToSnapshot(snapshot);
 */
export async function takeSnapshot(): Promise<string> {
  return await ethers.provider.send("evm_snapshot", []);
}

/**
 * Revert to a previous snapshot
 * 
 * @param snapshotId - Snapshot ID to revert to
 */
export async function revertToSnapshot(snapshotId: string): Promise<void> {
  await ethers.provider.send("evm_revert", [snapshotId]);
}
