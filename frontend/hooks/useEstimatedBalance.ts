/**
 * useEstimatedBalance Hook
 * 
 * Calculates estimated balances from The Graph subgraph data.
 * Uses indexed data instead of RPC calls for:
 * - Complete history (all deposits, not just last X blocks)
 * - No rate limiting issues
 * - Faster response times
 * 
 * Formula:
 * - Estimated ETH = totalDepositedETH from User entity
 * - Estimated USDT = totalDepositedUSDT from User entity
 * 
 * Note: This is an ESTIMATE based on deposits. Actual balances are encrypted.
 */

"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useQuery } from "@apollo/client/react";
import { GET_USER_ACTIVITY } from "@/lib/graphql/queries";

interface EstimatedBalances {
  eth: string;
  usdt: string;
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date | null;
}

// GraphQL response type
interface UserBalanceResponse {
  user?: {
    totalDepositedETH: string;
    totalDepositedUSDT: string;
    totalWithdrawnETH: string;
    totalWithdrawnUSDT: string;
    netBalanceETH: string;
    netBalanceUSDT: string;
    totalDeposits: number;
    totalWithdrawals: number;
  };
}

export function useEstimatedBalance(): EstimatedBalances {
  const { address, isConnected } = useAccount();
  
  const [balances, setBalances] = useState<EstimatedBalances>({
    eth: "0",
    usdt: "0",
    isLoading: false,
    error: null,
    lastUpdated: null,
  });

  // Check if subgraph is configured
  const subgraphConfigured = typeof window !== "undefined" && !!process.env.NEXT_PUBLIC_SUBGRAPH_URL;

  // GraphQL query to The Graph - gets user stats with totals
  const { data, loading, error, refetch } = useQuery<UserBalanceResponse>(GET_USER_ACTIVITY, {
    variables: { 
      user: address?.toLowerCase() || "" 
    },
    skip: !isConnected || !address || !subgraphConfigured,
    fetchPolicy: "cache-and-network",
    pollInterval: subgraphConfigured ? 15000 : 0, // Refresh only if configured
  });

  useEffect(() => {
    if (!isConnected || !address) {
      setBalances({
        eth: "0",
        usdt: "0",
        isLoading: false,
        error: null,
        lastUpdated: null,
      });
      return;
    }

    if (loading && !data) {
      setBalances(prev => ({ ...prev, isLoading: true }));
      return;
    }

    if (error) {
      setBalances({
        eth: "0",
        usdt: "0",
        isLoading: false,
        error: "Failed to fetch balance from The Graph",
        lastUpdated: null,
      });
      return;
    }

    // Get totals from User entity (pre-calculated by subgraph)
    const user = data?.user;
    
    if (user) {
      // Use netBalance which accounts for deposits - withdrawals
      const ethBalance = user.netBalanceETH || "0";
      const usdtBalance = user.netBalanceUSDT || "0";

      if (process.env.NODE_ENV === "development") {
        console.log(`💰 The Graph Balance:`);
        console.log(`   - ETH: ${ethBalance} (${user.totalDepositedETH} deposited - ${user.totalWithdrawnETH} withdrawn)`);
        console.log(`   - USDT: ${usdtBalance} (${user.totalDepositedUSDT} deposited - ${user.totalWithdrawnUSDT} withdrawn)`);
        console.log(`   - Total deposits: ${user.totalDeposits}`);
        console.log(`   - Total withdrawals: ${user.totalWithdrawals}`);
      }

      setBalances({
        eth: ethBalance,
        usdt: usdtBalance,
        isLoading: false,
        error: null,
        lastUpdated: new Date(),
      });
    } else {
      // No user entity yet = no deposits
      if (process.env.NODE_ENV === "development") {
        console.log(`💰 The Graph: No user entity found (no deposits yet)`);
      }

      setBalances({
        eth: "0",
        usdt: "0",
        isLoading: false,
        error: null,
        lastUpdated: new Date(),
      });
    }
  }, [data, loading, error, address, isConnected]);

  // Listen for refresh events
  useEffect(() => {
    const handleRefresh = () => {
      if (process.env.NODE_ENV === "development") {
        console.log("💰 Balance refresh triggered - refetching from The Graph");
      }
      refetch();
    };
    
    window.addEventListener("noctis:refresh-activity", handleRefresh);
    window.addEventListener("noctis:refresh-balance", handleRefresh);
    
    return () => {
      window.removeEventListener("noctis:refresh-activity", handleRefresh);
      window.removeEventListener("noctis:refresh-balance", handleRefresh);
    };
  }, [refetch]);

  return balances;
}
