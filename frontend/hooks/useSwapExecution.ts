/**
 * useSwapExecution — privacy-first swap (testnet-ready vs Phase 1+ deduct API)
 *
 * SELL (1 proof):
 *   requestSwapExecution → publicDecrypt([amount, sufficiency]) → executeSwapCallback
 *
 * BUY (2 proofs):
 *   request → decrypt amount → executeSwapCallback (prepares USDC lock)
 *   → BuySufficiencyReady → decrypt ebool → finalizeBuySwap (user tx; not relayer)
 *
 * V2: multi-token — routing (direct pool vs via WETH) is resolved on-chain per
 * baseToken; there is no poolFee parameter anymore.
 */

"use client";

import { useCallback, useState } from "react";
import {
  useAccount,
  useWriteContract,
  usePublicClient,
} from "wagmi";
import { decodeEventLog, type Hash, type PublicClient } from "viem";
import { NoctisExchangeABI, NATIVE_TOKEN } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";
import {
  UNISWAP_V2_ROUTER,
  WETH,
  USDC,
  UNISWAP_ROUTER_ABI,
} from "@/lib/uniswapSepolia";
import { useTransactionState } from "./useTransactionState";
import { useFhevm } from "./useFhevm";
import { useRelayer } from "./useRelayer";

/**
 * BUY debit is oracle-sized (Chainlink) but fill is Uniswap V2.
 * On thin Sepolia pools those diverge — minAmountOut must use the pool quote
 * of the actual usdcNeeded, not the UI/oracle base-token target.
 * Path mirrors the contract: USDC→WETH for native ETH, USDC→WETH→base when
 * routed via WETH, USDC→base otherwise.
 */
async function quoteBaseOutForUsdc(
  publicClient: PublicClient,
  usdcAmount: bigint,
  baseToken: `0x${string}`,
  routeViaWeth: boolean
): Promise<bigint | null> {
  if (usdcAmount <= 0n) return null;
  const isNative = baseToken.toLowerCase() === NATIVE_TOKEN;
  const path: `0x${string}`[] = isNative
    ? [USDC, WETH]
    : routeViaWeth
      ? [USDC, WETH, baseToken]
      : [USDC, baseToken];
  try {
    const amounts = await publicClient.readContract({
      address: UNISWAP_V2_ROUTER,
      abi: UNISWAP_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [usdcAmount, path],
    });
    return amounts?.[amounts.length - 1] ?? null;
  } catch (e) {
    console.warn("BUY Uniswap quote failed:", e);
    return null;
  }
}

interface SwapExecutionState {
  orderId: bigint | null;
  handles: string[];
  amount: bigint | null;
  cleartexts: `0x${string}` | null;
  proof: `0x${string}` | null;
  step:
    | "idle"
    | "requesting"
    | "decrypting"
    | "executing"
    | "finalizing"
    | "complete"
    | "error";
}

interface UseSwapExecutionOptions {
  onSwapSuccess?: () => void;
  onSwapError?: (error: string) => void;
}

interface DecryptProof {
  amount: bigint;
  hasSufficient: boolean | null;
  cleartexts: `0x${string}`;
  proof: `0x${string}`;
}

interface UseSwapExecutionReturn {
  /** isBuy as 3rd arg matches SwapCard */
  executeFullSwap: (
    orderId: bigint,
    minAmountOut: bigint,
    isBuy?: boolean
  ) => Promise<boolean>;
  requestSwapExecution: (orderId: bigint) => Promise<string[] | null>;
  decryptAmount: (handles: string[]) => Promise<DecryptProof | null>;
  executeSwap: (
    orderId: bigint,
    cleartexts: `0x${string}`,
    proof: `0x${string}`,
    minAmountOut: bigint
  ) => Promise<boolean>;
  /** Unlock a stuck PendingSwap (BUY step-1 done / failed finalize). */
  cancelSwapExecution: (orderId: bigint) => Promise<boolean>;
  swapState: SwapExecutionState;
  isLoading: boolean;
  error: string | null;
  reset: () => void;
}

const isDev = process.env.NODE_ENV === "development";
const log = (...args: unknown[]) => {
  if (isDev) console.log(...args);
};
const logError = (...args: unknown[]) => {
  if (isDev) console.error(...args);
};

