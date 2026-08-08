/**
 * Uniswap V2 pool price history from on-chain Sync events.
 * Works for any factory pair (tokens that only exist on Uniswap).
 */

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import { mainnet, sepolia } from "viem/chains";
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

export type ChartRange = "15m" | "1h" | "4h" | "1d" | "7d" | "30d";

/** @deprecated use ChartRange */
export type ChartDays = ChartRange;

export type UniswapChartPoint = { t: number; p: number };

/** Lookback in seconds per UI range (~12s blocks on ETH/Sepolia). */
export const CHART_RANGE_SECONDS: Record<ChartRange, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

export const CHART_RANGES = [
  "15m",
  "1h",
  "4h",
  "1d",
  "7d",
  "30d",
] as const satisfies readonly ChartRange[];

const SYNC_EVENT = parseAbiItem(
  "event Sync(uint112 reserve0, uint112 reserve1)"
);

const ERC20_DECIMALS_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

const BLOCK_SECONDS: Record<number, number> = {
  1: 12,
  11155111: 12,
};

const LOG_CHUNK = 25_000n;
const MAX_POINTS = 320;
const CHUNK_PAUSE_MS = 120;

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("429") && !msg.includes("Rate limit")) throw e;
      await sleep(400 * (i + 1) ** 2);
    }
  }
  throw last;
}

const cache = new Map<
  string,
  { at: number; payload: UniswapChartResult }
>();
const CACHE_TTL_MS = 60_000;

export type UniswapChartResult = {
  pair: Address;
  token0: Address;
  token1: Address;
  base: Address;
  quote: Address;
  source: "uniswap-v2";
  prices: UniswapChartPoint[];
  note: string;
};

function rpcFor(chainId: number): string {
  if (chainId === 1) {
    return process.env.MAINNET_RPC || "https://rpc.ankr.com/eth";
  }
  return (
    process.env.SEPOLIA_RPC ||
    process.env.NEXT_PUBLIC_SEPOLIA_RPC ||
    "https://ethereum-sepolia-rpc.publicnode.com"
  );
}

function clientFor(chainId: number): PublicClient {
  const chain = chainId === 1 ? mainnet : sepolia;
  return createPublicClient({
    chain,
    transport: http(rpcFor(chainId)),
  });
}

function routerFor(chainId: number): Address {
  return chainId === 1 ? UNISWAP_V2_ROUTER_MAINNET : UNISWAP_V2_ROUTER;
}

function defaultBaseQuote(chainId: number): { base: Address; quote: Address } {
  if (chainId === 1) {
    return { base: WETH_MAINNET, quote: USDC_MAINNET };
  }
  return { base: WETH, quote: USDC };
}

function priceFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  token0: Address,
  base: Address,
  dec0: number,
  dec1: number
): number | null {
  if (reserve0 === 0n || reserve1 === 0n) return null;
  const r0 = Number(reserve0) / 10 ** dec0;
  const r1 = Number(reserve1) / 10 ** dec1;
  if (r0 <= 0 || r1 <= 0) return null;
  // Price of 1 base in quote units
  const baseIs0 = token0.toLowerCase() === base.toLowerCase();
  return baseIs0 ? r1 / r0 : r0 / r1;
}

