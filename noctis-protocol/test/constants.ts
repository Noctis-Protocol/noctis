/**
 * TEST CONSTANTS
 * 
 * Centralized test constants to avoid magic numbers and ensure consistency
 * across all test files.
 * 
 * @see TEST_REFACTORING_GUIDE.md for usage examples
 */

import { ethers } from "hardhat";

export const TEST_CONSTANTS = {
  /**
   * ETH Test Amounts
   */
  ETH: {
    DEPOSIT_TINY: ethers.parseEther("0.005"),      // 0.005 ETH - Minimum deposit
    DEPOSIT_SMALL: ethers.parseEther("0.1"),       // 0.1 ETH (~$200)
    DEPOSIT_MEDIUM: ethers.parseEther("1.0"),      // 1 ETH (~$2,000)
    DEPOSIT_LARGE: ethers.parseEther("10.0"),      // 10 ETH (~$20,000)
    DEPOSIT_HUGE: ethers.parseEther("100.0"),      // 100 ETH (~$200,000) - Maximum
    
    WITHDRAWAL_SMALL: ethers.parseEther("0.5"),    // 0.5 ETH
    WITHDRAWAL_MEDIUM: ethers.parseEther("2.0"),   // 2 ETH
    
    MAX_WITHDRAWAL: ethers.parseEther("100.0"),    // 100 ETH (contract limit)
    MIN_DEPOSIT: ethers.parseEther("0.005"),       // 0.005 ETH (minimum per contract)
  },

  /**
   * USDT Test Amounts
   */
  USDT: {
    DECIMALS: 6,
    
    DEPOSIT_SMALL: ethers.parseUnits("100", 6),    // $100
    DEPOSIT_MEDIUM: ethers.parseUnits("1000", 6),  // $1,000
    DEPOSIT_LARGE: ethers.parseUnits("10000", 6),  // $10,000
    DEPOSIT_HUGE: ethers.parseUnits("100000", 6),  // $100,000
    
    WITHDRAWAL_SMALL: ethers.parseUnits("500", 6), // $500
    WITHDRAWAL_MEDIUM: ethers.parseUnits("2000", 6), // $2,000
    
    MAX_WITHDRAWAL: ethers.parseUnits("1000000", 6), // 1M USDT (contract limit)
    MIN_DEPOSIT: ethers.parseUnits("10", 6),       // $10 (minimum per contract)
    
    MINT_AMOUNT: ethers.parseUnits("1000000", 6),  // $1M for testing
  },

  /**
   * Timelock Durations (in seconds)
   */
  TIMELOCK: {
    KEEPER_DELAY: 48 * 60 * 60,                    // 48 hours
    GATEWAY_DELAY: 7 * 24 * 60 * 60,               // 7 days
    WITHDRAWAL_TIMEOUT: 24 * 60 * 60,              // 24 hours
    GUARDIAN_DELAY: 72 * 60 * 60,                  // 72 hours
    
    // Convenience values for skipping delays
    SKIP_KEEPER: 48 * 60 * 60 + 1,
    SKIP_GATEWAY: 7 * 24 * 60 * 60 + 1,
    SKIP_WITHDRAWAL: 24 * 60 * 60 + 1,
    SKIP_GUARDIAN: 72 * 60 * 60 + 1,
  },

  /**
   * Rate Limiting
   */
  RATE_LIMIT: {
    MAX_PENDING_WITHDRAWALS: 5,
    DEPOSIT_COOLDOWN: 60,                          // 1 minute
    WITHDRAWAL_COOLDOWN: 300,                      // 5 minutes
  },

  /**
   * Oracle & Price Feed
   */
  ORACLE: {
    STALE_THRESHOLD: 3600,                         // 1 hour
    GRACE_PERIOD: 3600,                            // 1 hour
    MIN_ETH_PRICE: ethers.parseUnits("500", 8),    // $500 (8 decimals Chainlink)
    MAX_ETH_PRICE: ethers.parseUnits("10000", 8),  // $10,000
    NORMAL_ETH_PRICE: ethers.parseUnits("2000", 8), // $2,000 (default)
  },

  /**
   * Fee-on-Transfer Protection
   */
  FEES: {
    MAX_TRANSFER_FEE: 100,                         // 1% (100 basis points)
    EXCESSIVE_FEE: 150,                            // 1.5% (should be rejected)
  },

  /**
   * Gas Limits & Thresholds
   */
  GAS: {
    DEPOSIT_ETH_MAX: 150000n,                      // ~150k gas
    DEPOSIT_USDT_MAX: 200000n,                     // ~200k gas
    WITHDRAWAL_REQUEST_MAX: 500000n,               // ~500k gas (FHE operations)
    ORDER_CREATE_MAX: 650000n,                     // ~650k gas (FHE + oracle)
  },

  /**
   * Exchange & Orders
   */
  EXCHANGE: {
    MIN_ORDER_SIZE_ETH: ethers.parseEther("0.001"), // 0.001 ETH
    MIN_ORDER_SIZE_USDT: ethers.parseUnits("10", 6), // $10
    
    SLIPPAGE_TOLERANCE: 50,                        // 0.5% (50 basis points)
    MAX_SLIPPAGE: 500,                             // 5% (500 basis points)
  },

  /**
   * Test Accounts Initial Balances
   */
  INITIAL_BALANCE: {
    ETH: ethers.parseEther("1000.0"),              // 1000 ETH for testing
    USDT: ethers.parseUnits("1000000", 6),         // $1M USDT for testing
  },

  /**
   * Addresses for Testing
   */
  ADDRESSES: {
    ZERO: ethers.ZeroAddress,
    DEAD: "0x000000000000000000000000000000000000dEaD",
  },

  /**
   * EIP-712 Domain
   */
  EIP712: {
    NAME: "NoctisExchange",
    VERSION: "1",
  },
} as const;

/**
 * Helper function to calculate total with fee
 */
export function withFee(amount: bigint, feeBasisPoints: number): bigint {
  return amount + (amount * BigInt(feeBasisPoints)) / 10000n;
}

/**
 * Helper function to calculate amount after fee deduction
 */
export function afterFee(amount: bigint, feeBasisPoints: number): bigint {
  return amount - (amount * BigInt(feeBasisPoints)) / 10000n;
}

/**
 * Helper to check if two BigInt values are approximately equal (for gas comparisons)
 */
export function isApproximately(
  actual: bigint,
  expected: bigint,
  tolerancePercent: number = 5
): boolean {
  const diff = actual > expected ? actual - expected : expected - actual;
  const tolerance = (expected * BigInt(tolerancePercent)) / 100n;
  return diff <= tolerance;
}
