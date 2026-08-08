/**
 * useNoctisExchange Hook
 * 
 * Handles interactions with NoctisExchange contract:
 * - Create market orders via relayer (privacy-preserving)
 * - Cancel orders via relayer
 * - Read active orders
 * 
 * PRIVACY: All order operations go through the relayer.
 * User signs EIP-712 messages (no gas), relayer submits on-chain.
 * VaultId used instead of address -- user's identity hidden from calldata.
 */

"use client";

import { useCallback, useMemo } from "react";
import { 
  useAccount, 
  useChainId,
  useWriteContract,
  useReadContract,
  usePublicClient,
} from "wagmi";
import { decodeEventLog } from "viem";
import { NoctisExchangeABI } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";
import { useTransactionState } from "./useTransactionState";
import { useFhevm } from "./useFhevm";
import { useRelayer } from "./useRelayer";

interface CreateOrderParams {
  amountETH: bigint;
  amountUSDT: bigint;
  isBuy: boolean;
  slippageBPS?: number;  // Default: 50 (0.5%)
  maxDeviationBPS?: number; // Default: 150 (1.5%)
}

interface UseNoctisExchangeReturn {
  // Order functions
  createMarketOrder: (params: CreateOrderParams) => Promise<bigint | null>;
  cancelOrder: (orderId: bigint) => Promise<void>;
  // State
  isLoading: boolean;
  error: string | null;
  // FHE status
  isFheReady: boolean;
  // Relayer status
  relayerAvailable: boolean;
  hasVaultId: boolean;
}

export function useNoctisExchange(): UseNoctisExchangeReturn {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { state, setPending, setConfirming, setSuccess, setFailed } = useTransactionState();
  const { isReady: isFheReady } = useFhevm();
  const relayer = useRelayer();
  
  const contracts = useContractAddresses();
  
  const { writeContractAsync, error: writeError } = useWriteContract();
  
  // Parse error message
  const errorMessage = useMemo(() => {
    if (!writeError) return null;
    return writeError.message?.slice(0, 100) || "Transaction failed";
  }, [writeError]);

  // Create market order via relayer (PRIVACY: user signs, relayer submits)
  const createMarketOrder = useCallback(
    async ({ 
      amountETH, 
      amountUSDT, 
      isBuy, 
      slippageBPS = 50,
      maxDeviationBPS = 150 
    }: CreateOrderParams): Promise<bigint | null> => {
      if (!contracts?.exchangeAddress) {
        setFailed("Exchange contract not configured");
        return null;
      }

      try {
        // Use relayer if available (privacy-preserving path)
        if (relayer.relayerStatus.available && relayer.hasVaultId) {
          setPending(1, 1);
          if (process.env.NODE_ENV === 'development') {
            console.log("🔒 Creating order via relayer (privacy mode)...");
          }

          const result = await relayer.signAndCreateOrder({
            amountETH,
            isBuy,
            slippageBPS,
            maxDeviationBPS,
          });

          const orderId = BigInt(result.orderId);
          setSuccess("Order created via relayer! Executing swap...");
          
          window.dispatchEvent(new CustomEvent("noctis:transaction-success", { 
            detail: { type: "order", hash: result.txHash, isBuy, orderId: orderId.toString() } 
          }));

          return orderId;
        }

        // Fallback: direct on-chain call (non-private, for when relayer is down)
        if (!publicClient) {
          setFailed("No public client available");
          return null;
        }

        setPending(1, 1);
        if (process.env.NODE_ENV === 'development') {
          console.log("⚠️ Creating order directly (relayer unavailable, non-private)...");
        }
        
        const hash = await writeContractAsync({
          abi: NoctisExchangeABI,
          address: contracts.exchangeAddress as `0x${string}`,
          functionName: "createMarketOrder",
          args: [amountETH, isBuy, slippageBPS, maxDeviationBPS],
          gas: 2_000_000n,
        });
        
        setConfirming(hash);

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });

        if (receipt.status !== "success") {
          setFailed("Transaction reverted");
          return null;
        }

        let orderId: bigint | null = null;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: NoctisExchangeABI,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === "OrderCreated") {
              orderId = (decoded.args as any).orderId;
              break;
            }
          } catch { /* skip */ }
        }

        if (!orderId) {
          setFailed("Could not find order ID in transaction logs");
          return null;
        }

        setSuccess("Order created! Executing swap...");
        
        window.dispatchEvent(new CustomEvent("noctis:transaction-success", { 
          detail: { type: "order", hash, isBuy, orderId: orderId.toString() } 
        }));

        return orderId;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Order creation failed";
        console.error("Order creation failed:", err);
        setFailed(message.slice(0, 100));
        return null;
      }
    },
    [contracts, publicClient, writeContractAsync, relayer, isFheReady, setPending, setConfirming, setSuccess, setFailed]
  );

  // Cancel order via relayer
  const cancelOrder = useCallback(
    async (orderId: bigint) => {
      if (!contracts?.exchangeAddress) {
        setFailed("Exchange contract not configured");
        return;
      }

      try {
        // Use relayer if available
        if (relayer.relayerStatus.available && relayer.hasVaultId) {
          setPending();
          const result = await relayer.signAndCancelOrder({ orderId });
          setSuccess("Order cancelled via relayer");
          
          window.dispatchEvent(new CustomEvent("noctis:transaction-success", { 
            detail: { type: "cancel_order", hash: result.txHash, orderId } 
          }));
          return;
        }

        // Fallback: direct call
        setPending();
        
        const hash = await writeContractAsync({
          abi: NoctisExchangeABI,
          address: contracts.exchangeAddress as `0x${string}`,
          functionName: "cancelOrder",
          args: [orderId],
        });
        
        setConfirming(hash);
        setSuccess("Order cancelled successfully");
        
        window.dispatchEvent(new CustomEvent("noctis:transaction-success", { 
          detail: { type: "cancel_order", hash, orderId } 
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Cancellation failed";
        setFailed(message.slice(0, 100));
      }
    },
    [contracts, writeContractAsync, relayer, setPending, setConfirming, setSuccess, setFailed]
  );

  return {
    createMarketOrder,
    cancelOrder,
    isLoading: state.status === "pending" || state.status === "confirming",
    error: errorMessage,
    isFheReady,
    relayerAvailable: relayer.relayerStatus.available,
    hasVaultId: relayer.hasVaultId,
  };
}
