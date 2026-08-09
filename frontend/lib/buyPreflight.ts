/**
 * BUY preflight (V2 — multi-token) — oracle-size the encrypted base-token leg
 * (so the on-chain USDC debit ≈ what the user typed) and warn when Uniswap
 * spot is far below Chainlink.
 * Exchange BUY floor is min(oracle, pool), so thin Sepolia pools can settle.
 */

import type { PublicClient } from "viem";
import {
  UNISWAP_V2_ROUTER,
  WETH,
  USDC,
  UNISWAP_ROUTER_ABI,
} from "@/lib/uniswapSepolia";
import { NATIVE_TOKEN } from "@/lib/contracts/abi";

export const MAX_MARKET_ORDER_SLIPPAGE_BPS = 300;

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

/** Trade parameters of the base token (from exchange.tradeConfigs). */
export interface BuyPreflightBase {
  /** address(0) = native ETH */
  address: `0x${string}`;
  decimals: number;
  /** Chainlink base/USD feed (8 decimals) */
  priceFeed: `0x${string}`;
  /** Pool path routes base→WETH→USDC when true */
  routeViaWeth: boolean;
}

export type BuyPreflightResult =
  | {
      ok: true;
      /** Encrypted base leg — oracle-sized so USDC debit ≈ user input */
      amountBase: bigint;
      poolBaseOut: bigint;
      oracleBaseFair: bigint;
      usdcNeeded: bigint;
      gapBps: number;
      warning?: string;
    }
  | {
      ok: false;
      reason: string;
      poolBaseOut?: bigint;
      oracleBaseFair?: bigint;
      gapBps?: number;
    };

/** USDC → base pool path, mirroring the contract's _swapPath. */
export function usdcToBasePath(base: BuyPreflightBase): `0x${string}`[] {
  if (base.address.toLowerCase() === NATIVE_TOKEN) return [USDC, WETH];
  return base.routeViaWeth ? [USDC, WETH, base.address] : [USDC, base.address];
}

export async function buyPreflight(
  publicClient: PublicClient,
  usdcHuman: number,
  slippageBps: number,
  base: BuyPreflightBase
): Promise<BuyPreflightResult> {
  if (!Number.isFinite(usdcHuman) || usdcHuman <= 0) {
    return { ok: false, reason: "Enter USDC to spend" };
  }

  const slip = Math.min(
    Math.max(1, Math.round(slippageBps)),
    MAX_MARKET_ORDER_SLIPPAGE_BPS
  );
  const usdcIn = BigInt(Math.floor(usdcHuman * 1e6));
  const baseUnit = 10n ** BigInt(base.decimals);

  let poolBaseOut: bigint;
  try {
    const amounts = await publicClient.readContract({
      address: UNISWAP_V2_ROUTER,
      abi: UNISWAP_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [usdcIn, usdcToBasePath(base)],
    });
    poolBaseOut = amounts[amounts.length - 1] ?? 0n;
  } catch {
    return { ok: false, reason: "Uniswap quote failed — try again" };
  }
  if (poolBaseOut <= 0n) {
    return { ok: false, reason: "Pool returned zero output for this size" };
  }

  let oraclePrice: bigint;
  try {
    const round = await publicClient.readContract({
      address: base.priceFeed,
      abi: FEED_ABI,
      functionName: "latestRoundData",
    });
    if (round[1] <= 0n) {
      return { ok: false, reason: "Chainlink price unavailable" };
    }
    oraclePrice = round[1];
  } catch {
    return { ok: false, reason: "Chainlink price unavailable" };
  }

  // On-chain BUY debit (see _prepareBuySufficiency):
  //   usdcNeeded = amountBase * price / 10^(baseDec + 2) * (1 + slip)
  // Size amountBase so debit ≈ usdcIn (what the user typed).
  const scale = 10n ** BigInt(base.decimals + 2);
  const amountBase = (usdcIn * scale) / oraclePrice;
  const usdcNeeded = (amountBase * oraclePrice) / scale;
  const usdcNeededWithSlip = (usdcNeeded * BigInt(10000 + slip)) / 10000n;
  const oracleBaseFair = (usdcNeededWithSlip * scale) / oraclePrice;
  const oracleFloor = (oracleBaseFair * BigInt(10000 - slip)) / 10000n;

  let gapBps = 0;
  let warning: string | undefined;
  if (oracleFloor > 0n && poolBaseOut < oracleFloor) {
    gapBps = Number(((oracleFloor - poolBaseOut) * 10000n) / oracleFloor);
    const humanOut = Number(poolBaseOut) / Number(baseUnit);
    warning = `Sepolia pool is ~${(gapBps / 100).toFixed(1)}% below oracle — you receive Uniswap spot (~${humanOut.toFixed(6)}), not Chainlink fair.`;
  }

  return {
    ok: true,
    amountBase,
    poolBaseOut,
    oracleBaseFair,
    usdcNeeded: usdcNeededWithSlip,
    gapBps,
    warning,
  };
}
