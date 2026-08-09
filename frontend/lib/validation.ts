/**
 * Validation utilities for Noctis Protocol
 * 
 * Contains deposit/withdrawal limits and validation functions
 * that match smart contract requirements (NoctisVault.sol)
 */

// Contract deposit limits (from NoctisVault.sol lines 72-81)
const USDT_LIMITS = {
  MIN: 10,      // 10 USDT/USDC minimum
  MAX: 1_000_000, // 1M maximum
  QUICK_AMOUNTS: [10, 100, 1000, 10000],
} as const;

export const DEPOSIT_LIMITS = {
  ETH: {
    MIN: 0.005,  // 0.005 ETH minimum (~$10)
    MAX: 100,    // 100 ETH maximum (~$300k)
    QUICK_AMOUNTS: [0.01, 0.1, 1, 10], // Suggested amounts
  },
  USDT: USDT_LIMITS,
  USDC: USDT_LIMITS,
} as const;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate an amount against explicit limits (V2 multi-token path).
 * Limits come from the vault's on-chain tokenConfigs, already converted to
 * human units; pass undefined when the config has not loaded yet.
 */
export function validateAmountWithLimits(
  amount: string,
  symbol: string,
  min?: number,
  max?: number
): ValidationResult {
  const numAmount = parseFloat(amount);

  if (isNaN(numAmount) || numAmount <= 0) {
    return { valid: false, error: 'Enter a valid amount' };
  }
  if (min !== undefined && numAmount < min) {
    return { valid: false, error: `Minimum deposit: ${min} ${symbol}` };
  }
  if (max !== undefined && max > 0 && numAmount > max) {
    return { valid: false, error: `Maximum deposit: ${max.toLocaleString()} ${symbol}` };
  }
  return { valid: true };
}

/** Suggested quick amounts per token symbol (fallback for unknown tokens). */
export function quickAmountsFor(symbol: string): readonly number[] {
  if (symbol === 'ETH' || symbol === 'WETH') return DEPOSIT_LIMITS.ETH.QUICK_AMOUNTS;
  if (symbol === 'USDC' || symbol === 'USDT') return DEPOSIT_LIMITS.USDC.QUICK_AMOUNTS;
  return [1, 10, 100, 1000];
}

/**
 * Validate deposit amount against contract limits
 * @param amount - Amount as string (user input)
 * @param token - Token type (ETH or USDT)
 * @returns Validation result with error message if invalid
 */
export function validateDepositAmount(
  amount: string, 
  token: 'ETH' | 'USDT' | 'USDC'
): ValidationResult {
  const numAmount = parseFloat(amount);
  
  // Check for invalid number
  if (isNaN(numAmount) || numAmount <= 0) {
    return { valid: false, error: 'Enter a valid amount' };
  }
  
  const limits = DEPOSIT_LIMITS[token];
  
  // Check minimum
  if (numAmount < limits.MIN) {
    return { 
      valid: false, 
      error: `Minimum deposit: ${limits.MIN} ${token}` 
    };
  }
  
  // Check maximum
  if (numAmount > limits.MAX) {
    return { 
      valid: false, 
      error: `Maximum deposit: ${limits.MAX.toLocaleString()} ${token}` 
    };
  }
  
  return { valid: true };
}

/**
 * Format amount with appropriate decimals
 * @param amount - Amount to format
 * @param token - Token type
 */
export function formatDepositAmount(amount: number, token: 'ETH' | 'USDT'): string {
  if (token === 'ETH') {
    return amount.toFixed(4);
  } else {
    return amount.toFixed(2);
  }
}
