"use client";

/**
 * Binance-style depth ladder from Uniswap V2 quotes (still an AMM, not a CLOB).
 * Top = asks (buy ETH) · mid/spread · bottom = bids (sell ETH).
 */

import { usePoolDepth, type DepthLevel } from "@/hooks/usePoolDepth";
import { cn } from "@/lib/utils";

function LevelRow({
  side,
  level,
  maxImpact,
}: {
  side: "ask" | "bid";
  level: DepthLevel;
  maxImpact: number;
}) {
  const width = maxImpact > 0 ? Math.min(100, (level.impactPct / maxImpact) * 100) : 6;
  const isAsk = side === "ask";
  return (
    <div className="relative grid grid-cols-[1fr_1.1fr_1fr] items-center gap-1 px-1.5 py-[3px] font-amount text-[0.7rem] leading-none">
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 opacity-[0.14]",
          isAsk ? "right-0 bg-red-500" : "left-0 bg-brand-600"
        )}
        style={{ width: `${Math.max(width, 4)}%` }}
        aria-hidden
      />
      <span className={cn("relative", isAsk ? "text-ink-500" : "text-ink-800")}>
        {level.sizeEth.toFixed(level.sizeEth < 0.1 ? 3 : 2)}
      </span>
      <span
        className={cn(
          "relative text-center font-semibold",
          isAsk ? "text-red-600" : "text-brand-700"
        )}
      >
        {level.price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      </span>
      <span
        className={cn(
          "relative text-right",
          isAsk ? "text-red-600/80" : "text-brand-700/80"
        )}
      >
        {level.impactPct.toFixed(1)}%
      </span>
    </div>
  );
}

export function PoolDepth({ className }: { className?: string }) {
  const {
    midPrice,
    spreadBps,
    bestAsk,
    bestBid,
    reserveEth,
    reserveUsdc,
    asks,
    bids,
    isLoading,
    error,
  } = usePoolDepth();

  const maxImpact = Math.max(
    0.01,
    ...asks.map((l) => l.impactPct),
    ...bids.map((l) => l.impactPct)
  );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-display text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ink-400">
          Pool depth
        </p>
        <p className="font-sans text-[0.65rem] text-ink-400">
          Uniswap V2 · live Sync
        </p>
      </div>

      {isLoading && (
        <div className="mt-4 h-48 animate-pulse rounded-xl bg-ink-100/60" />
      )}
      {error && (
        <p className="mt-4 font-sans text-xs text-amber-700">{error}</p>
      )}

      {!isLoading && !error && (
        <>
          <div className="mt-3 grid grid-cols-[1fr_1.1fr_1fr] gap-1 border-b border-ink-200/70 px-1.5 pb-1 font-sans text-[0.6rem] uppercase tracking-wide text-ink-400">
            <span>Size</span>
            <span className="text-center">Price</span>
            <span className="text-right">Impact</span>
          </div>

          {/* Asks — buy ETH, far (expensive) at top → best ask at bottom */}
          <div className="mt-1 space-y-px">
            <p className="px-1.5 pb-0.5 font-sans text-[0.6rem] uppercase tracking-wide text-red-600/70">
              Ask · buy ETH
            </p>
            {asks.map((l) => (
              <LevelRow
                key={`a-${l.sizeEth}-${l.price}`}
                side="ask"
                level={l}
                maxImpact={maxImpact}
              />
            ))}
          </div>

          {/* Mid + spread block (Binance-style center) */}
          <div className="my-1.5 border-y border-ink-300/80 bg-ink-100/40 px-2 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 text-left">
                <p className="font-sans text-[0.6rem] uppercase tracking-wide text-red-600/80">
                  Ask
                </p>
                <p className="font-amount text-xs text-red-600">
                  {bestAsk != null
                    ? bestAsk.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })
                    : "—"}
                </p>
              </div>
              <div className="text-center">
                <p className="font-amount text-base font-semibold text-ink-900">
                  {midPrice != null
                    ? midPrice.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })
                    : "—"}
                </p>
                <p className="font-sans text-[0.65rem] text-ink-500">
                  mid
                  {spreadBps != null
                    ? ` · spread ${spreadBps.toFixed(1)} bps`
                    : ""}
                </p>
              </div>
              <div className="min-w-0 text-right">
                <p className="font-sans text-[0.6rem] uppercase tracking-wide text-brand-700/80">
                  Bid
                </p>
                <p className="font-amount text-xs text-brand-700">
                  {bestBid != null
                    ? bestBid.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })
                    : "—"}
                </p>
              </div>
            </div>
          </div>

          {/* Bids — sell ETH, best bid at top → far (cheap) at bottom */}
          <div className="space-y-px">
            <p className="px-1.5 pb-0.5 font-sans text-[0.6rem] uppercase tracking-wide text-brand-700/70">
              Bid · sell ETH
            </p>
            {bids.map((l) => (
              <LevelRow
                key={`b-${l.sizeEth}-${l.price}`}
                side="bid"
                level={l}
                maxImpact={maxImpact}
              />
            ))}
          </div>

          <p className="mt-3 font-sans text-[0.65rem] leading-relaxed text-ink-400">
            Liquidity:{" "}
            <span className="font-amount text-ink-600">
              {reserveEth != null ? reserveEth.toFixed(2) : "—"} ETH
            </span>
            {" · "}
            <span className="font-amount text-ink-600">
              {reserveUsdc != null
                ? reserveUsdc.toLocaleString(undefined, {
                    maximumFractionDigits: 0,
                  })
                : "—"}{" "}
              USDC
            </span>
            . AMM ladder via{" "}
            <span className="font-mono text-[0.6rem]">getAmountsOut</span> — not
            resting limit orders.
          </p>
        </>
      )}
    </div>
  );
}
