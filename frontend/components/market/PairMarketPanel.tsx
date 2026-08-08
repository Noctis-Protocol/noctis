"use client";

/**
 * Market context for the selected desk pair (ETH/USDC).
 * Chart = Uniswap V2 pool mid history · Depth = AMM ladder (not a CLOB).
 */

import { PairChart } from "./PairChart";
import { PoolDepth } from "./PoolDepth";

export function PairMarketPanel() {
  return (
    <section
      className="animate-fade-up border-b border-ink-200/70 pb-8"
      aria-label="ETH USDC market"
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(240px,0.85fr)] lg:gap-10">
        <PairChart />
        <PoolDepth />
      </div>
    </section>
  );
}
