/**
 * NoctisExchange Event Handlers
 * 
 * PRIVACY-FIRST: Events no longer contain trader addresses
 * 
 * Processes exchange events:
 * - OrderCreated: User creates a market order (no address indexed)
 * - OrderFilledSimple: Order was executed (no details indexed)
 * - SwapDecryptionReady: User requested swap execution
 * - OrderCancelled: User cancels their order
 */

import { Order } from "../generated/schema";
import {
  OrderCreated,
  OrderFilledSimple,
  SwapDecryptionReady,
  OrderCancelled
} from "../generated/NoctisExchange/NoctisExchange";
import { getGlobalStats } from "./utils";

/**
 * Handler: Order Created
 * PRIVACY: Only indexes orderId, isBuy, timestamp, orderType
 * NO trader address, NO amounts
 */
export function handleOrderCreated(event: OrderCreated): void {
  // Create unique ID: orderId
  let id = event.params.orderId.toString();
  let order = new Order(id);
  
  // Fill order data (PRIVACY: no trader address, no amounts)
  order.orderId = event.params.orderId;
  order.isBuy = event.params.isBuy;
  order.orderType = event.params.orderType == 0 ? "MARKET" : "LIMIT";
  order.status = "PENDING";
  order.createdAt = event.params.timestamp;
  order.createdBlock = event.block.number;
  order.createdTxHash = event.transaction.hash;
  order.swapRequested = false;
  
  // NOTE: No user linking for privacy - orders are anonymous
  
  // Update global stats (anonymous count only)
  let stats = getGlobalStats();
  stats.totalOrders = stats.totalOrders + 1;
  stats.lastUpdatedAt = event.block.timestamp;
  stats.save();
  
  // Save order
  order.save();
}

/**
 * Handler: Swap Decryption Ready
 * Triggered when user requests swap execution
 * PRIVACY: Only indexed for the owner to track their order
 */
export function handleSwapDecryptionReady(event: SwapDecryptionReady): void {
  let order = Order.load(event.params.orderId.toString());
  
  if (order != null) {
    order.swapRequested = true;
    order.swapRequestedAt = event.block.timestamp;
    order.save();
  }
}

/**
 * Handler: Order Filled (Simple - Privacy-First)
 * PRIVACY: Only indexes orderId and timestamp
 * NO trader addresses, NO amounts, NO counterparty
 */
export function handleOrderFilledSimple(event: OrderFilledSimple): void {
  let order = Order.load(event.params.orderId.toString());
  
  if (order != null) {
    order.status = "FILLED";
    order.filledAt = event.params.timestamp;
    order.filledBlock = event.block.number;
    order.filledTxHash = event.transaction.hash;
    // NOTE: No matchedOrderId, counterparty, or amounts for privacy
    order.save();
    
    // Update global stats (anonymous count only)
    let stats = getGlobalStats();
    stats.totalOrdersFilled = stats.totalOrdersFilled + 1;
    stats.lastUpdatedAt = event.block.timestamp;
    stats.save();
  }
}

/**
 * Handler: Order Cancelled
 * Triggered when user cancels their pending order
 */
export function handleOrderCancelled(event: OrderCancelled): void {
  let order = Order.load(event.params.orderId.toString());
  
  if (order != null) {
    order.status = "CANCELLED";
    order.cancelledAt = event.block.timestamp;
    order.cancelledTxHash = event.transaction.hash;
    order.save();
    
    // Update global stats
    let stats = getGlobalStats();
    stats.totalOrdersCancelled = stats.totalOrdersCancelled + 1;
    stats.lastUpdatedAt = event.block.timestamp;
    stats.save();
  }
}
