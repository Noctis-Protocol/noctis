/**
 * useVaultBalances Hook
 * 
 * Reads encrypted balances from NoctisVault contract.
 * Note: Balances are encrypted (bytes32), so they need re-encryption to display.
 * For now, we check if balance exists (non-zero bytes32) to show "has balance" vs "empty".
 * 
 * Updates on:
 * - Relevant contract events (deposits, withdrawals, orders)
 * - Polling interval (every 10 seconds)
 * - Manual refetch calls
 */

"use client";

import { useAccount, useChainId, useReadContract } from "wagmi";
import { useEffect, useCallback } from "react";
// Note: useChainId imported but used for potential future chain-specific logic
import { NoctisVaultABI } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";

// NO automatic polling to avoid RPC rate-limiting (429 errors)
// Balances refresh only on manual action or after transactions

interface UseVaultBalancesReturn {
  // Encrypted balances (euint128 returned as uint256 - cannot be decrypted without Gateway)
  encryptedETHBalance: bigint | undefined;
  encryptedUSDTBalance: bigint | undefined;
  // Status
  isLoading: boolean;
  hasETHBalance: boolean; // true if balance is non-zero
  hasUSDTBalance: boolean; // true if balance is non-zero
  // Error
  error: string | null;
  // Manual refetch (call after deposit/withdrawal confirmation)
  refetchBalances: () => void;
}

export function useVaultBalances(): UseVaultBalancesReturn {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const contracts = useContractAddresses();

  // Read encrypted ETH balance via getEncryptedBalance(address, isEth=true)
  const {
    data: encryptedETHBalance,
    isLoading: isLoadingETH,
    isFetching: isFetchingETH,
    error: errorETH,
    refetch: refetchETH,
  } = useReadContract({
    abi: NoctisVaultABI,
    address: contracts?.vaultAddress as `0x${string}` | undefined,
    functionName: "getEncryptedBalance",
    args: address ? [address, true] : undefined,
    query: {
      enabled: isConnected && !!address && !!contracts?.vaultAddress,
      refetchOnWindowFocus: false,
    },
  });

  // Read encrypted USDT balance via getEncryptedBalance(address, isEth=false)
  const {
    data: encryptedUSDTBalance,
    isLoading: isLoadingUSDT,
    isFetching: isFetchingUSDT,
    error: errorUSDT,
    refetch: refetchUSDT,
  } = useReadContract({
    abi: NoctisVaultABI,
    address: contracts?.vaultAddress as `0x${string}` | undefined,
    functionName: "getEncryptedBalance",
    args: address ? [address, false] : undefined,
    query: {
      enabled: isConnected && !!address && !!contracts?.vaultAddress,
      refetchOnWindowFocus: false,
    },
  });

  // Check if balances are non-zero
  // euint128 is returned as uint256, zero balance = 0
  const hasETHBalance = encryptedETHBalance
    ? BigInt(encryptedETHBalance) > 0n
    : false;
  const hasUSDTBalance = encryptedUSDTBalance
    ? BigInt(encryptedUSDTBalance) > 0n
    : false;

  const error = errorETH || errorUSDT ? "Failed to load balances" : null;

  // Only show loading state on initial load, not on background refetch
  // This prevents blinking when data is refreshed every 10 seconds
  const isInitialLoading = (isLoadingETH && !encryptedETHBalance) || (isLoadingUSDT && !encryptedUSDTBalance);

  // Manual refetch function for after transaction confirmation
  const refetchBalances = useCallback(() => {
    console.log("🔄 Manual balance refetch triggered");
    refetchETH();
    refetchUSDT();
  }, [refetchETH, refetchUSDT]);

  // Listen for refresh events (triggered after transactions)
  useEffect(() => {
    const handleRefresh = () => {
      console.log("🔄 Balance refetch triggered by event");
      refetchBalances();
    };
    
    window.addEventListener("noctis:refresh-balance", handleRefresh);
    window.addEventListener("noctis:refresh-activity", handleRefresh);
    
    return () => {
      window.removeEventListener("noctis:refresh-balance", handleRefresh);
      window.removeEventListener("noctis:refresh-activity", handleRefresh);
    };
  }, [refetchBalances]);

  return {
    encryptedETHBalance: encryptedETHBalance as bigint | undefined,
    encryptedUSDTBalance: encryptedUSDTBalance as bigint | undefined,
    isLoading: isInitialLoading,
    hasETHBalance,
    hasUSDTBalance,
    error,
    refetchBalances,
  };
}
