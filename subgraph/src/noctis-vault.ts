/**
 * NoctisVaultV2 Event Handlers (multi-token vault, native ETH = address(0))
 *
 * Processes vault events:
 * - Deposited: token-aware deposit (amount omitted by event for ERC20;
 *   ETH amount recovered from msg.value which is public anyway)
 * - WithdrawalRequested / Executed / Cancelled / ExecutionFailed: lifecycle
 * - TokenConfigured: token registry (decimals fetched from tokenConfigs)
 *
 * PRIVACY: never index anything beyond what events expose. Encrypted
 * balances and amounts stay encrypted; only cleartext event params are used.
 */

import { BigDecimal, BigInt } from "@graphprotocol/graph-ts";
import { Deposit, Withdrawal, Token } from "../generated/schema";
import {
  NoctisVaultV2,
  Deposited,
  WithdrawalRequested,
  WithdrawalExecuted,
  WithdrawalCancelled,
  WithdrawalExecutionFailed,
  TokenConfigured
} from "../generated/NoctisVaultV2/NoctisVaultV2";
import {
  getOrCreateUser,
  getOrCreateToken,
  getGlobalStats,
  convertToDecimal,
  ETH_DECIMALS,
  NATIVE_TOKEN,
  ZERO_BI
} from "./utils";

/**
 * Handler: Deposit (token-aware)
 * Event: Deposited(address indexed token, address user)
 *
 * The event intentionally omits the amount. For native ETH the deposit tx
 * carries the amount as msg.value (public on-chain), so it is recovered from
 * the transaction. For ERC20 tokens the amount stays 0 until Transfer-based
 * enrichment is wired.
 */
export function handleDeposited(event: Deposited): void {
  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let deposit = new Deposit(id);

  let isNative = event.params.token.equals(NATIVE_TOKEN);
  let amount = isNative ? event.transaction.value : ZERO_BI;

  deposit.depositor = event.params.user;
  deposit.token = event.params.token;
  deposit.amount = amount;
  deposit.amountFormatted = isNative
    ? convertToDecimal(amount, ETH_DECIMALS)
    : BigDecimal.fromString("0");
  deposit.timestamp = event.block.timestamp;
  deposit.blockNumber = event.block.number;
  deposit.transactionHash = event.transaction.hash;

  // Link to user
  let user = getOrCreateUser(event.params.user, event.block.timestamp);
  deposit.user = user.id;

  // Link to token + per-token counters
  let token = getOrCreateToken(event.params.token, event.block.timestamp);
  deposit.tokenEntity = token.id;
  token.totalDeposits = token.totalDeposits + 1;
  token.lastUpdatedAt = event.block.timestamp;
  token.save();

  // Update user stats (legacy field names: ETH = native, USDT = ERC20)
  user.totalDeposits = user.totalDeposits + 1;
  if (isNative) {
    user.totalDepositedETH = user.totalDepositedETH.plus(deposit.amountFormatted);
    user.netBalanceETH = user.totalDepositedETH.minus(user.totalWithdrawnETH);
  }
  user.save();

  // Update global stats
  let stats = getGlobalStats();
  stats.totalDeposits = stats.totalDeposits + 1;
  if (isNative) {
    stats.totalDepositedETH = stats.totalDepositedETH.plus(deposit.amountFormatted);
  }
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();

  deposit.save();
}

/**
 * Handler: Withdrawal Requested
 * Event: WithdrawalRequested(uint256 indexed requestId, address requester, address token, uint256 timestamp)
 * Amounts are encrypted at request time; only known after execution.
 */
export function handleWithdrawalRequested(event: WithdrawalRequested): void {
  let id = event.params.requestId.toString();
  let withdrawal = new Withdrawal(id);

  withdrawal.requestId = event.params.requestId;
  withdrawal.user = event.params.requester;
  withdrawal.token = event.params.token;
  withdrawal.isEth = event.params.token.equals(NATIVE_TOKEN);
  withdrawal.status = "PENDING";
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.blockNumber = event.block.number;
  withdrawal.transactionHash = event.transaction.hash;

  // Link to user
  let user = getOrCreateUser(event.params.requester, event.block.timestamp);
  withdrawal.userEntity = user.id;

  // Link to token + per-token counters
  let token = getOrCreateToken(event.params.token, event.block.timestamp);
  withdrawal.tokenEntity = token.id;
  token.totalWithdrawals = token.totalWithdrawals + 1;
  token.lastUpdatedAt = event.block.timestamp;
  token.save();

  // Update user stats
  user.totalWithdrawals = user.totalWithdrawals + 1;
  user.save();

  // Update global stats
  let stats = getGlobalStats();
  stats.totalWithdrawals = stats.totalWithdrawals + 1;
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();

  withdrawal.save();
}

/**
 * Handler: Withdrawal Executed
 * Event: WithdrawalExecuted(uint256 indexed requestId, address recipient, uint256 amount)
 * Amount becomes cleartext at execution (Gateway decryption callback).
 */
