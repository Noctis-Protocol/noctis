/**
 * useTradeHistoryDecryption — Approach B (V2 — multi-token)
 *
 * Privately decrypt order size / fill handles via FHE userDecrypt.
 * Effective fill price (USDC per base token) derived from both legs when available.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { formatUnits, parseAbiItem, type Address } from "viem";
import { useContractAddresses } from "@/lib/wagmi";
import { NoctisExchangeABI, NATIVE_TOKEN } from "@/lib/contracts/abi";
import { USDC } from "@/lib/uniswapSepolia";
import { useFhevm } from "./useFhevm";
import { useTokenRegistry } from "./useTokenRegistry";

const CACHE_KEY = "noctis_trade_history_v3";
/** Lower bound for V2 log scans (V1 exchange start — V2 is later). */
const EXCHANGE_START_BLOCK = 11446917n;

const ORDER_FILLED_PRIVATE = parseAbiItem(
  "event OrderFilledPrivate(uint256 indexed orderId, bytes32 encryptedAmountIn, bytes32 encryptedAmountOut)"
);

const ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface RevealedTrade {
  orderId: string;
  isBuy: boolean;
  /** Base token of the pair (address(0) = native ETH) */
  baseToken: string;
  baseSymbol: string;
  baseDecimals: number;
  /** Order size in raw base units */
  amountBaseRaw: string;
  formattedBase: string;
  amountOutRaw?: string;
  formattedOut?: string;
  outSymbol?: string;
  /** USDC spent on BUY fills (from public Transfer in fill tx) */
  usdcInRaw?: string;
  formattedUsdcIn?: string;
  /** Effective USDC per 1 base token */
  priceUsd?: number;
  formattedPrice?: string;
  displayAmount: string;
  displayToken: string;
  /** Short price line for Activity */
  priceLabel?: string;
  fillTxHash?: string;
}

interface CacheFile {
  [orderId: string]: RevealedTrade;
}

function cacheKey(exchange: string, user: string): string {
  return `${CACHE_KEY}_${exchange.toLowerCase()}_${user.toLowerCase()}`;
}

function loadCache(exchange: string, user: string): CacheFile {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(cacheKey(exchange, user));
    return raw ? (JSON.parse(raw) as CacheFile) : {};
  } catch {
    return {};
  }
}

function saveCache(exchange: string, user: string, data: CacheFile) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(cacheKey(exchange, user), JSON.stringify(data));
  } catch {
    // ignore quota
  }
}

function formatBaseAmount(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toFixed(6);
}

function formatUsdcAmount(raw: bigint): string {
  const s = formatUnits(raw, 6);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

function formatPrice(price: number): string {
  return price.toLocaleString(undefined, {
    maximumFractionDigits: price >= 100 ? 0 : 2,
  });
}

function buildDisplay(trade: {
  isBuy: boolean;
  baseSymbol: string;
  formattedBase: string;
  formattedOut?: string;
  outSymbol?: string;
  formattedUsdcIn?: string;
  priceUsd?: number;
}): Pick<
  RevealedTrade,
  "displayAmount" | "displayToken" | "formattedPrice" | "priceLabel"
> {
  const formattedPrice =
    trade.priceUsd != null && trade.priceUsd > 0
      ? formatPrice(trade.priceUsd)
      : undefined;
  const priceLabel = formattedPrice ? `$${formattedPrice}` : undefined;

  if (trade.isBuy) {
    if (trade.formattedUsdcIn && trade.formattedOut) {
      return {
        displayAmount: `${trade.formattedUsdcIn} USDC → ${trade.formattedOut} ${trade.baseSymbol}`,
        displayToken: "",
        formattedPrice,
        priceLabel,
      };
    }
    if (trade.formattedOut) {
      return {
        displayAmount: trade.formattedOut,
        displayToken: trade.baseSymbol,
        formattedPrice,
        priceLabel,
      };
    }
    return {
      displayAmount: trade.formattedBase,
      displayToken: trade.baseSymbol,
      formattedPrice,
      priceLabel,
    };
  }

  // SELL
  if (trade.formattedOut && trade.outSymbol === "USDC") {
    return {
      displayAmount: `${trade.formattedBase} ${trade.baseSymbol} → ${trade.formattedOut} USDC`,
      displayToken: "",
      formattedPrice,
      priceLabel,
    };
  }
  return {
    displayAmount: trade.formattedBase,
    displayToken: trade.baseSymbol,
    formattedPrice,
    priceLabel,
  };
}

/** Enrich cached rows that already have both legs but no price. */
function enrichCached(row: RevealedTrade): RevealedTrade {
  if (row.priceUsd && row.priceLabel) return row;
  let priceUsd = row.priceUsd;
  const baseDecimals = row.baseDecimals ?? 18;
  try {
    if (!priceUsd && !row.isBuy && row.amountOutRaw && row.amountBaseRaw) {
      const base = Number(formatUnits(BigInt(row.amountBaseRaw), baseDecimals));
      const usdc = Number(formatUnits(BigInt(row.amountOutRaw), 6));
      if (base > 0 && usdc > 0) priceUsd = usdc / base;
    }
    if (!priceUsd && row.isBuy && row.usdcInRaw && row.amountOutRaw) {
      const base = Number(formatUnits(BigInt(row.amountOutRaw), baseDecimals));
      const usdc = Number(formatUnits(BigInt(row.usdcInRaw), 6));
      if (base > 0 && usdc > 0) priceUsd = usdc / base;
    }
  } catch {
    /* keep */
  }
  const built = buildDisplay({ ...row, priceUsd });
  return { ...row, priceUsd, ...built };
}

async function usdcSpentInFillTx(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  txHash: `0x${string}`,
  exchange: Address
): Promise<bigint | null> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    let best = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC.toLowerCase()) continue;
      try {
        const topics = log.topics;
        // Transfer(from,to,value) — topic0 signature, topic1 from, topic2 to
        if (topics.length < 3) continue;
        const from = `0x${topics[1]!.slice(26)}`.toLowerCase();
        // Prefer transfers out of the exchange (desk → router)
        if (from !== exchange.toLowerCase()) continue;
        const value = BigInt(log.data);
        if (value > best) best = value;
      } catch {
        /* skip */
      }
    }
    // Fallback: largest USDC transfer in the tx
    if (best === 0n) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== USDC.toLowerCase()) continue;
        if (log.topics.length < 3) continue;
        const value = BigInt(log.data);
        if (value > best) best = value;
      }
    }
    return best > 0n ? best : null;
  } catch {
    return null;
  }
}

