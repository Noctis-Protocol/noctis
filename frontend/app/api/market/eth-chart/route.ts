/**
 * Uniswap V2 pool chart for the desk pair (default WETH/USDC).
 * Query any listed Uniswap pair via ?base=&quote= — no CEX dependency.
 *
 * Ranges: 15m | 1h | 4h | 1d | 7d | 30d
 * Legacy ?days=1|7|30 still accepted.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Address } from "viem";
import {
  CHART_RANGES,
  fetchUniswapV2Chart,
  type ChartRange,
} from "@/lib/uniswapChart";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED = new Set<string>(CHART_RANGES);

const DAYS_ALIAS: Record<string, ChartRange> = {
  "1": "1d",
  "7": "7d",
  "30": "30d",
};

function parseRange(req: NextRequest): ChartRange {
  const range = req.nextUrl.searchParams.get("range");
  if (range && ALLOWED.has(range)) return range as ChartRange;
  const days = req.nextUrl.searchParams.get("days");
  if (days && DAYS_ALIAS[days]) return DAYS_ALIAS[days];
  if (days && ALLOWED.has(days)) return days as ChartRange;
  return "4h";
}

function isAddress(v: string | null): v is Address {
  return !!v && /^0x[a-fA-F0-9]{40}$/.test(v);
}

export async function GET(req: NextRequest) {
  try {
    const range = parseRange(req);
    const chainId = Number(
      req.nextUrl.searchParams.get("chainId") || "11155111"
    );
    const baseParam = req.nextUrl.searchParams.get("base");
    const quoteParam = req.nextUrl.searchParams.get("quote");

    const result = await fetchUniswapV2Chart({
      range,
      chainId: chainId === 1 ? 1 : 11155111,
      base: isAddress(baseParam) ? baseParam : undefined,
      quote: isAddress(quoteParam) ? quoteParam : undefined,
    });

    if (result.prices.length < 2) {
      return NextResponse.json(
        { error: "Not enough Uniswap pool activity in this range" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      pair: "ETH/USDC",
      pairAddress: result.pair,
      range,
      source: result.source,
      note: result.note,
      prices: result.prices,
      base: result.base,
      quote: result.quote,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "chart fetch failed";
    console.error("uniswap-chart:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
