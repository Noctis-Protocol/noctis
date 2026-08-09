/**
 * NoctisExchangeV2 Event Handlers (multi-token orders)
 *
 * PRIVACY-FIRST: Events contain no trader addresses and no plaintext amounts.
 * Ciphertext handles (OrderFilledPrivate, SwapDecryptionReady) are never stored.
 *
 * Processes exchange events:
 * - OrderCreated: order opened (orderId, baseToken, isBuy only)
 * - OrderFilledSimple / OrderFilledPrivate: order executed (both fire in the
 *   same tx; fill counting is idempotent on the PENDING -> FILLED transition)
 * - OrderCancelled: order cancelled by trader or keeper
 * - SwapDecryptionReady / BuySufficiencyReady: user requested swap execution
 * - ProtocolFeeCollected / GasRefundCollected: cleartext fee flows at settlement
 * - TradableTokenConfigured: exchange token registry
 */

import { BigInt, ethereum } from "@graphprotocol/graph-ts";
import { Order, Token } from "../generated/schema";
import {
  OrderCreated,
  OrderFilledSimple,
  OrderFilledPrivate,
  OrderCancelled,
  SwapDecryptionReady,
  BuySufficiencyReady,
  ProtocolFeeCollected,
  GasRefundCollected,
  TradableTokenConfigured
} from "../generated/NoctisExchangeV2/NoctisExchangeV2";
import { getGlobalStats, getOrCreateToken } from "./utils";

/**
 * Handler: Order Created
 * Event: OrderCreated(uint256 indexed orderId, address indexed baseToken, bool isBuy, uint256 timestamp)
 * V2: orderType removed (all orders are market orders), baseToken added.
 * PRIVACY: no trader address, no amounts.
 */
export function handleOrderCreated(event: OrderCreated): void {
  let id = event.params.orderId.toString();
  let order = new Order(id);

  order.orderId = event.params.orderId;
  order.baseToken = event.params.baseToken;
  order.isBuy = event.params.isBuy;
  order.status = "PENDING";
  order.createdAt = event.params.timestamp;
  order.createdBlock = event.block.number;
  order.createdTxHash = event.transaction.hash;
  order.swapRequested = false;

  // Link to token + per-token counters
  let token = getOrCreateToken(event.params.baseToken, event.block.timestamp);
  order.tokenEntity = token.id;
  token.totalOrders = token.totalOrders + 1;
  token.lastUpdatedAt = event.block.timestamp;
  token.save();

  // NOTE: No user linking for privacy - orders are anonymous

  // Update global stats (anonymous count only)
  let stats = getGlobalStats();
  stats.totalOrders = stats.totalOrders + 1;
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();

  order.save();
}

/**
 * Mark an order FILLED exactly once (PENDING -> FILLED transition).
 * Both OrderFilledSimple and OrderFilledPrivate fire in the same fill tx,
 * so the global counter must only increment on the first transition.
 */
