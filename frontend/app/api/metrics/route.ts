/**
 * Public protocol metrics — aggregated server-side (subgraph + Sepolia RPC).
 *
 * Cached for 60 seconds via ISR so browsers hit one endpoint and public RPCs
 * are queried at most once per minute regardless of traffic. Sources that
 * fail return ok: false and the page renders with partial data.
 */

import { NextResponse } from "next/server";
import { getMetrics } from "@/lib/metrics";

export const revalidate = 60;

export async function GET() {
  const payload = await getMetrics();

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
    },
  });
}
