/**
 * Utility functions for Noctis Protocol Subgraph (V2)
 *
 * Provides reusable helpers for:
 * - Type conversions
 * - Entity creation (User, Token, GlobalStats)
 */

import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { User, Token, GlobalStats } from "../generated/schema";

// ============================================================================
// Constants
// ============================================================================

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BI = BigInt.fromI32(0);
export const ONE_BI = BigInt.fromI32(1);
export const ETH_DECIMALS = 18;

/** Native ETH sentinel used by the V2 contracts (NoctisVaultV2.NATIVE) */
export const NATIVE_TOKEN = Address.zero();

// ============================================================================
// Type Conversions
// ============================================================================

/**
 * Convert BigInt amount to BigDecimal with specified decimals
 * Example: 1000000000000000000 (1 ETH in wei) → 1.0
 */
export function convertToDecimal(amount: BigInt, decimals: i32): BigDecimal {
  let divisor = BigInt.fromI32(10).pow(decimals as u8);
  return amount.toBigDecimal().div(divisor.toBigDecimal());
}

// ============================================================================
// Entity Management
// ============================================================================

/**
 * Get or create User entity
 * PRIVACY: Only tracks deposits/withdrawals, NOT orders
 * Order activity is anonymous and not linked to users
 */
export function getOrCreateUser(address: Address, timestamp: BigInt): User {
  let id = address.toHexString();
  let user = User.load(id);

  if (user == null) {
    user = new User(id);
    user.address = address;
    user.totalDeposits = 0;
    user.totalWithdrawals = 0;
    // NOTE: Orders are NOT tracked per user for privacy
    user.totalDepositedETH = BigDecimal.fromString("0");
    user.totalDepositedUSDT = BigDecimal.fromString("0");
    user.totalWithdrawnETH = BigDecimal.fromString("0");
    user.totalWithdrawnUSDT = BigDecimal.fromString("0");
    user.netBalanceETH = BigDecimal.fromString("0");
    user.netBalanceUSDT = BigDecimal.fromString("0");
    user.firstSeenAt = timestamp;
    user.lastSeenAt = timestamp;
    user.save();

    // Increment global user count
    let stats = getGlobalStats();
    stats.totalUsers = stats.totalUsers + 1;
    stats.lastUpdatedAt = timestamp;
    stats.save();
  } else {
    // Update last seen timestamp
    user.lastSeenAt = timestamp;
    user.save();
  }

  return user;
}

/**
 * Get or create Token entity (id = token address, 0x0 = native ETH)
 * Cumulative per-token counters start at 0; registry flags default to false
 * until the corresponding TokenConfigured / TradableTokenConfigured event.
 */
export function getOrCreateToken(address: Address, timestamp: BigInt): Token {
  let id = address.toHexString();
  let token = Token.load(id);

  if (token == null) {
    token = new Token(id);
    token.vaultEnabled = false;
    token.tradingEnabled = false;
    token.totalOrders = 0;
    token.totalDeposits = 0;
    token.totalWithdrawals = 0;
    token.totalFeesCollected = ZERO_BI;
    token.totalFeeEvents = 0;
    token.totalGasRefundsCollected = ZERO_BI;
    token.totalGasRefundEvents = 0;
    token.firstSeenAt = timestamp;
    token.lastUpdatedAt = timestamp;
    token.save();

    // Increment global token count
    let stats = getGlobalStats();
    stats.totalTokens = stats.totalTokens + 1;
    stats.lastUpdatedAt = timestamp;
    stats.save();
  }

  return token;
}

/**
 * Get or create GlobalStats singleton
 * - ID is always "global"
 * - Initializes all counters to 0 on first creation
 */
export function getGlobalStats(): GlobalStats {
  let stats = GlobalStats.load("global");

  if (stats == null) {
    stats = new GlobalStats("global");
    stats.totalUsers = 0;
    stats.totalDeposits = 0;
    stats.totalDepositedETH = BigDecimal.fromString("0");
    stats.totalDepositedUSDT = BigDecimal.fromString("0");
    stats.totalWithdrawals = 0;
    stats.totalOrders = 0;
    stats.totalOrdersFilled = 0;
    stats.totalOrdersCancelled = 0;
    stats.totalTokens = 0;
    stats.totalFeesCollected = ZERO_BI;
    stats.totalFeeEvents = 0;
    stats.totalGasRefundsCollected = ZERO_BI;
    stats.totalGasRefundEvents = 0;
    stats.lastUpdatedAt = ZERO_BI;
    stats.save();
  }

  return stats;
}
