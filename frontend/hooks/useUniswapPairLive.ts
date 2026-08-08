/**
 * Live Uniswap V2 WETH/USDC pair — one Sync subscription for the whole desk.
 */

"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  usePublicClient,
  useWatchContractEvent,
  useBlockNumber,
  useChainId,
} from "wagmi";
import { formatEther, formatUnits, type Address } from "viem";
import {
  UNISWAP_FACTORY_ABI,
  UNISWAP_PAIR_ABI,
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

function pairTokens(chainId: number | undefined) {
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

const PAIR_LIVE_ABI = [
  ...UNISWAP_PAIR_ABI,
  {
    type: "event",
    name: "Sync",
    inputs: [
      { name: "reserve0", type: "uint112", indexed: false },
      { name: "reserve1", type: "uint112", indexed: false },
    ],
  },
] as const;

export type UniswapPairLive = {
  pair: Address | null;
  midPrice: number | null;
  reserveEth: number | null;
  reserveUsdc: number | null;
  tick: number;
  lastSyncAt: number | null;
  isReady: boolean;
  error: string | null;
};

const EMPTY: UniswapPairLive = {
  pair: null,
  midPrice: null,
  reserveEth: null,
  reserveUsdc: null,
  tick: 0,
  lastSyncAt: null,
  isReady: false,
  error: null,
};

const UniswapPairLiveContext = createContext<UniswapPairLive | null>(null);

function midFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  token0: Address,
  weth: Address
): {
  midPrice: number;
  reserveEth: number;
  reserveUsdc: number;
} | null {
  const wethIs0 = token0.toLowerCase() === weth.toLowerCase();
  const reserveEth = Number(formatEther(wethIs0 ? reserve0 : reserve1));
  const reserveUsdc = Number(
    formatUnits(wethIs0 ? reserve1 : reserve0, 6)
  );
  if (!(reserveEth > 0) || !(reserveUsdc > 0)) return null;
  return {
    midPrice: reserveUsdc / reserveEth,
    reserveEth,
    reserveUsdc,
  };
}

function useUniswapPairLiveState(): UniswapPairLive {
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const tokens = pairTokens(chainId);
  const wethRef = useRef(tokens.weth);
  wethRef.current = tokens.weth;

  const [pair, setPair] = useState<Address | null>(null);
  const [token0, setToken0] = useState<Address | null>(null);
  const [midPrice, setMidPrice] = useState<number | null>(null);
  const [reserveEth, setReserveEth] = useState<number | null>(null);
  const [reserveUsdc, setReserveUsdc] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const token0Ref = useRef<Address | null>(null);
  token0Ref.current = token0;
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    setPair(null);
    setToken0(null);
    setMidPrice(null);
    (async () => {
      try {
        const { router, weth, usdc } = pairTokens(chainId);
        const factory = (await publicClient.readContract({
          address: router,
          abi: UNISWAP_ROUTER_ABI,
          functionName: "factory",
        })) as Address;
        const p = (await publicClient.readContract({
          address: factory,
          abi: UNISWAP_FACTORY_ABI,
          functionName: "getPair",
          args: [weth, usdc],
        })) as Address;
        if (!p || p === "0x0000000000000000000000000000000000000000") {
          throw new Error("ETH/USDC pair not found");
        }
        const t0 = (await publicClient.readContract({
          address: p,
          abi: UNISWAP_PAIR_ABI,
          functionName: "token0",
        })) as Address;
        if (!cancelled) {
          setPair(p);
          setToken0(t0);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Pair resolve failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, chainId]);

  const applyReserves = useCallback(
    (r0: bigint, r1: bigint, t0: Address) => {
      const m = midFromReserves(r0, r1, t0, wethRef.current);
      if (!m) return;
      setMidPrice(m.midPrice);
      setReserveEth(m.reserveEth);
      setReserveUsdc(m.reserveUsdc);
      setLastSyncAt(Date.now());
      setTick((n) => n + 1);
      lastRefreshRef.current = Date.now();
    },
    []
  );

  const refreshFromChain = useCallback(async () => {
    if (!publicClient || !pair || !token0Ref.current) return;
    try {
      const reserves = (await publicClient.readContract({
        address: pair,
        abi: UNISWAP_PAIR_ABI,
        functionName: "getReserves",
      })) as readonly [bigint, bigint, number];
      applyReserves(reserves[0], reserves[1], token0Ref.current);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reserve read failed");
    }
  }, [publicClient, pair, applyReserves]);

  useEffect(() => {
    if (pair && token0) void refreshFromChain();
  }, [pair, token0, refreshFromChain]);

  useWatchContractEvent({
    address: pair ?? undefined,
    abi: PAIR_LIVE_ABI,
    eventName: "Sync",
    enabled: Boolean(pair),
    onLogs: (logs) => {
      const t0 = token0Ref.current;
      if (!t0 || !logs.length) return;
      const last = logs[logs.length - 1];
      const r0 = last.args.reserve0;
      const r1 = last.args.reserve1;
      if (r0 == null || r1 == null) {
        void refreshFromChain();
        return;
      }
      applyReserves(r0, r1, t0);
    },
  });

  const { data: blockNumber } = useBlockNumber({ watch: true });
  useEffect(() => {
    if (!blockNumber || !pair) return;
    if (Date.now() - lastRefreshRef.current > 8_000) {
      void refreshFromChain();
    }
  }, [blockNumber, pair, refreshFromChain]);

  return useMemo(
    () => ({
      pair,
      midPrice,
      reserveEth,
      reserveUsdc,
      tick,
      lastSyncAt,
      isReady: midPrice != null,
      error,
    }),
    [
      pair,
      midPrice,
      reserveEth,
      reserveUsdc,
      tick,
      lastSyncAt,
      error,
    ]
  );
}

export function UniswapPairLiveProvider({ children }: { children: ReactNode }) {
  const value = useUniswapPairLiveState();
  return createElement(UniswapPairLiveContext.Provider, { value }, children);
}

/** Must be used under UniswapPairLiveProvider (desk page). */
export function useUniswapPairLive(): UniswapPairLive {
  const ctx = useContext(UniswapPairLiveContext);
  return ctx ?? EMPTY;
}
