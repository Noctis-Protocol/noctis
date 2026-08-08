/**
 * GraphQL Queries for Noctis Protocol
 * 
 * All queries for fetching on-chain activity from The Graph subgraph.
 * Replaces direct RPC calls (getContractEvents, getBlock, etc.)
 */

import { gql } from "@apollo/client";

// ============================================================================
// User Activity Queries
// ============================================================================

/**
 * Get user deposits (ETH and USDT)
 */
export const GET_USER_DEPOSITS = gql`
  query GetUserDeposits($user: Bytes!, $first: Int = 50) {
    deposits(
      where: { depositor: $user }
      orderBy: timestamp
      orderDirection: desc
      first: $first
    ) {
      id
      token
      amount
      amountFormatted
      timestamp
      blockNumber
      transactionHash
    }
  }
`;

/**
 * Get user withdrawals
 */
export const GET_USER_WITHDRAWALS = gql`
  query GetUserWithdrawals($user: Bytes!, $first: Int = 50) {
    withdrawals(
      where: { user: $user }
      orderBy: timestamp
      orderDirection: desc
      first: $first
    ) {
      id
      requestId
      status
      isEth
      timestamp
      blockNumber
      transactionHash
    }
  }
`;

/**
 * Get user orders (created, filled, cancelled)
 */
export const GET_USER_ORDERS = gql`
  query GetUserOrders($user: Bytes!, $first: Int = 50) {
    orders(
      where: { trader: $user }
      orderBy: createdAt
      orderDirection: desc
      first: $first
    ) {
      id
      orderId
      isBuy
      status
      orderType
      slippageTolerance
      createdAt
      createdBlock
      createdTxHash
      filledAt
      filledBlock
      filledTxHash
      matchedOrderId
      counterparty
      cancelledAt
      cancelledTxHash
    }
  }
`;

/**
 * Get complete user activity (deposits + orders + stats)
 * This is the main query used by useActivityFeed hook
 */
export const GET_USER_ACTIVITY = gql`
  query GetUserActivity($user: Bytes!) {
    # User statistics
    user(id: $user) {
      address
      totalDeposits
      totalWithdrawals
      totalOrders
      totalOrdersFilled
      totalDepositedETH
      totalDepositedUSDT
      totalWithdrawnETH
      totalWithdrawnUSDT
      netBalanceETH
      netBalanceUSDT
      firstSeenAt
      lastSeenAt
    }
    
    # Recent deposits
    deposits(
      where: { depositor: $user }
      first: 50
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      token
      amount
      amountFormatted
      timestamp
      transactionHash
    }
    
    # Recent withdrawals
    withdrawals(
      where: { user: $user }
      first: 20
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      requestId
      status
      token
      amount
      amountFormatted
      isEth
      timestamp
      transactionHash
      completedAt
      completedTxHash
    }
    
    # Orders are privacy-first: subgraph has NO trader field.
    # Desk loads the user's orders on-chain via getMyOrder (useActivityFeed).
  }
`;

// ============================================================================
// Global Statistics Queries
// ============================================================================

/**
 * Get global protocol statistics
 */
export const GET_GLOBAL_STATS = gql`
  query GetGlobalStats {
    globalStats(id: "global") {
      totalUsers
      totalDeposits
      totalDepositedETH
      totalDepositedUSDT
      totalWithdrawals
      totalOrders
      totalOrdersFilled
      totalOrdersCancelled
      lastUpdatedAt
    }
  }
`;

/**
 * Get recent protocol activity (all users)
 */
export const GET_RECENT_ACTIVITY = gql`
  query GetRecentActivity($first: Int = 20) {
    deposits(
      first: $first
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      depositor
      token
      amountFormatted
      timestamp
      transactionHash
    }
    
    orders(
      first: $first
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      trader
      isBuy
      status
      createdAt
      filledAt
    }
  }
`;

// ============================================================================
// Specific Entity Queries
// ============================================================================

/**
 * Get single order by ID
 */
export const GET_ORDER = gql`
  query GetOrder($orderId: String!) {
    order(id: $orderId) {
      id
      orderId
      trader
      isBuy
      status
      orderType
      slippageTolerance
      createdAt
      createdBlock
      createdTxHash
      filledAt
      filledBlock
      filledTxHash
      matchedOrderId
      counterparty
      cancelledAt
      cancelledTxHash
    }
  }
`;

/**
 * Get single user by address
 */
export const GET_USER = gql`
  query GetUser($address: String!) {
    user(id: $address) {
      address
      totalDeposits
      totalWithdrawals
      totalOrders
      totalOrdersFilled
      totalDepositedETH
      totalDepositedUSDT
      firstSeenAt
      lastSeenAt
    }
  }
`;

// ============================================================================
// Filtered Queries
// ============================================================================

/**
 * Get pending orders for a user
 */
export const GET_USER_PENDING_ORDERS = gql`
  query GetUserPendingOrders($user: Bytes!) {
    orders(
      where: { trader: $user, status: PENDING }
      orderBy: createdAt
      orderDirection: desc
    ) {
      id
      orderId
      isBuy
      orderType
      createdAt
      createdTxHash
    }
  }
`;

/**
 * Get filled orders for a user
 */
export const GET_USER_FILLED_ORDERS = gql`
  query GetUserFilledOrders($user: Bytes!, $first: Int = 50) {
    orders(
      where: { trader: $user, status: FILLED }
      orderBy: filledAt
      orderDirection: desc
      first: $first
    ) {
      id
      orderId
      isBuy
      createdAt
      filledAt
      filledTxHash
      counterparty
    }
  }
`;
