/**
 * Hook to check withdrawal cancellation eligibility
 * 
 * Reads on-chain state to determine:
 * - Whether a withdrawal can be cancelled immediately
 * - Time remaining until cancellation is allowed
 */

import { useEffect, useState, useCallback } from "react";
import { usePublicClient } from "wagmi";
import { useContractAddresses } from "@/lib/wagmi";
import { NoctisVaultABI } from "@/lib/contracts/abi";

// 1 hour timeout for gateway-requested withdrawals
const DECRYPTION_TIMEOUT = 3600;

export interface WithdrawalStatus {
  requestId: string;
  executed: boolean;
  gatewayRequested: boolean;
  gatewayRequestTime: number;
  canCancel: boolean;
  timeUntilCancellable: number; // seconds, 0 if can cancel now
  isLoading: boolean;
}

export function useWithdrawalStatus(requestIds: string[]): Map<string, WithdrawalStatus> {
  const publicClient = usePublicClient();
  const contracts = useContractAddresses();
  const [statuses, setStatuses] = useState<Map<string, WithdrawalStatus>>(new Map());

  const fetchStatus = useCallback(async (requestId: string): Promise<WithdrawalStatus> => {
    const defaultStatus: WithdrawalStatus = {
      requestId,
      executed: false,
      gatewayRequested: false,
      gatewayRequestTime: 0,
      canCancel: true,
      timeUntilCancellable: 0,
      isLoading: false,
    };

    if (!publicClient || !contracts?.vaultAddress) {
      return { ...defaultStatus, isLoading: true };
    }

    try {
      const numericId = requestId.replace("withdrawal-", "");

      // V2: getWithdrawalRequest returns the WithdrawalRequest struct
      const request = await publicClient.readContract({
        address: contracts.vaultAddress as `0x${string}`,
        abi: NoctisVaultABI,
        functionName: "getWithdrawalRequest",
        args: [BigInt(numericId)],
      }) as {
        executed: boolean;
        decryptionRequested: boolean;
        decryptionRequestTime: bigint;
      };

      const executed = request.executed;
      const gatewayRequested = request.decryptionRequested;
      const gatewayRequestTime = Number(request.decryptionRequestTime ?? 0);
      
      const now = Math.floor(Date.now() / 1000);
      
      let canCancel = true;
      let timeUntilCancellable = 0;
      
      if (executed) {
        // Already executed or cancelled
        canCancel = false;
      } else if (gatewayRequested) {
        // Gateway was requested - need to wait for timeout
        const cancelableAt = gatewayRequestTime + DECRYPTION_TIMEOUT;
        if (now < cancelableAt) {
          canCancel = false;
          timeUntilCancellable = cancelableAt - now;
        }
      }
      // If gatewayRequested is false and not executed, can cancel immediately

      return {
        requestId,
        executed,
        gatewayRequested,
        gatewayRequestTime,
        canCancel,
        timeUntilCancellable,
        isLoading: false,
      };
    } catch (err) {
      console.error(`Error fetching withdrawal status for ${requestId}:`, err);
      return { ...defaultStatus, isLoading: false };
    }
  }, [publicClient, contracts?.vaultAddress]);

  // Stable key so the effect only re-runs when the set of IDs changes
  const requestIdsKey = requestIds.join(",");

  useEffect(() => {
    if (!requestIdsKey) return;
    const ids = requestIdsKey.split(",");

    const fetchAllStatuses = async () => {
      const newStatuses = new Map<string, WithdrawalStatus>();

      await Promise.all(
        ids.map(async (id) => {
          const status = await fetchStatus(id);
          newStatuses.set(id, status);
        })
      );

      setStatuses(newStatuses);
    };

    fetchAllStatuses();

    // Refresh every 30 seconds to update countdown
    const interval = setInterval(fetchAllStatuses, 30000);
    return () => clearInterval(interval);
  }, [requestIdsKey, fetchStatus]);

  return statuses;
}

/**
 * Format seconds into human-readable time
 */
export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return "now";
  
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (hours > 0) {
    return `${hours}h ${remainingMinutes}m`;
  }
  return `${minutes}m`;
}