function markOrderFilled(
  orderId: BigInt,
  filledAt: BigInt,
  event: ethereum.Event
): void {
  let order = Order.load(orderId.toString());
  if (order == null || order.status == "FILLED") {
    return;
  }

  order.status = "FILLED";
  order.filledAt = filledAt;
  order.filledBlock = event.block.number;
  order.filledTxHash = event.transaction.hash;
  order.save();

  let stats = getGlobalStats();
  stats.totalOrdersFilled = stats.totalOrdersFilled + 1;
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

/**
 * Handler: Order Filled (public marker)
 * Event: OrderFilledSimple(uint256 indexed orderId, uint256 timestamp)
 */
export function handleOrderFilledSimple(event: OrderFilledSimple): void {
  markOrderFilled(event.params.orderId, event.params.timestamp, event);
}

/**
 * Handler: Order Filled (private companion)
 * Event: OrderFilledPrivate(uint256 indexed orderId, bytes32 encryptedAmountIn, bytes32 encryptedAmountOut)
 * PRIVACY: ciphertext handles are intentionally NOT stored.
 */
export function handleOrderFilledPrivate(event: OrderFilledPrivate): void {
  markOrderFilled(event.params.orderId, event.block.timestamp, event);
}

/**
 * Handler: Order Cancelled
 * Event: OrderCancelled(uint256 indexed orderId, uint256 timestamp)
 */
export function handleOrderCancelled(event: OrderCancelled): void {
  let order = Order.load(event.params.orderId.toString());

  if (order != null) {
    order.status = "CANCELLED";
    order.cancelledAt = event.params.timestamp;
    order.cancelledTxHash = event.transaction.hash;
    order.save();

    let stats = getGlobalStats();
    stats.totalOrdersCancelled = stats.totalOrdersCancelled + 1;
    stats.lastUpdatedAt = event.block.timestamp;
    stats.save();
  }
}

/**
 * Handler: Swap Decryption Ready (sell + buy amount decrypt request)
 * Event: SwapDecryptionReady(uint256 indexed orderId, bytes32[] handles)
 * PRIVACY: handles are ciphertext references and are NOT stored.
 */
export function handleSwapDecryptionReady(event: SwapDecryptionReady): void {
  let order = Order.load(event.params.orderId.toString());

  if (order != null) {
    order.swapRequested = true;
    if (order.swapRequestedAt === null) {
      order.swapRequestedAt = event.block.timestamp;
    }
    order.save();
  }
}

/**
 * Handler: Buy Sufficiency Ready (second step of the buy execution flow)
 * Event: BuySufficiencyReady(uint256 indexed orderId, bytes32 sufficiencyHandle, uint256 usdcNeeded)
 * Idempotent swapRequested marker; the sufficiency handle is NOT stored.
 */
export function handleBuySufficiencyReady(event: BuySufficiencyReady): void {
  let order = Order.load(event.params.orderId.toString());

  if (order != null) {
    order.swapRequested = true;
    if (order.swapRequestedAt === null) {
      order.swapRequestedAt = event.block.timestamp;
    }
    order.save();
  }
}

/**
 * Handler: Protocol Fee Collected
 * Event: ProtocolFeeCollected(uint256 indexed orderId, address indexed token, uint256 feeAmount, address indexed recipient)
 * Fee amounts are cleartext at settlement; aggregated globally and per token.
 */
export function handleProtocolFeeCollected(event: ProtocolFeeCollected): void {
  let token = getOrCreateToken(event.params.token, event.block.timestamp);
  token.totalFeesCollected = token.totalFeesCollected.plus(event.params.feeAmount);
  token.totalFeeEvents = token.totalFeeEvents + 1;
  token.lastUpdatedAt = event.block.timestamp;
  token.save();

  let stats = getGlobalStats();
  stats.totalFeesCollected = stats.totalFeesCollected.plus(event.params.feeAmount);
  stats.totalFeeEvents = stats.totalFeeEvents + 1;
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

/**
 * Handler: Gas Refund Collected
 * Event: GasRefundCollected(uint256 indexed orderId, address indexed token, uint256 refundAmount)
 * Gas-in-kind refunds paid to the relayer float; aggregated globally and per token.
 */
export function handleGasRefundCollected(event: GasRefundCollected): void {
  let token = getOrCreateToken(event.params.token, event.block.timestamp);
  token.totalGasRefundsCollected = token.totalGasRefundsCollected.plus(
    event.params.refundAmount
  );
  token.totalGasRefundEvents = token.totalGasRefundEvents + 1;
  token.lastUpdatedAt = event.block.timestamp;
  token.save();

  let stats = getGlobalStats();
  stats.totalGasRefundsCollected = stats.totalGasRefundsCollected.plus(
    event.params.refundAmount
  );
  stats.totalGasRefundEvents = stats.totalGasRefundEvents + 1;
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
}

/**
 * Handler: Tradable Token Configured (exchange registry)
 * Event: TradableTokenConfigured(address indexed baseToken, bool enabled)
 */
export function handleTradableTokenConfigured(
  event: TradableTokenConfigured
): void {
  let token = getOrCreateToken(event.params.baseToken, event.block.timestamp);
  token.tradingEnabled = event.params.enabled;
  token.lastUpdatedAt = event.block.timestamp;
  token.save();
}
