/**
 * Live Uniswap V2 base/USDC pair — one Sync subscription for the whole desk.
 * Token-aware: the provider follows the selected base token (native ETH = WETH leg).
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
import { formatUnits, zeroAddress, type Address } from "viem";
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

function deskTokens(chainId: number | undefined) {
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

/** Base token the desk pair follows (address(0) = native ETH → WETH pool leg). */
export type PairLiveBase = {
  address: Address;
  decimals: number;
  symbol: string;
};

const DEFAULT_BASE: PairLiveBase = {
  address: zeroAddress,
  decimals: 18,
  symbol: "ETH",
};

export type UniswapPairLive = {
  pair: Address | null;
  /** Pool leg used for the base side (WETH for native ETH) */
  baseLeg: Address;
  baseDecimals: number;
  baseSymbol: string;
  midPrice: number | null;
  reserveBase: number | null;
  reserveUsdc: number | null;
  tick: number;
  lastSyncAt: number | null;
  isReady: boolean;
  error: string | null;
};

const EMPTY: UniswapPairLive = {
  pair: null,
  baseLeg: WETH as Address,
  baseDecimals: 18,
  baseSymbol: "ETH",
  midPrice: null,
  reserveBase: null,
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
  baseLeg: Address,
  baseDecimals: number
): {
  midPrice: number;
  reserveBase: number;
  reserveUsdc: number;
} | null {
  const baseIs0 = token0.toLowerCase() === baseLeg.toLowerCase();
  const reserveBase = Number(
    formatUnits(baseIs0 ? reserve0 : reserve1, baseDecimals)
  );
  const reserveUsdc = Number(formatUnits(baseIs0 ? reserve1 : reserve0, 6));
  if (!(reserveBase > 0) || !(reserveUsdc > 0)) return null;
  return {
    midPrice: reserveUsdc / reserveBase,
    reserveBase,
    reserveUsdc,
  };
}

function useUniswapPairLiveState(base: PairLiveBase): UniswapPairLive {
  const publicClient = usePublicClient();
  const chainId = useChainId();
  const tokens = deskTokens(chainId);

  const isNative = base.address.toLowerCase() === zeroAddress;
  const baseLeg = isNative ? tokens.weth : base.address;
  const baseDecimals = isNative ? 18 : base.decimals;

  const baseLegRef = useRef(baseLeg);
  baseLegRef.current = baseLeg;
  const baseDecimalsRef = useRef(baseDecimals);
  baseDecimalsRef.current = baseDecimals;

  const [pair, setPair] = useState<Address | null>(null);
  const [token0, setToken0] = useState<Address | null>(null);
  const [midPrice, setMidPrice] = useState<number | null>(null);
  const [reserveBase, setReserveBase] = useState<number | null>(null);
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
    setReserveBase(null);
    setReserveUsdc(null);
    (async () => {
      try {
        const { router, usdc } = deskTokens(chainId);
        const factory = (await publicClient.readContract({
          address: router,
          abi: UNISWAP_ROUTER_ABI,
          functionName: "factory",
        })) as Address;
        const p = (await publicClient.readContract({
          address: factory,
          abi: UNISWAP_FACTORY_ABI,
          functionName: "getPair",
          args: [baseLeg, usdc],
        })) as Address;
        if (!p || p === "0x0000000000000000000000000000000000000000") {
          throw new Error(`${base.symbol}/USDC pair not found`);
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
  }, [publicClient, chainId, baseLeg, base.symbol]);

  const applyReserves = useCallback(
    (r0: bigint, r1: bigint, t0: Address) => {
      const m = midFromReserves(
        r0,
        r1,
        t0,
        baseLegRef.current,
        baseDecimalsRef.current
      );
      if (!m) return;
      setMidPrice(m.midPrice);
      setReserveBase(m.reserveBase);
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
      baseLeg,
      baseDecimals,
      baseSymbol: base.symbol,
      midPrice,
      reserveBase,
      reserveUsdc,
      tick,
      lastSyncAt,
      isReady: midPrice != null,
      error,
    }),
    [
      pair,
      baseLeg,
      baseDecimals,
      base.symbol,
      midPrice,
      reserveBase,
      reserveUsdc,
      tick,
      lastSyncAt,
      error,
    ]
  );
}

export function UniswapPairLiveProvider({
  base,
  children,
}: {
  /** Selected base token; defaults to native ETH */
  base?: PairLiveBase | null;
  children: ReactNode;
}) {
  const value = useUniswapPairLiveState(base ?? DEFAULT_BASE);
  return createElement(UniswapPairLiveContext.Provider, { value }, children);
}

/** Must be used under UniswapPairLiveProvider (desk page). */
export function useUniswapPairLive(): UniswapPairLive {
  const ctx = useContext(UniswapPairLiveContext);
  return ctx ?? EMPTY;
}
