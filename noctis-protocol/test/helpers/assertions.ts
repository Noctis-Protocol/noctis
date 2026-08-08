/**
 * CUSTOM ASSERTIONS
 * 
 * Custom assertion helpers for common test patterns.
 * Improves test readability and error messages.
 */

import { expect } from "chai";
import { Contract } from "ethers";
import { isApproximately } from "../constants";

/**
 * Assert that gas used is within expected range
 * 
 * @param receipt - Transaction receipt
 * @param maxGas - Maximum allowed gas
 * @param tolerance - Tolerance percentage (default 10%)
 * 
 * @example
 * await expectGasWithinLimit(receipt, 150000n);
 */
export async function expectGasWithinLimit(
  receipt: any,
  maxGas: bigint,
  tolerance: number = 10
) {
  const gasUsed = receipt?.gasUsed;
  expect(gasUsed).to.exist;
  
  const maxWithTolerance = maxGas + (maxGas * BigInt(tolerance)) / 100n;
  
  expect(
    gasUsed,
    `Gas used (${gasUsed}) exceeds limit (${maxWithTolerance})`
  ).to.be.lessThanOrEqual(maxWithTolerance);
}

/**
 * Assert that two BigInt values are approximately equal
 * 
 * @param actual - Actual value
 * @param expected - Expected value
 * @param tolerancePercent - Tolerance percentage (default 1%)
 * 
 * @example
 * expectApproximately(actualBalance, expectedBalance, 0.5); // 0.5% tolerance
 */
export function expectApproximately(
  actual: bigint,
  expected: bigint,
  tolerancePercent: number = 1
) {
  expect(
    isApproximately(actual, expected, tolerancePercent),
    `Expected ${actual} to be approximately ${expected} (±${tolerancePercent}%)`
  ).to.be.true;
}

/**
 * Assert that a contract has correct balance
 * 
 * @param contract - Contract to check
 * @param expectedBalance - Expected balance
 * 
 * @example
 * await expectContractBalance(vault, TEST_CONSTANTS.ETH.DEPOSIT_MEDIUM);
 */
export async function expectContractBalance(
  contract: Contract,
  expectedBalance: bigint
) {
  const actualBalance = await contract.runner!.provider!.getBalance(
    await contract.getAddress()
  );
  
  expect(actualBalance).to.equal(expectedBalance);
}

/**
 * Assert that an event was emitted with correct args
 * 
 * @param tx - Transaction
 * @param contract - Contract that emits the event
 * @param eventName - Event name
 * @param args - Expected event arguments
 * 
 * @example
 * await expectEvent(tx, vault, "ETHDeposited", [user.address]);
 */
export async function expectEvent(
  tx: any,
  contract: Contract,
  eventName: string,
  args: any[]
) {
  await expect(tx)
    .to.emit(contract, eventName)
    .withArgs(...args);
}

/**
 * Assert that a transaction reverts with a specific custom error
 * 
 * @param promise - Transaction promise
 * @param contract - Contract with the error
 * @param errorName - Error name
 * 
 * @example
 * await expectCustomError(
 *   vault.depositETH({ value: 0 }),
 *   vault,
 *   "InvalidAmount"
 * );
 */
export async function expectCustomError(
  promise: Promise<any>,
  contract: Contract,
  errorName: string
) {
  await expect(promise).to.be.revertedWithCustomError(contract, errorName);
}