/** SDK may return handle keys with different hex casing than event handles. */
function lookupClearValue(
  clearValues: Record<string, bigint | boolean>,
  handle: string
): bigint | boolean | undefined {
  if (Object.prototype.hasOwnProperty.call(clearValues, handle)) {
    return clearValues[handle];
  }
  const lower = handle.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(clearValues, lower)) {
    return clearValues[lower];
  }
  const entry = Object.entries(clearValues).find(
    ([k]) => k.toLowerCase() === lower
  );
  return entry?.[1];
}

async function gatewayDecryptWithRetry(
  publicDecryptWithProof: (
    handles: string[],
    contractAddress: string
  ) => Promise<{
    clearValues: Record<string, bigint | boolean>;
    abiEncodedClearValues: string;
    decryptionProof: string;
  } | null>,
  handles: string[],
  contractAddress: string
) {
  const delays = [15_000, 20_000, 30_000, 45_000, 60_000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    log(
      `Waiting ${delays[attempt] / 1000}s for Gateway... (attempt ${attempt + 1}/${delays.length})`
    );
    await new Promise((r) => setTimeout(r, delays[attempt]));
    try {
      const result = await publicDecryptWithProof(handles, contractAddress);
      if (result) return result;
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("not allowed for public decryption") && attempt < delays.length - 1) {
        continue;
      }
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

function extractSwapHandles(
  logs: readonly { data: `0x${string}`; topics: readonly `0x${string}`[] | `0x${string}`[] }[]
): string[] {
  for (const logEntry of logs) {
    try {
      const decoded = decodeEventLog({
        abi: NoctisExchangeABI,
        data: logEntry.data,
        topics: logEntry.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName === "SwapDecryptionReady") {
        const eventHandles = (
          decoded.args as unknown as { handles: readonly `0x${string}`[] }
        ).handles;
        return [...eventHandles];
      }
    } catch {
      /* not this event */
    }
  }
  return [];
}

function extractBuySufficiency(
  logs: readonly { data: `0x${string}`; topics: readonly `0x${string}`[] | `0x${string}`[] }[]
): { sufficiencyHandle: string; usdcNeeded: bigint } | null {
  for (const logEntry of logs) {
    try {
      const decoded = decodeEventLog({
        abi: NoctisExchangeABI,
        data: logEntry.data,
        topics: logEntry.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName === "BuySufficiencyReady") {
        const args = decoded.args as {
          sufficiencyHandle: `0x${string}`;
          usdcNeeded: bigint;
        };
        return {
          sufficiencyHandle: args.sufficiencyHandle,
          usdcNeeded: args.usdcNeeded,
        };
      }
    } catch {
      /* not this event */
    }
  }
  return null;
}

export function useSwapExecution(options?: UseSwapExecutionOptions): UseSwapExecutionReturn {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { setPending, setConfirming, setSuccess, setFailed, reset: resetTxState, state } =
    useTransactionState();
  const { publicDecryptWithProof, isReady: fhevmReady } = useFhevm();
  const relayer = useRelayer();

  const contracts = useContractAddresses();
  const { writeContractAsync } = useWriteContract();

  const [swapState, setSwapState] = useState<SwapExecutionState>({
    orderId: null,
    handles: [],
    amount: null,
    cleartexts: null,
    proof: null,
    step: "idle",
  });

  const reset = useCallback(() => {
    setSwapState({
      orderId: null,
      handles: [],
      amount: null,
      cleartexts: null,
      proof: null,
      step: "idle",
    });
    resetTxState();
  }, [resetTxState]);

  const resolveIsBuy = useCallback(
    async (orderId: bigint, hint?: boolean): Promise<boolean> => {
      if (typeof hint === "boolean") return hint;
      if (!publicClient || !contracts?.exchangeAddress || !address) {
        throw new Error("Cannot resolve order direction");
      }
      try {
        const order = (await publicClient.readContract({
          abi: NoctisExchangeABI,
          address: contracts.exchangeAddress as `0x${string}`,
          functionName: "getMyOrder",
          args: [orderId],
          account: address,
        })) as unknown as { isBuy: boolean };
        return Boolean(order.isBuy);
      } catch {
        const pub = (await publicClient.readContract({
          abi: NoctisExchangeABI,
          address: contracts.exchangeAddress as `0x${string}`,
          functionName: "getOrderPublic",
          args: [orderId],
        })) as unknown as readonly [boolean, `0x${string}`, boolean, number, bigint];
        // V2 getOrderPublic → (exists, baseToken, isBuy, status, timestamp)
        return Boolean(pub[2]);
      }
    },
    [publicClient, contracts, address]
  );

  /** BaseToken + routing of an order — used to re-quote the BUY pool floor. */
  const resolveOrderRoute = useCallback(
    async (
      orderId: bigint
    ): Promise<{ baseToken: `0x${string}`; routeViaWeth: boolean } | null> => {
      if (!publicClient || !contracts?.exchangeAddress) return null;
      try {
        const pub = (await publicClient.readContract({
          abi: NoctisExchangeABI,
          address: contracts.exchangeAddress as `0x${string}`,
          functionName: "getOrderPublic",
          args: [orderId],
        })) as unknown as readonly [boolean, `0x${string}`, boolean, number, bigint];
        const baseToken = pub[1];
        let routeViaWeth = false;
        if (baseToken.toLowerCase() !== NATIVE_TOKEN) {
          const cfg = (await publicClient.readContract({
            abi: NoctisExchangeABI,
            address: contracts.exchangeAddress as `0x${string}`,
            functionName: "tradeConfigs",
            args: [baseToken],
          })) as unknown as readonly [boolean, `0x${string}`, number, boolean, bigint, bigint, bigint, bigint];
          routeViaWeth = Boolean(cfg[3]);
        }
        return { baseToken, routeViaWeth };
      } catch {
        return null;
      }
    },
    [publicClient, contracts]
  );

  const requestSwapExecution = useCallback(
    async (orderId: bigint): Promise<string[] | null> => {
      if (!contracts?.exchangeAddress) {
        setFailed("Exchange contract not configured");
        return null;
      }
      if (!publicClient) {
        setFailed("No public client available");
        return null;
      }

      try {
        setSwapState((prev) => ({ ...prev, orderId, step: "requesting" }));
        setPending(1, 4);

        let handles: string[] = [];

        if (relayer.relayerStatus.available && relayer.hasVaultId) {
          log("Requesting swap via relayer...");
          const result = await relayer.signAndRequestSwap({ orderId });
          handles = result.handles || [];
        } else {
          log("Requesting swap directly...");
          const hash = await writeContractAsync({
            abi: NoctisExchangeABI,
            address: contracts.exchangeAddress as `0x${string}`,
            functionName: "requestSwapExecution",
            args: [orderId],
            gas: 2_500_000n,
          });
          setConfirming(hash);
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
          });
          if (receipt.status !== "success") {
            setFailed("Request execution transaction reverted");
            setSwapState((prev) => ({ ...prev, step: "error" }));
            return null;
          }
          handles = extractSwapHandles(receipt.logs);
        }

        if (handles.length === 0) {
          setFailed("No decryption handles in SwapDecryptionReady (redeploy / ABI mismatch?)");
          setSwapState((prev) => ({ ...prev, step: "error" }));
          return null;
        }

        log(`Got ${handles.length} handle(s)`);
        setSwapState((prev) => ({ ...prev, handles, step: "decrypting" }));
        return handles;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed";
        logError("Request swap execution error:", err);
        setFailed(message.slice(0, 120));
        setSwapState((prev) => ({ ...prev, step: "error" }));
        return null;
      }
    },
    [
      contracts,
      publicClient,
      writeContractAsync,
      relayer,
      setPending,
      setConfirming,
      setFailed,
    ]
  );

  const decryptAmount = useCallback(
    async (handles: string[]): Promise<DecryptProof | null> => {
      if (!contracts?.exchangeAddress) {
        setFailed("Exchange contract not configured");
        return null;
      }
      if (!fhevmReady) {
        setFailed("FHEVM not ready");
        return null;
      }

      try {
        setPending(2, 4);
        log(`Decrypting ${handles.length} handle(s) via Gateway...`);

        const decryptResult = await gatewayDecryptWithRetry(
          publicDecryptWithProof,
          handles,
          contracts.exchangeAddress
        );

        if (!decryptResult) {
          setFailed("Gateway decryption failed after retries");
          setSwapState((prev) => ({ ...prev, step: "error" }));
          return null;
        }

        const amountHandle = handles[0];
        const amountRaw = lookupClearValue(decryptResult.clearValues, amountHandle);
        if (amountRaw === undefined) {
          setFailed("Decrypt succeeded but amount handle missing from clearValues");
          setSwapState((prev) => ({ ...prev, step: "error" }));
          return null;
        }
        const amount =
          typeof amountRaw === "bigint" ? amountRaw : BigInt(String(amountRaw));

        let hasSufficient: boolean | null = null;
        if (handles.length >= 2) {
          const suffRaw = lookupClearValue(decryptResult.clearValues, handles[1]);
          if (suffRaw === undefined) {
            setFailed("Decrypt succeeded but sufficiency handle missing from clearValues");
            setSwapState((prev) => ({ ...prev, step: "error" }));
            return null;
          }
          hasSufficient = Boolean(suffRaw);
          if (!hasSufficient) {
            setFailed("Insufficient encrypted balance for this swap");
            setSwapState((prev) => ({ ...prev, step: "error" }));
            return null;
          }
        }

        const cleartexts = decryptResult.abiEncodedClearValues as `0x${string}`;
        const proof = decryptResult.decryptionProof as `0x${string}`;

        setSwapState((prev) => ({
          ...prev,
          amount,
          cleartexts,
          proof,
          step: "executing",
        }));

        return { amount, hasSufficient, cleartexts, proof };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Decryption failed";
        logError("Decrypt error:", err);
        setFailed(message.slice(0, 120));
        setSwapState((prev) => ({ ...prev, step: "error" }));
        return null;
      }
    },
    [contracts, fhevmReady, publicDecryptWithProof, setPending, setFailed]
  );

  const finalizeBuy = useCallback(
    async (
      orderId: bigint,
      sufficiencyHandle: string,
      minAmountOut: bigint
    ): Promise<boolean> => {
      if (!contracts?.exchangeAddress || !publicClient) {
        setFailed("Exchange / client not ready");
        return false;
      }
      if (!fhevmReady) {
        setFailed("FHEVM not ready");
        return false;
      }

      try {
        setSwapState((prev) => ({ ...prev, step: "finalizing" }));
        setPending(4, 4);
        log("BUY finalize: decrypting USDC sufficiency ebool...");

        // Sufficiency ebool was makePubliclyDecryptable by the Vault
        const vaultAddr = contracts.vaultAddress || contracts.exchangeAddress;
        let decryptResult = await gatewayDecryptWithRetry(
          publicDecryptWithProof,
          [sufficiencyHandle],
          vaultAddr
        );
        if (!decryptResult) {
          decryptResult = await gatewayDecryptWithRetry(
            publicDecryptWithProof,
            [sufficiencyHandle],
            contracts.exchangeAddress
          );
        }
        if (!decryptResult) {
          setFailed("BUY sufficiency decrypt failed");
          setSwapState((prev) => ({ ...prev, step: "error" }));
          return false;
        }

        const suffRaw = lookupClearValue(
          decryptResult.clearValues,
          sufficiencyHandle
        );
        if (suffRaw === undefined) {
          setFailed("BUY sufficiency handle missing from clearValues");
          setSwapState((prev) => ({ ...prev, step: "error" }));
          return false;
        }
        if (!Boolean(suffRaw)) {
          setFailed("Insufficient USDC balance for buy");
          setSwapState((prev) => ({ ...prev, step: "error" }));
          return false;
        }

        // Must be user tx — finalizeBuySwap checks order owner == msg.sender
        const hash = await writeContractAsync({
          abi: NoctisExchangeABI,
          address: contracts.exchangeAddress as `0x${string}`,
          functionName: "finalizeBuySwap",
          args: [
            orderId,
            decryptResult.abiEncodedClearValues as `0x${string}`,
            decryptResult.decryptionProof as `0x${string}`,
            minAmountOut,
          ],
          gas: 4_000_000n,
        });
        setConfirming(hash);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
          timeout: 180_000,
        });
        if (receipt.status !== "success") {
          setFailed(
            "BUY failed: pool output below oracle floor (thin Sepolia Uniswap). Cancel the pending swap, then retry a smaller size or Sell."
          );
          setSwapState((prev) => ({ ...prev, step: "error" }));
          return false;
        }

        setSuccess("Buy swap completed! Balance updated.");
        setSwapState((prev) => ({ ...prev, step: "complete" }));
        window.dispatchEvent(
          new CustomEvent("noctis:transaction-success", {
            detail: { type: "swap", hash },
          })
        );
        options?.onSwapSuccess?.();
        return true;
      } catch (err) {
        const raw = err instanceof Error ? err.message : "BUY finalize failed";
        const message = /INSUFFICIENT_OUTPUT_AMOUNT/i.test(raw)
          ? "BUY failed: Uniswap output below oracle floor (Sepolia pool too thin vs Chainlink). Cancel pending swap to unlock USDC."
          : raw.slice(0, 160);
        logError("finalizeBuy error:", err);
        setFailed(message);
        setSwapState((prev) => ({ ...prev, step: "error" }));
        options?.onSwapError?.(message);
        return false;
      }
    },
    [
      contracts,
      publicClient,
      fhevmReady,
      publicDecryptWithProof,
      writeContractAsync,
      setPending,
      setConfirming,
      setSuccess,
      setFailed,
      options,
    ]
  );

  const cancelSwapExecution = useCallback(
    async (orderId: bigint): Promise<boolean> => {
      if (!contracts?.exchangeAddress || !publicClient) {
        setFailed("Exchange / client not ready");
        return false;
      }
      try {
        setPending(1, 1, "Cancel pending swap...");
        const hash = await writeContractAsync({
          abi: NoctisExchangeABI,
          address: contracts.exchangeAddress as `0x${string}`,
          functionName: "cancelSwapExecution",
          args: [orderId],
          gas: 500_000n,
        });
        setConfirming(hash);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
          timeout: 120_000,
        });
        if (receipt.status !== "success") {
          setFailed("cancelSwapExecution reverted");
          return false;
        }
        setSuccess("Pending swap cancelled — USDC lock released");
        setSwapState((prev) => ({ ...prev, step: "idle", orderId: null }));
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Cancel failed";
        setFailed(message.slice(0, 120));
        return false;
      }
    },
    [
      contracts,
      publicClient,
      writeContractAsync,
      setPending,
      setConfirming,
      setSuccess,
      setFailed,
    ]
  );

  const executeSwap = useCallback(
    async (
      orderId: bigint,
      cleartexts: `0x${string}`,
      proof: `0x${string}`,
      minAmountOut: bigint,
      isBuy: boolean = false,
      /** Prefer decrypted amount from this turn — swapState.amount may still be stale. */
      decryptedAmount?: bigint | null
    ): Promise<boolean> => {
      if (!contracts?.exchangeAddress || !publicClient) {
        setFailed("Exchange / client not ready");
        return false;
      }

      const swapAmount = decryptedAmount ?? swapState.amount;

      try {
        setPending(3, 4);
        log(isBuy ? "BUY step 1: prepare sufficiency..." : "SELL: execute swap...");

        let buySuff: { sufficiencyHandle: string; usdcNeeded: bigint } | null = null;

        if (
          !isBuy &&
          relayer.relayerStatus.available &&
          relayer.hasVaultId &&
          swapAmount != null
        ) {
          const result = await relayer.signAndExecuteSwap({
            orderId,
            amount: swapAmount,
            minAmountOut,
            cleartexts,
            decryptionProof: proof,
          });
          log("SELL via relayer:", result.txHash);
          setSuccess("Swap completed! Your balance has been updated.");
          setSwapState((prev) => ({ ...prev, step: "complete" }));
          window.dispatchEvent(
            new CustomEvent("noctis:transaction-success", {
              detail: { type: "swap", hash: result.txHash },
            })
          );
          options?.onSwapSuccess?.();
          return true;
        }

        // Direct callback (SELL complete, or BUY prepare). Relayer BUY also returns early —
        // prefer direct so we can parse BuySufficiencyReady from the same receipt.
        if (isBuy && relayer.relayerStatus.available && relayer.hasVaultId && swapAmount != null) {
          const result = await relayer.signAndExecuteSwap({
            orderId,
            amount: swapAmount,
            minAmountOut,
            cleartexts,
            decryptionProof: proof,
          });
          const handle =
            result.buySufficiencyHandle || result.sufficiencyHandle;
          if (handle) {
            buySuff = {
              sufficiencyHandle: handle,
              usdcNeeded: BigInt(result.usdcNeeded || 0),
            };
          } else if (publicClient) {
            const receipt = await publicClient.getTransactionReceipt({
              hash: result.txHash as Hash,
            });
            buySuff = extractBuySufficiency(receipt.logs);
          }
        } else {
          const hash = await writeContractAsync({
            abi: NoctisExchangeABI,
            address: contracts.exchangeAddress as `0x${string}`,
            functionName: "executeSwapCallback",
            args: [orderId, cleartexts, proof, minAmountOut],
            gas: 4_000_000n,
          });
          setConfirming(hash);
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
            timeout: 180_000,
          });
          if (receipt.status !== "success") {
            setFailed("Swap callback reverted");
            setSwapState((prev) => ({ ...prev, step: "error" }));
            return false;
          }
          if (isBuy) {
            buySuff = extractBuySufficiency(receipt.logs);
          } else {
            setSuccess("Swap completed! Your balance has been updated.");
            setSwapState((prev) => ({ ...prev, step: "complete" }));
            window.dispatchEvent(
              new CustomEvent("noctis:transaction-success", {
                detail: { type: "swap", hash },
              })
            );
            options?.onSwapSuccess?.();
            return true;
          }
        }

        if (isBuy) {
          if (!buySuff?.sufficiencyHandle) {
            setFailed("BuySufficiencyReady not found — check Exchange deploy");
            setSwapState((prev) => ({ ...prev, step: "error" }));
            return false;
          }
          log("USDC needed (clear at prepare):", buySuff.usdcNeeded.toString());

          // Re-quote Uniswap for the oracle-locked USDC.
          // On-chain floor is still oracle-based (max 3% slip) — if the pool
          // cannot clear that floor, do not send finalizeBuySwap (saves gas).
          let buyMinOut = minAmountOut;
          const route = await resolveOrderRoute(orderId);
          if (route) {
            const quoted = await quoteBaseOutForUsdc(
              publicClient,
              buySuff.usdcNeeded,
              route.baseToken,
              route.routeViaWeth
            );
            if (quoted != null && quoted > 0n) {
              const poolFloor = (quoted * 9800n) / 10000n;
              buyMinOut = minAmountOut > 0n && minAmountOut <= poolFloor
                ? minAmountOut
                : poolFloor;
              log(
                "BUY minAmountOut from pool quote:",
                buyMinOut.toString(),
                "(quoted",
                quoted.toString(),
                "uiMin",
                minAmountOut.toString(),
                ")"
              );
            }
          }

          return finalizeBuy(
            orderId,
            buySuff.sufficiencyHandle,
            buyMinOut
          );
        }

        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Swap execution failed";
        logError("Execute swap error:", err);
        setFailed(message.slice(0, 120));
        setSwapState((prev) => ({ ...prev, step: "error" }));
        options?.onSwapError?.(message);
        return false;
      }
    },
    [
      contracts,
      publicClient,
      writeContractAsync,
      relayer,
      swapState.amount,
      finalizeBuy,
      resolveOrderRoute,
      setPending,
      setConfirming,
      setSuccess,
      setFailed,
      options,
    ]
  );

  const executeFullSwap = useCallback(
    async (
      orderId: bigint,
      minAmountOut: bigint,
      isBuyHint?: boolean
    ): Promise<boolean> => {
      try {
        const isBuy = await resolveIsBuy(orderId, isBuyHint);
        log(isBuy ? "Full BUY flow" : "Full SELL flow");

        const handles = await requestSwapExecution(orderId);
        if (!handles) return false;

        // SELL expects 2 handles; BUY expects 1
        if (!isBuy && handles.length < 2) {
          setFailed("SELL needs amount + sufficiency handles — redeploy Exchange?");
          return false;
        }

        const decryptResult = await decryptAmount(handles);
        if (!decryptResult) return false;

        return executeSwap(
          orderId,
          decryptResult.cleartexts,
          decryptResult.proof,
          minAmountOut,
          isBuy,
          decryptResult.amount
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Swap failed";
        setFailed(message.slice(0, 120));
        options?.onSwapError?.(message);
        return false;
      }
    },
    [
      resolveIsBuy,
      requestSwapExecution,
      decryptAmount,
      executeSwap,
      setFailed,
      options,
    ]
  );

  return {
    executeFullSwap,
    requestSwapExecution,
    decryptAmount,
    executeSwap: (orderId, cleartexts, proof, minAmountOut) =>
      executeSwap(orderId, cleartexts, proof, minAmountOut, false, undefined),
    cancelSwapExecution,
    swapState,
    isLoading: state.status === "pending" || state.status === "confirming",
    error: state.error ?? null,
    reset,
  };
}
