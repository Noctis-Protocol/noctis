/**
 * Server-side aggregation for the public metrics page.
 *
 * Two independent sources, each allowed to fail without taking the page down:
 * - Subgraph (order lifecycle counts, public deposit flow, indexer head block)
 * - Sepolia RPC (vault balances, exchange order counter, chain tip)
 *
 * Only public data is read here. Order sizes, trader identities and per-user
 * vault balances are FHE ciphertexts on-chain and never appear in this payload.
 */

import { createPublicClient, fallback, formatEther, formatUnits, http } from "viem";
import { sepolia } from "viem/chains";
import { PILOT } from "./pilot";

const SUBGRAPH_TIMEOUT_MS = 8_000;
const ORDERS_PER_DAY_WINDOW = 14;
const DAY_SECONDS = 86_400;

const ERC20_BALANCE_OF = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ORDER_COUNTER = [
  {
    name: "orderCounter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface OrdersPerDayPoint {
  /** ISO day, e.g. "2026-08-09" (UTC) */
  day: string;
  count: number;
}

export interface SubgraphMetrics {
  ok: boolean;
  headBlock: number | null;
  totalOrders: number | null;
  totalOrdersFilled: number | null;
  totalOrdersCancelled: number | null;
  totalDeposits: number | null;
  totalWithdrawals: number | null;
  totalUsers: number | null;
  /** Public deposit flow (deposit events carry cleartext amounts) */
  totalDepositedETH: string | null;
  totalDepositedUSDT: string | null;
  ordersPerDay: OrdersPerDayPoint[];
}

export interface OnchainMetrics {
  ok: boolean;
  latestBlock: number | null;
  /** Native ETH held by the vault, formatted in ether */
  vaultEth: string | null;
  /** ERC-20 balance of the vault (USDC slot, 6 decimals), formatted */
  vaultUsdc: string | null;
  orderCounter: number | null;
}

export interface MetricsPayload {
  generatedAt: number;
  network: string;
  addresses: { vault: string; exchange: string; usdc: string };
  subgraph: SubgraphMetrics;
  onchain: OnchainMetrics;
}

const EMPTY_SUBGRAPH: SubgraphMetrics = {
  ok: false,
  headBlock: null,
  totalOrders: null,
  totalOrdersFilled: null,
  totalOrdersCancelled: null,
  totalDeposits: null,
  totalWithdrawals: null,
  totalUsers: null,
  totalDepositedETH: null,
  totalDepositedUSDT: null,
  ordersPerDay: [],
};

const EMPTY_ONCHAIN: OnchainMetrics = {
  ok: false,
  latestBlock: null,
  vaultEth: null,
  vaultUsdc: null,
  orderCounter: null,
};

interface SubgraphResponse {
  data?: {
    _meta?: { block?: { number?: number } };
    globalStats?: {
      totalUsers: number;
      totalDeposits: number;
      totalDepositedETH: string;
      totalDepositedUSDT: string;
      totalWithdrawals: number;
      totalOrders: number;
      totalOrdersFilled: number;
      totalOrdersCancelled: number;
    } | null;
    orders?: { createdAt: string }[];
  };
}

function bucketOrdersPerDay(
  orders: { createdAt: string }[],
  nowSec: number
): OrdersPerDayPoint[] {
  const counts = new Map<string, number>();
  for (const order of orders) {
    const day = new Date(Number(order.createdAt) * 1000)
      .toISOString()
      .slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const points: OrdersPerDayPoint[] = [];
  for (let i = ORDERS_PER_DAY_WINDOW - 1; i >= 0; i--) {
    const day = new Date((nowSec - i * DAY_SECONDS) * 1000)
      .toISOString()
      .slice(0, 10);
    points.push({ day, count: counts.get(day) ?? 0 });
  }
  return points;
}

async function fetchSubgraphMetrics(): Promise<SubgraphMetrics> {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - ORDERS_PER_DAY_WINDOW * DAY_SECONDS;

  try {
    const res = await fetch(PILOT.subgraph, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(SUBGRAPH_TIMEOUT_MS),
      body: JSON.stringify({
        query: `{
          _meta { block { number } }
          globalStats(id: "global") {
            totalUsers
            totalDeposits
            totalDepositedETH
            totalDepositedUSDT
            totalWithdrawals
            totalOrders
            totalOrdersFilled
            totalOrdersCancelled
          }
          orders(
            first: 1000
            orderBy: createdAt
            orderDirection: desc
            where: { createdAt_gte: "${windowStart}" }
          ) {
            createdAt
          }
        }`,
      }),
    });
    if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);

    const json = (await res.json()) as SubgraphResponse;
    const stats = json.data?.globalStats ?? null;

    return {
      ok: true,
      headBlock: json.data?._meta?.block?.number ?? null,
      totalOrders: stats?.totalOrders ?? null,
      totalOrdersFilled: stats?.totalOrdersFilled ?? null,
      totalOrdersCancelled: stats?.totalOrdersCancelled ?? null,
      totalDeposits: stats?.totalDeposits ?? null,
      totalWithdrawals: stats?.totalWithdrawals ?? null,
      totalUsers: stats?.totalUsers ?? null,
      totalDepositedETH: stats?.totalDepositedETH ?? null,
      totalDepositedUSDT: stats?.totalDepositedUSDT ?? null,
      ordersPerDay: bucketOrdersPerDay(json.data?.orders ?? [], nowSec),
    };
  } catch (e) {
    console.error("metrics: subgraph fetch failed:", e);
    return { ...EMPTY_SUBGRAPH };
  }
}

