/**
 * Uniswap V2 AMM depth ladder — refreshes on every pool Sync (live).
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { useChainId, usePublicClient } from "wagmi";
import { formatEther, parseEther, parseUnits, type Address } from "viem";
import {
  DEPTH_ETH_SIZES,
  UNISWAP_ROUTER_ABI,
  UNISWAP_V2_ROUTER,
  USDC,
  WETH,
} from "@/lib/uniswapSepolia";
import {
  UNISWAP_V2_ROUTER_MAINNET,
  USDC_MAINNET,
  WETH_MAINNET,
} from "@/lib/uniswapMainnet";
import { useUniswapPairLive } from "./useUniswapPairLive";

function deskPair(chainId: number) {
  if (chainId === 1) {
    return {
      router: UNISWAP_V2_ROUTER_MAINNET as Address,
      weth: WETH_MAINNET as Address,
      usdc: USDC_MAINNET as Address,
    };
  }
  return {
    router: UNISWAP_V2_ROUTER as Address,
    weth: WETH as Address,
    usdc: USDC as Address,
  };
}

export interface DepthLevel {
  sizeEth: number;
  price: number;
  amountOut: number;
  impactPct: number;
}

export interface PoolDepthState {
  midPrice: number | null;
  spreadBps: number | null;
  bestAsk: number | null;
  bestBid: number | null;
  reserveEth: number | null;
  reserveUsdc: number | null;
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

  useEffect(() => {
    if (!publicClient || live.midPrice == null || live.reserveEth == null) {
      return;
    }

    const now = Date.now();
    // Coalesce Sync bursts (one ladder rebuild / 800ms)
    if (now - throttleRef.current < 800 && asks.length > 0) return;
    if (inflightRef.current) return;
    throttleRef.current = now;

    const midPrice = live.midPrice;
    const reserveEth = live.reserveEth;
    const reserveUsdc = live.reserveUsdc ?? 0;
    const { router, weth, usdc } = deskPair(chainId);

    let cancelled = false;
    inflightRef.current = true;

    (async () => {
      try {
        const nextBids: DepthLevel[] = [];
        for (const size of DEPTH_ETH_SIZES) {
          if (size >= reserveEth * 0.95) continue;
          try {
            const amounts = (await publicClient.readContract({
              address: router,
              abi: UNISWAP_ROUTER_ABI,
              functionName: "getAmountsOut",
              args: [parseEther(String(size)), [weth, usdc]],
            })) as bigint[];
            const usdcOut = Number(amounts[1]) / 1e6;
            const price = usdcOut / size;
            nextBids.push({
              sizeEth: size,
              price,
              amountOut: usdcOut,
              impactPct: Math.max(0, ((midPrice - price) / midPrice) * 100),
            });
          } catch {
            /* skip */
          }
        }

        const nextAsks: DepthLevel[] = [];
        for (const size of DEPTH_ETH_SIZES) {
          const usdcIn = midPrice * size;
          if (usdcIn >= reserveUsdc * 0.95) continue;
          try {
            const amounts = (await publicClient.readContract({
              address: router,
              abi: UNISWAP_ROUTER_ABI,
              functionName: "getAmountsOut",
              args: [parseUnits(usdcIn.toFixed(6), 6), [usdc, weth]],
            })) as bigint[];
            const ethOut = Number(formatEther(amounts[1]));
            if (ethOut <= 0) continue;
            const price = usdcIn / ethOut;
            nextAsks.push({
              sizeEth: size,
              price,
              amountOut: ethOut,
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
          ba != null && bb != null
            ? ((ba - bb) / midPrice) * 10_000
            : null;

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
    live.reserveEth,
    live.reserveUsdc,
  ]);

  useEffect(() => {
    if (live.error) setError(live.error);
  }, [live.error]);

  return {
    midPrice: live.midPrice,
    spreadBps,
    bestAsk,
    bestBid,
    reserveEth: live.reserveEth,
    reserveUsdc: live.reserveUsdc,
    asks,
    bids,
    isLoading: isLoading && asks.length === 0,
    error,
    live: live.isReady,
  };
}