export interface UseTradeHistoryDecryptionReturn {
  revealed: Record<string, RevealedTrade>;
  isDecrypting: boolean;
  error: string | null;
  canDecrypt: boolean;
  pendingCount: number;
  decryptTrades: (orderIds: string[]) => Promise<void>;
  clearRevealed: () => void;
}

export function useTradeHistoryDecryption(
  orderIds: string[]
): UseTradeHistoryDecryptionReturn {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const contracts = useContractAddresses();
  const { reencrypt, isReady: isFhevmReady } = useFhevm();
  const { symbolFor, decimalsFor } = useTokenRegistry();

  const [revealed, setRevealed] = useState<Record<string, RevealedTrade>>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exchange = contracts?.exchangeAddress as `0x${string}` | undefined;

  useEffect(() => {
    if (!address || !exchange) {
      setRevealed({});
      return;
    }
    const cached = loadCache(exchange, address);
    const enriched: CacheFile = {};
    for (const [k, v] of Object.entries(cached)) {
      enriched[k] = enrichCached(v);
    }
    setRevealed(enriched);
  }, [address, exchange]);

  const pendingCount = useMemo(() => {
    return orderIds.filter((id) => {
      if (!id || !revealed[id]) return true;
      // Re-decrypt BUY fills that lack price/USDC (old cache)
      const t = revealed[id];
      if (t.isBuy && !t.priceUsd && !t.usdcInRaw) return true;
      if (!t.isBuy && !t.priceUsd && !t.amountOutRaw) return true;
      return false;
    }).length;
  }, [orderIds, revealed]);

  const canDecrypt =
    !!isConnected &&
    !!address &&
    !!exchange &&
    isFhevmReady &&
    pendingCount > 0 &&
    !isDecrypting;

  const decryptTrades = useCallback(
    async (ids: string[]) => {
      if (!address || !exchange || !publicClient || !isConnected) {
        setError("Wallet not connected");
        return;
      }
      if (!isFhevmReady) {
        setError("FHE library not ready");
        return;
      }

      const unique = [...new Set(ids.map(String).filter(Boolean))].filter(
        (id) => {
          const t = revealed[id];
          if (!t) return true;
          if (t.isBuy && !t.priceUsd) return true;
          if (!t.isBuy && !t.priceUsd) return true;
          return false;
        }
      );
      if (unique.length === 0) return;

      setIsDecrypting(true);
      setError(null);

      const next: CacheFile = { ...revealed };
      const failures: string[] = [];

      const outByOrder = new Map<
        string,
        { handle: `0x${string}`; txHash: `0x${string}` }
      >();
      try {
        const tip = await publicClient.getBlockNumber();
        const from =
          tip > EXCHANGE_START_BLOCK ? EXCHANGE_START_BLOCK : 0n;
        const logs = await publicClient.getLogs({
          address: exchange,
          event: ORDER_FILLED_PRIVATE,
          fromBlock: from,
          toBlock: tip,
        });
        for (const log of logs) {
          const oid = log.args.orderId?.toString();
          const out = log.args.encryptedAmountOut as `0x${string}` | undefined;
          if (oid && out && out !== ZERO && log.transactionHash) {
            outByOrder.set(oid, { handle: out, txHash: log.transactionHash });
          }
        }
      } catch (e) {
        console.warn("OrderFilledPrivate scan failed:", e);
      }

      for (const orderId of unique) {
        try {
          const order = (await publicClient.readContract({
            address: exchange,
            abi: NoctisExchangeABI,
            functionName: "getMyOrder",
            args: [BigInt(orderId)],
            account: address,
          })) as {
            baseToken: `0x${string}`;
            encryptedAmountBase: `0x${string}`;
            isBuy: boolean;
          };

          const inHandle = order.encryptedAmountBase;
          if (!inHandle || inHandle === ZERO) {
            failures.push(`#${orderId}: empty amount handle`);
            continue;
          }

          const baseToken = String(order.baseToken ?? NATIVE_TOKEN).toLowerCase();
          const baseSymbol = symbolFor(baseToken);
          const baseDecimals = decimalsFor(baseToken);

          // Reuse cached base-amount decrypt if present
          let amountBase: bigint;
          if (next[orderId]?.amountBaseRaw) {
            amountBase = BigInt(next[orderId].amountBaseRaw);
          } else {
            const clear = await reencrypt(
              BigInt(inHandle),
              exchange,
              address
            );
            if (clear === null) {
              failures.push(`#${orderId}: decrypt failed`);
              continue;
            }
            amountBase = clear;
          }

          const isBuy = Boolean(order.isBuy);
          const formattedBase = formatBaseAmount(amountBase, baseDecimals);
          let amountOutRaw: string | undefined =
            next[orderId]?.amountOutRaw;
          let formattedOut: string | undefined =
            next[orderId]?.formattedOut;
          let outSymbol: string | undefined = next[orderId]?.outSymbol;
          let usdcInRaw: string | undefined = next[orderId]?.usdcInRaw;
          let formattedUsdcIn: string | undefined =
            next[orderId]?.formattedUsdcIn;
          let fillTxHash: string | undefined = next[orderId]?.fillTxHash;
          let priceUsd: number | undefined = next[orderId]?.priceUsd;

          const fillMeta = outByOrder.get(orderId);
          if (fillMeta) fillTxHash = fillMeta.txHash;

          if (fillMeta && !amountOutRaw) {
            try {
              const outClear = await reencrypt(
                BigInt(fillMeta.handle),
                exchange,
                address
              );
              if (outClear !== null) {
                amountOutRaw = outClear.toString();
                if (isBuy) {
                  outSymbol = baseSymbol;
                  formattedOut = formatBaseAmount(outClear, baseDecimals);
                } else {
                  outSymbol = "USDC";
                  formattedOut = formatUsdcAmount(outClear);
                }
              }
            } catch (e) {
              console.warn(`amountOut decrypt failed for #${orderId}:`, e);
            }
          }

          // BUY: USDC spent is public on the fill tx (Uniswap path)
          if (isBuy && fillTxHash && !usdcInRaw) {
            const spent = await usdcSpentInFillTx(
              publicClient,
              fillTxHash as `0x${string}`,
              exchange
            );
            if (spent != null) {
              usdcInRaw = spent.toString();
              formattedUsdcIn = formatUsdcAmount(spent);
            }
          }

          // Effective price (USDC per 1 base token)
          try {
            if (!isBuy && amountOutRaw) {
              const base = Number(formatUnits(amountBase, baseDecimals));
              const usdc = Number(formatUnits(BigInt(amountOutRaw), 6));
              if (base > 0 && usdc > 0) priceUsd = usdc / base;
            } else if (isBuy && usdcInRaw && amountOutRaw) {
              const base = Number(formatUnits(BigInt(amountOutRaw), baseDecimals));
              const usdc = Number(formatUnits(BigInt(usdcInRaw), 6));
              if (base > 0 && usdc > 0) priceUsd = usdc / base;
            }
          } catch {
            /* leave undefined */
          }

          const built = buildDisplay({
            isBuy,
            baseSymbol,
            formattedBase,
            formattedOut,
            outSymbol,
            formattedUsdcIn,
            priceUsd,
          });

          next[orderId] = {
            orderId,
            isBuy,
            baseToken,
            baseSymbol,
            baseDecimals,
            amountBaseRaw: amountBase.toString(),
            formattedBase,
            amountOutRaw,
            formattedOut,
            outSymbol,
            usdcInRaw,
            formattedUsdcIn,
            priceUsd,
            fillTxHash,
            ...built,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`Trade decrypt #${orderId}:`, e);
          failures.push(`#${orderId}: ${msg.slice(0, 80)}`);
        }
      }

      setRevealed(next);
      saveCache(exchange, address, next);
      setIsDecrypting(false);

      if (
        failures.length > 0 &&
        Object.keys(next).length === Object.keys(revealed).length
      ) {
        setError(
          `Could not decrypt trades. Wait ~15s after fill for ACL, then retry. (${failures[0]})`
        );
      } else if (failures.length > 0) {
        setError(
          `Some trades failed to decrypt (${failures.length}). Retry later.`
        );
      }
    },
    [
      address,
      exchange,
      publicClient,
      isConnected,
      isFhevmReady,
      reencrypt,
      revealed,
      symbolFor,
      decimalsFor,
    ]
  );

  const clearRevealed = useCallback(() => {
    if (!address || !exchange) return;
    localStorage.removeItem(cacheKey(exchange, address));
    setRevealed({});
    setError(null);
  }, [address, exchange]);

  return {
    revealed,
    isDecrypting,
    error,
    canDecrypt,
    pendingCount,
    decryptTrades,
    clearRevealed,
  };
}
