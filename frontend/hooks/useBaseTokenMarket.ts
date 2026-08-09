/**
 * useBaseTokenMarket — live market data for any tradable base token vs USDC.
 *
 * - tradeConfig: on-chain per-token trade parameters (feed, decimals, routing)
 * - price: Chainlink base/USD (8 decimals), refreshed periodically
 * - getOutputAmount: Uniswap V2 quote (base⇄USDC) with price-impact estimate
 *
 * Generalizes the V1 ETH-only useEthPrice to the V2 multi-token registry.
 */

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePublicClient, useReadContract } from "wagmi";
import { NoctisExchangeABI, NATIVE_TOKEN } from "@/lib/contracts/abi";
import { useContractAddresses } from "@/lib/wagmi";
import {
  UNISWAP_V2_ROUTER,
  WETH,
  USDC,
  UNISWAP_ROUTER_ABI,
} from "@/lib/uniswapSepolia";
import type { TokenInfo } from "./useTokenRegistry";
import type { BuyPreflightBase } from "@/lib/buyPreflight";

const FEED_ABI = [
  {
    name: "latestRoundData",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

const PRICE_REFRESH_MS = 30_000;

export interface BaseTokenMarket {
  /** Chainlink base/USD price in USD (already scaled from 8 decimals); 0 while loading */
  price: number;
  /** Trade parameters used by preflight + quotes; null while loading */
  preflightBase: BuyPreflightBase | null;
  /** Order size bounds in base units (from tradeConfigs) */
  minOrderSize: bigint;
  maxOrderSize: bigint;
  /** Uniswap V2 quote: sell base → USDC out, or buy: USDC in → base out */
  getOutputAmount: (
    amountIn: number,
    isSellBase: boolean
  ) => Promise<{ output: number; priceImpact: number } | null>;
  isLoading: boolean;
}

export function useBaseTokenMarket(token: TokenInfo | null): BaseTokenMarket {
  const publicClient = usePublicClient();
  const contracts = useContractAddresses();
  const exchangeAddress = contracts?.exchangeAddress as `0x${string}` | undefined;
  const [price, setPrice] = useState(0);

  const { data: configRaw, isLoading } = useReadContract({
    abi: NoctisExchangeABI,
    address: exchangeAddress,
    functionName: "tradeConfigs",
    args: token ? [token.address] : undefined,
    query: {
      enabled: Boolean(exchangeAddress && token),
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  });

  const config = useMemo(() => {
    if (!token || !configRaw) return null;
    const [enabled, priceFeed, baseDecimals, routeViaWeth, minOrderSize, maxOrderSize] =
      configRaw as unknown as readonly [boolean, `0x${string}`, number, boolean, bigint, bigint, bigint, bigint];
    return { enabled, priceFeed, baseDecimals: Number(baseDecimals), routeViaWeth, minOrderSize, maxOrderSize };
  }, [token, configRaw]);

  const preflightBase = useMemo<BuyPreflightBase | null>(() => {
    if (!token || !config) return null;
    return {
      address: token.address,
      decimals: config.baseDecimals || token.decimals,
      priceFeed: config.priceFeed,
      routeViaWeth: config.routeViaWeth,
    };
  }, [token, config]);

  // Chainlink base/USD price, refreshed periodically
  useEffect(() => {
    if (!publicClient || !config?.priceFeed) {
      setPrice(0);
      return;
    }
    let cancelled = false;
    async function fetchPrice() {
      try {
        const round = await publicClient!.readContract({
          address: config!.priceFeed,
          abi: FEED_ABI,
          functionName: "latestRoundData",
        });
        if (!cancelled && round[1] > 0n) {
          setPrice(Number(round[1]) / 1e8);
        }
      } catch (e) {
        console.warn("Chainlink price read failed:", e);
      }
    }
    void fetchPrice();
    const interval = setInterval(fetchPrice, PRICE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [publicClient, config]);

  const getOutputAmount = useCallback(
    async (
      amountIn: number,
      isSellBase: boolean
    ): Promise<{ output: number; priceImpact: number } | null> => {
      if (!publicClient || !token || !preflightBase || amountIn <= 0) return null;

      const baseDecimals = preflightBase.decimals;
      const isNative = token.address.toLowerCase() === NATIVE_TOKEN;
      const baseLeg: `0x${string}`[] = isNative
        ? [WETH]
        : preflightBase.routeViaWeth
          ? [WETH, token.address]
          : [token.address];
      const path: `0x${string}`[] = isSellBase
        ? [...[...baseLeg].reverse(), USDC]
        : [USDC, ...baseLeg];

      try {
        const rawIn = isSellBase
          ? BigInt(Math.floor(amountIn * 10 ** Math.min(baseDecimals, 15))) *
            10n ** BigInt(Math.max(baseDecimals - 15, 0))
          : BigInt(Math.floor(amountIn * 1e6));

        const amounts = await publicClient.readContract({
          address: UNISWAP_V2_ROUTER,
          abi: UNISWAP_ROUTER_ABI,
          functionName: "getAmountsOut",
          args: [rawIn, path],
        });
        const rawOut = amounts?.[amounts.length - 1];
        if (rawOut == null) return null;

        const output = isSellBase
          ? Number(rawOut) / 1e6
          : Number(rawOut) / 10 ** baseDecimals;

        const expectedOutput =
          price > 0 ? (isSellBase ? amountIn * price : amountIn / price) : 0;
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
    [publicClient, token, preflightBase, price]
  );

  return {
    price,
    preflightBase,
    minOrderSize: config?.minOrderSize ?? 0n,
    maxOrderSize: config?.maxOrderSize ?? 0n,
    getOutputAmount,
    isLoading,
  };
}
