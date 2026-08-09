/**
 * Live Uniswap V2 quotes for the desk.
 * Spot mid from Sync; 1 ETH rate + size quotes via getAmountsOut.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { useChainId, usePublicClient } from "wagmi";
import { parseEther, parseUnits, type Address } from "viem";
import {
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

const FALLBACK_PRICE = 2500;

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

export function useEthPrice() {
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const live = useUniswapPairLive();
  const [tradePrice, setTradePrice] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Refresh 1 ETH execution rate on every Sync (throttled via tick)
  useEffect(() => {
    if (!publicClient) return;
    const { router, weth, usdc } = deskPair(chainId);
    let cancelled = false;
    (async () => {
      try {
        const amounts = (await publicClient.readContract({
          address: router,
          abi: UNISWAP_ROUTER_ABI,
          functionName: "getAmountsOut",
          args: [parseEther("1"), [weth, usdc]],
        })) as bigint[];
        if (!cancelled && amounts?.[1] != null) {
          setTradePrice(Number(amounts[1]) / 1e6);
          setIsLoading(false);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e : new Error("quote failed"));
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, live.tick, chainId]);

  // Own 1 ETH quote — the live context may follow a non-ETH pair in V2,
  // so its mid is no longer necessarily an ETH price.
  const ethPrice = tradePrice ?? FALLBACK_PRICE;

  const getOutputAmount = useCallback(
    async (
      amountInEth: number,
      isSellEth: boolean = true
    ): Promise<{ output: number; priceImpact: number } | null> => {
      if (!publicClient || amountInEth <= 0) return null;

      try {
        const { router, weth, usdc } = deskPair(chainId);
        const amountIn = isSellEth
          ? parseEther(String(amountInEth))
          : parseUnits(amountInEth.toFixed(6), 6);

        const path = isSellEth ? [weth, usdc] : [usdc, weth];

        const amounts = await publicClient.readContract({
          address: router,
          abi: UNISWAP_ROUTER_ABI,
          functionName: "getAmountsOut",
          args: [amountIn, path],
        });

        if (!amounts || amounts.length < 2) return null;

        const output = isSellEth
          ? Number(amounts[1]) / 1e6
          : Number(amounts[1]) / 1e18;

        const expectedOutput = isSellEth
          ? amountInEth * ethPrice
          : amountInEth / ethPrice;

        const priceImpact =
          expectedOutput > 0
            ? Math.abs((expectedOutput - output) / expectedOutput) * 100
            : 0;

        return { output, priceImpact };
      } catch (e) {
        console.error("getOutputAmount error:", e);
        return null;
      }
    },
    [publicClient, ethPrice, chainId]
  );

  return {
    ethPrice,
    getOutputAmount,
    isLoading: isLoading && !live.isReady,
    error,
    isFallback: !live.midPrice && !tradePrice,
    live: live.isReady,
  };
}
