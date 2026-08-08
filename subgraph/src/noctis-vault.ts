/**
 * NoctisVault Event Handlers
 * 
 * Processes vault events:
 * - ETHDeposited: User deposits ETH into vault
 * - USDTDeposited: User deposits USDT into vault
 * - WithdrawalRequested: User requests withdrawal (encrypted)
 * - WithdrawalExecuted: Keeper completes withdrawal
 * - WithdrawalCancelled: User or system cancels withdrawal
 */

import { Deposit, Withdrawal } from "../generated/schema";
import {
  ETHDeposited,
  USDTDeposited,
  WithdrawalRequested,
  WithdrawalExecuted,
  WithdrawalCancelled
} from "../generated/NoctisVault/NoctisVault";
import { BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { 
  getOrCreateUser, 
  getGlobalStats, 
  convertToDecimal,
  ETH_DECIMALS,
  USDT_DECIMALS
} from "./utils";

/**
 * Handler: ETH Deposit
 * Triggered when user deposits ETH into vault
 */
export function handleETHDeposit(event: ETHDeposited): void {
  // Create unique ID: txHash-logIndex
  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let deposit = new Deposit(id);
  
  // Fill deposit data
  // Privacy: vault event omits amount — use msg.value from the deposit tx
  deposit.depositor = event.params.user;  // Parameter name is 'user' in ABI
  deposit.token = "ETH";
  deposit.amount = event.transaction.value;
  deposit.amountFormatted = convertToDecimal(event.transaction.value, ETH_DECIMALS);
  deposit.timestamp = event.block.timestamp;
  deposit.blockNumber = event.block.number;
  deposit.transactionHash = event.transaction.hash;
  
  // Link to user
  let user = getOrCreateUser(event.params.user, event.block.timestamp);
  deposit.user = user.id;
  
  // Update user stats
  user.totalDeposits = user.totalDeposits + 1;
  user.totalDepositedETH = user.totalDepositedETH.plus(deposit.amountFormatted);
  user.netBalanceETH = user.totalDepositedETH.minus(user.totalWithdrawnETH);
  user.save();
  
  // Update global stats
  let stats = getGlobalStats();
  stats.totalDeposits = stats.totalDeposits + 1;
  stats.totalDepositedETH = stats.totalDepositedETH.plus(deposit.amountFormatted);
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
  
  // Save deposit
  deposit.save();
}

/**
 * Handler: USDT Deposit
 * Triggered when user deposits USDT into vault
 */
export function handleUSDTDeposit(event: USDTDeposited): void {
  // Create unique ID: txHash-logIndex
  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let deposit = new Deposit(id);
  
  // Fill deposit data (USDT has 6 decimals, not 18)
  // Privacy: vault event omits amount — indexers should join ERC20 Transfer;
  // store 0 here until Transfer-based enrichment is wired.
  deposit.depositor = event.params.user;  // Parameter name is 'user' in ABI
  deposit.token = "USDT";
  deposit.amount = BigInt.fromI32(0);
  deposit.amountFormatted = convertToDecimal(BigInt.fromI32(0), USDT_DECIMALS);
  deposit.timestamp = event.block.timestamp;
  deposit.blockNumber = event.block.number;
  deposit.transactionHash = event.transaction.hash;
  
  // Link to user
  let user = getOrCreateUser(event.params.user, event.block.timestamp);
  deposit.user = user.id;
  
  // Update user stats
  user.totalDeposits = user.totalDeposits + 1;
  user.totalDepositedUSDT = user.totalDepositedUSDT.plus(deposit.amountFormatted);
  user.netBalanceUSDT = user.totalDepositedUSDT.minus(user.totalWithdrawnUSDT);
  user.save();
  
  // Update global stats
  let stats = getGlobalStats();
  stats.totalDeposits = stats.totalDeposits + 1;
  stats.totalDepositedUSDT = stats.totalDepositedUSDT.plus(deposit.amountFormatted);
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
  
  // Save deposit
  deposit.save();
}

/**
 * Handler: Withdrawal Requested
 * Triggered when user requests withdrawal (amounts are encrypted)
 * Event signature: WithdrawalRequested(indexed uint256,address,bool,uint256)
 */
export function handleWithdrawalRequested(event: WithdrawalRequested): void {
  // Create unique ID: requestId
  let id = event.params.requestId.toString();
  let withdrawal = new Withdrawal(id);
  
  // Fill withdrawal data
  withdrawal.requestId = event.params.requestId;
  withdrawal.user = event.params.requester;  // Parameter name is 'requester' in ABI
  withdrawal.isEth = event.params.isEth;     // New parameter: ETH or USDT
  withdrawal.status = "PENDING";
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.blockNumber = event.block.number;
  withdrawal.transactionHash = event.transaction.hash;
  
  // Link to user
  let user = getOrCreateUser(event.params.requester, event.block.timestamp);
  withdrawal.userEntity = user.id;
  
  // Update user stats
  user.totalWithdrawals = user.totalWithdrawals + 1;
  user.save();
  
  // Update global stats
  let stats = getGlobalStats();
  stats.totalWithdrawals = stats.totalWithdrawals + 1;
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
  
  // Save withdrawal
  withdrawal.save();
}

/**
 * Handler: Withdrawal Executed
 * Triggered when keeper completes withdrawal via Gateway callback
 * Updates withdrawal with amount and deducts from user totals
 */
export function handleWithdrawalExecuted(event: WithdrawalExecuted): void {
  // Load withdrawal by requestId
  let id = event.params.requestId.toString();
  let withdrawal = Withdrawal.load(id);
  
  if (!withdrawal) {
    // Withdrawal not found, create placeholder (shouldn't happen in normal flow)
    withdrawal = new Withdrawal(id);
    withdrawal.requestId = event.params.requestId;
    withdrawal.user = event.params.recipient; // Use recipient as user
    withdrawal.timestamp = event.block.timestamp;
    withdrawal.blockNumber = event.block.number;
    withdrawal.transactionHash = event.transaction.hash;
    withdrawal.userEntity = event.params.recipient.toHexString();
    withdrawal.status = "PENDING"; // Will be updated below
  }
  
  // Update withdrawal with amount and status
  withdrawal.status = "COMPLETED";
  withdrawal.amount = event.params.amount;
  withdrawal.completedAt = event.block.timestamp;
  withdrawal.completedTxHash = event.transaction.hash;
  
  // Determine token type and format amount
  let isEth = withdrawal.isEth != null ? (withdrawal.isEth as boolean) : true; // Default to ETH if not set
  withdrawal.token = isEth ? "ETH" : "USDT";
  withdrawal.amountFormatted = convertToDecimal(
    event.params.amount,
    isEth ? ETH_DECIMALS : USDT_DECIMALS
  );
  
  // Update user stats - SUBTRACT withdrawn amounts
  let user = getOrCreateUser(event.params.recipient, event.block.timestamp);
  
  // amountFormatted is now guaranteed to be non-null after assignment above
  let withdrawnAmount = withdrawal.amountFormatted as BigDecimal;
  
  if (isEth) {
    user.totalWithdrawnETH = user.totalWithdrawnETH.plus(withdrawnAmount);
    user.netBalanceETH = user.totalDepositedETH.minus(user.totalWithdrawnETH);
  } else {
    user.totalWithdrawnUSDT = user.totalWithdrawnUSDT.plus(withdrawnAmount);
    user.netBalanceUSDT = user.totalDepositedUSDT.minus(user.totalWithdrawnUSDT);
  }
  user.save();
  
  // Save withdrawal
  withdrawal.save();
  
  // Update global stats
  let stats = getGlobalStats();
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

/**
 * Handler: Withdrawal Cancelled
 * Triggered when user or system cancels withdrawal
 */
export function handleWithdrawalCancelled(event: WithdrawalCancelled): void {
  // Load withdrawal by requestId
  let id = event.params.requestId.toString();
  let withdrawal = Withdrawal.load(id);
  
  if (!withdrawal) {
    // Withdrawal not found, create placeholder (shouldn't happen)
    withdrawal = new Withdrawal(id);
    withdrawal.requestId = event.params.requestId;
    withdrawal.user = event.params.requester;
    withdrawal.status = "CANCELLED";
    withdrawal.timestamp = event.block.timestamp;
    withdrawal.blockNumber = event.block.number;
    withdrawal.transactionHash = event.transaction.hash;
    withdrawal.userEntity = event.params.requester.toHexString();
  }
  
  // Update withdrawal status
  withdrawal.status = "CANCELLED";
  withdrawal.cancelledAt = event.block.timestamp;
  withdrawal.cancelledTxHash = event.transaction.hash;
  
  // Save withdrawal
  withdrawal.save();
  
  // Update global stats
  let stats = getGlobalStats();
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}