async function fetchOnchainMetrics(): Promise<OnchainMetrics> {
  try {
    const client = createPublicClient({
      chain: sepolia,
      transport: fallback([
        http("https://ethereum-sepolia-rpc.publicnode.com"),
        http("https://1rpc.io/sepolia"),
      ]),
    });

    const vault = PILOT.vault as `0x${string}`;
    const exchange = PILOT.exchange as `0x${string}`;
    const usdc = PILOT.usdc as `0x${string}`;

    const [blockRes, ethRes, usdcRes, counterRes] = await Promise.allSettled([
      client.getBlockNumber(),
      client.getBalance({ address: vault }),
      client.readContract({
        address: usdc,
        abi: ERC20_BALANCE_OF,
        functionName: "balanceOf",
        args: [vault],
      }),
      client.readContract({
        address: exchange,
        abi: ORDER_COUNTER,
        functionName: "orderCounter",
      }),
    ]);

    const anyOk = [blockRes, ethRes, usdcRes, counterRes].some(
      (r) => r.status === "fulfilled"
    );

    return {
      ok: anyOk,
      latestBlock:
        blockRes.status === "fulfilled" ? Number(blockRes.value) : null,
      vaultEth:
        ethRes.status === "fulfilled" ? formatEther(ethRes.value) : null,
      vaultUsdc:
        usdcRes.status === "fulfilled" ? formatUnits(usdcRes.value, 6) : null,
      orderCounter:
        counterRes.status === "fulfilled" ? Number(counterRes.value) : null,
    };
  } catch (e) {
    console.error("metrics: on-chain reads failed:", e);
    return { ...EMPTY_ONCHAIN };
  }
}

/** Aggregate both sources. Never throws; failed sources come back with ok: false. */
export async function getMetrics(): Promise<MetricsPayload> {
  const [subgraph, onchain] = await Promise.all([
    fetchSubgraphMetrics(),
    fetchOnchainMetrics(),
  ]);

  return {
    generatedAt: Date.now(),
    network: PILOT.network,
    addresses: {
      vault: PILOT.vault,
      exchange: PILOT.exchange,
      usdc: PILOT.usdc,
    },
    subgraph,
    onchain,
  };
}