function downsample(
  points: UniswapChartPoint[],
  max: number
): UniswapChartPoint[] {
  if (points.length <= max) return points;
  const out: UniswapChartPoint[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

type SyncLog = {
  blockNumber: bigint;
  args: { reserve0?: bigint; reserve1?: bigint };
};

async function fetchSyncLogs(
  client: PublicClient,
  pair: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<SyncLog[]> {
  const logs: SyncLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end =
      start + LOG_CHUNK - 1n > toBlock ? toBlock : start + LOG_CHUNK - 1n;
    const chunk = await withRetry(() =>
      client.getLogs({
        address: pair,
        event: SYNC_EVENT,
        fromBlock: start,
        toBlock: end,
      })
    );
    for (const log of chunk) {
      if (log.blockNumber == null) continue;
      logs.push({
        blockNumber: log.blockNumber,
        args: {
          reserve0: log.args.reserve0,
          reserve1: log.args.reserve1,
        },
      });
    }
    if (end < toBlock) await sleep(CHUNK_PAUSE_MS);
  }
  return logs;
}

/**
 * Interpolate timestamps from endpoints — avoids N eth_getBlockByNumber
 * calls that trip public RPC rate limits on longer ranges.
 */
function timestampsFromSpan(
  blockNumbers: bigint[],
  fromBlock: bigint,
  toBlock: bigint,
  fromTsMs: number,
  toTsMs: number
): Map<string, number> {
  const map = new Map<string, number>();
  const spanBlocks = toBlock > fromBlock ? toBlock - fromBlock : 1n;
  const spanMs = Math.max(1, toTsMs - fromTsMs);
  for (const bn of blockNumbers) {
    const ratio = Number(bn - fromBlock) / Number(spanBlocks);
    map.set(bn.toString(), Math.round(fromTsMs + ratio * spanMs));
  }
  return map;
}

export async function fetchUniswapV2Chart(opts: {
  range: ChartRange;
  chainId?: number;
  base?: Address;
  quote?: Address;
}): Promise<UniswapChartResult> {
  const chainId = opts.chainId ?? 11155111;
  const defaults = defaultBaseQuote(chainId);
  const base = (opts.base || defaults.base) as Address;
  const quote = (opts.quote || defaults.quote) as Address;
  const cacheKey = `${chainId}:${base}:${quote}:${opts.range}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const client = clientFor(chainId);
  const router = routerFor(chainId);

  const factory = (await client.readContract({
    address: router,
    abi: UNISWAP_ROUTER_ABI,
    functionName: "factory",
  })) as Address;

  const pair = (await client.readContract({
    address: factory,
    abi: UNISWAP_FACTORY_ABI,
    functionName: "getPair",
    args: [base, quote],
  })) as Address;

  if (!pair || pair === "0x0000000000000000000000000000000000000000") {
    throw new Error("Uniswap V2 pair not found for this token pair");
  }

  const [token0, decBase, decQuote, reserves, latestBlock, latestHeader] =
    await Promise.all([
      client.readContract({
        address: pair,
        abi: UNISWAP_PAIR_ABI,
        functionName: "token0",
      }) as Promise<Address>,
      client.readContract({
        address: base,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals",
      }) as Promise<number>,
      client.readContract({
        address: quote,
        abi: ERC20_DECIMALS_ABI,
        functionName: "decimals",
      }) as Promise<number>,
      client.readContract({
        address: pair,
        abi: UNISWAP_PAIR_ABI,
        functionName: "getReserves",
      }) as Promise<readonly [bigint, bigint, number]>,
      client.getBlockNumber(),
      client.getBlock(),
    ]);

  const token1 =
    token0.toLowerCase() === base.toLowerCase() ? quote : base;
  const dec0 = token0.toLowerCase() === base.toLowerCase() ? decBase : decQuote;
  const dec1 = token0.toLowerCase() === base.toLowerCase() ? decQuote : decBase;

  const blockSec = BLOCK_SECONDS[chainId] ?? 12;
  const lookbackSec = CHART_RANGE_SECONDS[opts.range];
  const lookback = BigInt(Math.ceil(lookbackSec / blockSec));
  const fromBlock =
    latestBlock > lookback ? latestBlock - lookback : 0n;

  const fromHeader = await client.getBlock({ blockNumber: fromBlock });
  const fromTsMs = Number(fromHeader.timestamp) * 1000;
  const toTsMs = Number(latestHeader.timestamp) * 1000;

  const logs = await fetchSyncLogs(client, pair, fromBlock, latestBlock);
  const tsMap = timestampsFromSpan(
    logs.map((l) => l.blockNumber),
    fromBlock,
    latestBlock,
    fromTsMs,
    toTsMs
  );

  const byTime = new Map<number, number>();
  for (const log of logs) {
    const r0 = log.args.reserve0;
    const r1 = log.args.reserve1;
    if (r0 == null || r1 == null) continue;
    const p = priceFromReserves(r0, r1, token0, base, dec0, dec1);
    if (p == null || !Number.isFinite(p)) continue;
    const t = tsMap.get(log.blockNumber.toString());
    if (!t) continue;
    byTime.set(t, p);
  }

  // Current mid (same basis as desk quote)
  const nowP = priceFromReserves(
    reserves[0],
    reserves[1],
    token0,
    base,
    dec0,
    dec1
  );
  const nowT = Number(latestHeader.timestamp) * 1000;
  if (nowP != null) byTime.set(nowT, nowP);

  let prices = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, p]) => ({ t, p }));

  // Thin pools: if only one point, synthesize a flat open so the chart renders
  if (prices.length === 1) {
    prices = [
      { t: prices[0].t - Math.min(lookbackSec, 3600) * 1000, p: prices[0].p },
      prices[0],
    ];
  }

  prices = downsample(prices, MAX_POINTS);

  const payload: UniswapChartResult = {
    pair,
    token0,
    token1: token1 as Address,
    base,
    quote,
    source: "uniswap-v2",
    prices,
    note: "Pool mid from Uniswap V2 Sync + live reserves. Settlement uses the same pool.",
  };
  cache.set(cacheKey, { at: Date.now(), payload });
  return payload;
}
