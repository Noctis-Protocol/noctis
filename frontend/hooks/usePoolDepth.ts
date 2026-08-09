/**
 * Uniswap V2 AMM depth ladder — refreshes on every pool Sync (live).
 * Token-aware: sizes are fractions of the base reserve of the selected pair.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { useChainId, usePublicClient } from "wagmi";
import { formatUnits, parseUnits, type Address } from "viem";
import {
  UNISWAP_ROUTER_ABI,
  UNISWAP_V2_ROUTER,
  USDC,
} from "@/lib/uniswapSepolia";
import {
  UNISWAP_V2_ROUTER_MAINNET,
  USDC_MAINNET,
} from "@/lib/uniswapMainnet";
import { useUniswapPairLive } from "./useUniswapPairLive";

function deskQuote(chainId: number) {
  if (chainId === 1) {
    return {
      router: UNISWAP_V2_ROUTER_MAINNET as Address,
      usdc: USDC_MAINNET as Address,
    };
  }
  return {
    router: UNISWAP_V2_ROUTER as Address,
    usdc: USDC as Address,
  };
}

/** Ladder rungs as fractions of the pool's base reserve. */
const DEPTH_RESERVE_FRACTIONS = [0.002, 0.005, 0.01, 0.025, 0.05, 0.1] as const;

/** Round to 2 significant digits so the ladder reads cleanly across decimals. */
function niceSize(x: number): number {
  if (x <= 0) return 0;
  const mag = 10 ** Math.floor(Math.log10(x));
  return Math.round((x / mag) * 2) / 2 * mag;
}

export interface DepthLevel {
  sizeBase: number;
  price: number;
  amountOut: number;
  impactPct: number;
}

export interface PoolDepthState {
  midPrice: number | null;
  spreadBps: number | null;
  bestAsk: number | null;
  bestBid: number | null;
  reserveBase: number | null;
  reserveUsdc: number | null;
  baseSymbol: string;
  asks: DepthLevel[];
  bids: DepthLevel[];
  isLoading: boolean;
  error: string | null;
  live: boolean;
}

export function usePoolDepth(): PoolDepthState {
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const live = useUniswapPairLive();
  const [asks, setAsks] = useState<DepthLevel[]>([]);
  const [bids, setBids] = useState<DepthLevel[]>([]);
  const [spreadBps, setSpreadBps] = useState<number | null>(null);
  const [bestAsk, setBestAsk] = useState<number | null>(null);
  const [bestBid, setBestBid] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const throttleRef = useRef(0);
  const inflightRef = useRef(false);
  const pairRef = useRef<string | null>(null);

  // Reset the ladder when the selected pair changes
  useEffect(() => {
    if (pairRef.current !== live.pair) {
      pairRef.current = live.pair;
      setAsks([]);
      setBids([]);
      setSpreadBps(null);
      setBestAsk(null);
      setBestBid(null);
      setIsLoading(true);
      setError(null);
      throttleRef.current = 0;
    }
  }, [live.pair]);

  useEffect(() => {
    if (!publicClient || live.midPrice == null || live.reserveBase == null) {
      return;
    }

    const now = Date.now();
    // Coalesce Sync bursts (one ladder rebuild / 800ms)
    if (now - throttleRef.current < 800 && asks.length > 0) return;
    if (inflightRef.current) return;
    throttleRef.current = now;

    const midPrice = live.midPrice;
    const reserveBase = live.reserveBase;
    const reserveUsdc = live.reserveUsdc ?? 0;
    const baseLeg = live.baseLeg;
    const baseDecimals = live.baseDecimals;
    const { router, usdc } = deskQuote(chainId);

    const sizes = DEPTH_RESERVE_FRACTIONS.map((f) =>
      niceSize(reserveBase * f)
    ).filter((s, i, arr) => s > 0 && arr.indexOf(s) === i);

    let cancelled = false;
    inflightRef.current = true;

    (async () => {
      try {
        const nextBids: DepthLevel[] = [];
        for (const size of sizes) {
          if (size >= reserveBase * 0.95) continue;
          try {
            const amounts = (await publicClient.readContract({
              address: router,
              abi: UNISWAP_ROUTER_ABI,
              functionName: "getAmountsOut",
              args: [
                parseUnits(size.toFixed(baseDecimals), baseDecimals),
                [baseLeg, usdc],
              ],
            })) as bigint[];
            const usdcOut = Number(formatUnits(amounts[1], 6));
            const price = usdcOut / size;
            nextBids.push({
              sizeBase: size,
              price,
              amountOut: usdcOut,
              impactPct: Math.max(0, ((midPrice - price) / midPrice) * 100),
            });
          } catch {
            /* skip */
          }
        }

        const nextAsks: DepthLevel[] = [];
        for (const size of sizes) {
          const usdcIn = midPrice * size;
          if (usdcIn >= reserveUsdc * 0.95) continue;
          try {
            const amounts = (await publicClient.readContract({
              address: router,
              abi: UNISWAP_ROUTER_ABI,
              functionName: "getAmountsOut",
              args: [parseUnits(usdcIn.toFixed(6), 6), [usdc, baseLeg]],
            })) as bigint[];
            const baseOut = Number(formatUnits(amounts[1], baseDecimals));
            if (baseOut <= 0) continue;
            const price = usdcIn / baseOut;
            nextAsks.push({
              sizeBase: size,
              price,
              amountOut: baseOut,
              impactPct: Math.max(0, ((price - midPrice) / midPrice) * 100),
            });
          } catch {
            /* skip */
          }
        }

        nextAsks.sort((a, b) => b.price - a.price);
        nextBids.sort((a, b) => b.price - a.price);

        const ba = nextAsks.length ? nextAsks[nextAsks.length - 1].price : null;
        const bb = nextBids.length ? nextBids[0].price : null;
        const spr =
          ba != null && bb != null ? ((ba - bb) / midPrice) * 10_000 : null;

        if (!cancelled) {
          setAsks(nextAsks);
          setBids(nextBids);
          setBestAsk(ba);
          setBestBid(bb);
          setSpreadBps(spr);
          setIsLoading(false);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Depth load failed");
          setIsLoading(false);
        }
      } finally {
        inflightRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick drives live refresh
  }, [
    publicClient,
    chainId,
    live.tick,
    live.midPrice,
    live.reserveBase,
    live.reserveUsdc,
    live.baseLeg,
    live.baseDecimals,
  ]);

  useEffect(() => {
    if (live.error) setError(live.error);
  }, [live.error]);

  return {
    midPrice: live.midPrice,
    spreadBps,
    bestAsk,
    bestBid,
    reserveBase: live.reserveBase,
    reserveUsdc: live.reserveUsdc,
    baseSymbol: live.baseSymbol,
    asks,
    bids,
    isLoading: isLoading && asks.length === 0,
    error,
    live: live.isReady,
  };
}
