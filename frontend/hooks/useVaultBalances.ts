/**
 * useVaultBalances Hook (V2 — multi-token)
 *
 * Reads encrypted balance handles from NoctisVaultV2 for every supported
 * token (address(0) = native ETH). Handles are opaque bytes32 — a non-zero
 * handle means the balance slot was initialized (deposited at least once).
 *
 * Updates on:
 * - noctis:refresh-balance / noctis:refresh-activity events
 * - Manual refetch calls
 * NO automatic polling to avoid RPC rate-limiting (429 errors).
 */

"use client";

import { useAccount, useReadContracts } from "wagmi";
import { useEffect, useCallback, useMemo } from "react";
import { NoctisVaultABI } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";
import { useTokenRegistry } from "./useTokenRegistry";

const ZERO_HANDLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

interface UseVaultBalancesReturn {
  /** token address (lowercase) → encrypted balance handle (bytes32) */
  balanceHandles: Record<string, `0x${string}` | undefined>;
  /** True when the token's encrypted balance slot is initialized */
  hasBalance: (tokenAddress: string | undefined | null) => boolean;
  isLoading: boolean;
  error: string | null;
  /** Manual refetch (call after deposit/withdrawal confirmation) */
  refetchBalances: () => void;
}

export function useVaultBalances(): UseVaultBalancesReturn {
  const { address, isConnected } = useAccount();
  const contracts = useContractAddresses();
  const { supportedTokens } = useTokenRegistry();

  const vaultAddress = contracts?.vaultAddress as `0x${string}` | undefined;

  const { data, isLoading, error, refetch } = useReadContracts({
    contracts: supportedTokens.map((token) => ({
      abi: NoctisVaultABI,
      address: vaultAddress,
      functionName: "getEncryptedBalance" as const,
      args: [address as `0x${string}`, token.address] as const,
    })),
    query: {
      enabled:
        isConnected &&
        !!address &&
        !!vaultAddress &&
        supportedTokens.length > 0,
      refetchOnWindowFocus: false,
    },
  });

  const balanceHandles = useMemo(() => {
    const map: Record<string, `0x${string}` | undefined> = {};
    supportedTokens.forEach((token, index) => {
      const result = data?.[index];
      map[token.address.toLowerCase()] =
        result?.status === "success" ? (result.result as `0x${string}`) : undefined;
    });
    return map;
  }, [supportedTokens, data]);

  const hasBalance = useCallback(
    (tokenAddress: string | undefined | null): boolean => {
      if (!tokenAddress) return false;
      const handle = balanceHandles[tokenAddress.toLowerCase()];
      return Boolean(handle && handle !== ZERO_HANDLE);
    },
    [balanceHandles]
  );

  // Manual refetch function for after transaction confirmation
  const refetchBalances = useCallback(() => {
    console.log("🔄 Manual balance refetch triggered");
    refetch();
  }, [refetch]);

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
    balanceHandles,
    hasBalance,
    isLoading,
    error: error ? "Failed to load balances" : null,
    refetchBalances,
  };
}