export function handleWithdrawalExecuted(event: WithdrawalExecuted): void {
  let id = event.params.requestId.toString();
  let withdrawal = Withdrawal.load(id);

  if (!withdrawal) {
    // Shouldn't happen in normal flow (request always precedes execution)
    withdrawal = new Withdrawal(id);
    withdrawal.requestId = event.params.requestId;
    withdrawal.user = event.params.recipient;
    withdrawal.timestamp = event.block.timestamp;
    withdrawal.blockNumber = event.block.number;
    withdrawal.transactionHash = event.transaction.hash;
    withdrawal.userEntity = getOrCreateUser(
      event.params.recipient,
      event.block.timestamp
    ).id;
    withdrawal.status = "PENDING"; // Updated below
  }

  withdrawal.status = "COMPLETED";
  withdrawal.amount = event.params.amount;
  withdrawal.completedAt = event.block.timestamp;
  withdrawal.completedTxHash = event.transaction.hash;

  // Format amount using per-token decimals (18 for native ETH, otherwise
  // from the Token entity populated by TokenConfigured).
  // NOTE: generated getters collapse null to false/0, so decimals == 0 is
  // treated as "unknown" (no real registered token has 0 decimals).
  let isNative = withdrawal.isEth;
  let decimals = -1;
  if (isNative) {
    decimals = ETH_DECIMALS;
  } else {
    let tokenId = withdrawal.tokenEntity;
    if (tokenId != null) {
      let token = Token.load(tokenId!);
      if (token != null && token.decimals > 0) {
        decimals = token.decimals;
      }
    }
  }
  if (decimals >= 0) {
    withdrawal.amountFormatted = convertToDecimal(event.params.amount, decimals);
  }

  // Update user stats - add withdrawn amounts (legacy names: ETH = native,
  // USDT = ERC20 stable)
  let user = getOrCreateUser(event.params.recipient, event.block.timestamp);
  if (withdrawal.amountFormatted !== null) {
    let withdrawnAmount = withdrawal.amountFormatted as BigDecimal;
    if (isNative) {
      user.totalWithdrawnETH = user.totalWithdrawnETH.plus(withdrawnAmount);
      user.netBalanceETH = user.totalDepositedETH.minus(user.totalWithdrawnETH);
    } else {
      user.totalWithdrawnUSDT = user.totalWithdrawnUSDT.plus(withdrawnAmount);
      user.netBalanceUSDT = user.totalDepositedUSDT.minus(user.totalWithdrawnUSDT);
    }
  }
  user.save();

  withdrawal.save();

  // Update global stats
  let stats = getGlobalStats();
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

/**
 * Handler: Withdrawal Cancelled
 * Event: WithdrawalCancelled(uint256 indexed requestId, address requester)
 */
export function handleWithdrawalCancelled(event: WithdrawalCancelled): void {
  let id = event.params.requestId.toString();
  let withdrawal = Withdrawal.load(id);

  if (!withdrawal) {
    // Shouldn't happen in normal flow
    withdrawal = new Withdrawal(id);
    withdrawal.requestId = event.params.requestId;
    withdrawal.user = event.params.requester;
    withdrawal.timestamp = event.block.timestamp;
    withdrawal.blockNumber = event.block.number;
    withdrawal.transactionHash = event.transaction.hash;
    withdrawal.userEntity = getOrCreateUser(
      event.params.requester,
      event.block.timestamp
    ).id;
  }

  withdrawal.status = "CANCELLED";
  withdrawal.cancelledAt = event.block.timestamp;
  withdrawal.cancelledTxHash = event.transaction.hash;
  withdrawal.save();

  // Update global stats
  let stats = getGlobalStats();
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

/**
 * Handler: Withdrawal Execution Failed
 * Event: WithdrawalExecutionFailed(uint256 indexed requestId)
 * Emitted when the decryption callback could not complete the transfer.
 */
export function handleWithdrawalExecutionFailed(
  event: WithdrawalExecutionFailed
): void {
  let withdrawal = Withdrawal.load(event.params.requestId.toString());

  if (withdrawal != null) {
    withdrawal.status = "FAILED";
    withdrawal.failedAt = event.block.timestamp;
    withdrawal.failedTxHash = event.transaction.hash;
    withdrawal.save();

    let stats = getGlobalStats();
    stats.lastUpdatedAt = event.block.timestamp;
    stats.save();
  }
}

/**
 * Handler: Token Configured (vault registry)
 * Event: TokenConfigured(address indexed token, bool enabled)
 * Also fetches the token decimals from the vault's tokenConfigs mapping
 * (decimals are passed explicitly at configuration and cached on-chain).
 */
export function handleTokenConfigured(event: TokenConfigured): void {
  let token = getOrCreateToken(event.params.token, event.block.timestamp);
  token.vaultEnabled = event.params.enabled;
  token.lastUpdatedAt = event.block.timestamp;

  // Read cached decimals from the vault (view call; tolerates reverts)
  let vault = NoctisVaultV2.bind(event.address);
  let configResult = vault.try_tokenConfigs(event.params.token);
  if (!configResult.reverted) {
    token.decimals = configResult.value.getDecimals();
  }

  token.save();
}
