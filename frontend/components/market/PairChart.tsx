"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { usePairChart, type ChartPoint, type ChartRange } from "@/hooks/useEthChart";
import { useUniswapPairLive } from "@/hooks/useUniswapPairLive";
import { cn } from "@/lib/utils";

/** Adaptive decimals: sub-$10 pairs (nDAI, nEUR) need more precision. */
function priceDigits(p: number | null | undefined): number {
  if (p == null || p <= 0) return 2;
  if (p < 10) return 4;
  if (p < 1000) return 2;
  return 2;
}

type ChartStyle = "line" | "candle";

const RANGES: { id: ChartRange; label: string }[] = [
  { id: "15m", label: "15m" },
  { id: "1h", label: "1H" },
  { id: "4h", label: "4H" },
  { id: "1d", label: "1D" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
];

/** Candle bucket size (seconds) per lookback — denser for short ranges. */
const CANDLE_BUCKET_SEC: Record<ChartRange, number> = {
  "15m": 60,
  "1h": 60,
  "4h": 5 * 60,
  "1d": 15 * 60,
  "7d": 60 * 60,
  "30d": 4 * 60 * 60,
};

function formatHoverTime(sec: number, range: ChartRange): string {
  const d = new Date(sec * 1000);
  if (range === "7d" || range === "30d") {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toLineData(points: ChartPoint[]) {
  const byTime = new Map<number, number>();
  for (const pt of points) {
    byTime.set(Math.floor(pt.t / 1000), pt.p);
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({
      time: time as Time,
      value,
    }));
}

function toCandleData(points: ChartPoint[], bucketSec: number) {
  type Bucket = { open: number; high: number; low: number; close: number };
  const buckets = new Map<number, Bucket>();
  const sorted = [...points].sort((a, b) => a.t - b.t);
  for (const pt of sorted) {
    const tSec = Math.floor(pt.t / 1000);
    const key = Math.floor(tSec / bucketSec) * bucketSec;
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, {
        open: pt.p,
        high: pt.p,
        low: pt.p,
        close: pt.p,
      });
    } else {
      cur.high = Math.max(cur.high, pt.p);
      cur.low = Math.min(cur.low, pt.p);
      cur.close = pt.p;
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, ohlc]) => ({
      time: time as UTCTimestamp,
      ...ohlc,
    }));
}

export function PairChart({ className }: { className?: string }) {
  const [range, setRange] = useState<ChartRange>("4h");
  const [style, setStyle] = useState<ChartStyle>("line");
  const pairLive = useUniswapPairLive();
  const { points, isLoading, error, source, live } = usePairChart(range);
  const midPrice = pairLive.midPrice ?? 0;
  const midLoading = !pairLive.isReady;

  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<
    ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null
  >(null);

  const [hover, setHover] = useState<{ price: number; time: number } | null>(
    null
  );

  const { changePct, minP, maxP, up } = useMemo(() => {
    if (points.length < 2) {
      return { changePct: 0, minP: 0, maxP: 0, up: true };
    }
    const prices = points.map((x) => x.p);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const first = points[0].p;
    const last = points[points.length - 1].p;
    const changePct = ((last - first) / first) * 100;
    return { changePct, minP, maxP, up: changePct >= 0 };
  }, [points]);

  const displayPrice = hover?.price ?? midPrice;
  const displayChange = useMemo(() => {
    if (!hover || points.length < 1) return changePct;
    const first = points[0].p;
    return ((hover.price - first) / first) * 100;
  }, [hover, points, changePct]);
  const displayUp = displayChange >= 0;

  // Chart shell (once)
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "hsl(160 6% 42%)",
        fontFamily: "var(--font-mono), ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "hsl(160 10% 88% / 0.55)" },
        horzLines: { color: "hsl(160 10% 88% / 0.55)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "hsl(162 42% 28% / 0.45)",
          width: 1,
          style: 2,
          labelBackgroundColor: "hsl(162 42% 28%)",
        },
        horzLine: {
          color: "hsl(162 42% 28% / 0.35)",
          width: 1,
          style: 2,
          labelBackgroundColor: "hsl(162 42% 28%)",
        },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        minBarSpacing: 0.5,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
    });

    chart.subscribeCrosshairMove((param) => {
      const series = seriesRef.current;
      if (!param.time || !series || !param.seriesData.size) {
        setHover(null);
        return;
      }
      const v = param.seriesData.get(series);
      if (!v) {
        setHover(null);
        return;
      }
      const price =
        "close" in v && typeof v.close === "number"
          ? v.close
          : "value" in v && typeof v.value === "number"
            ? v.value
            : null;
      const t = typeof param.time === "number" ? param.time : 0;
      if (price == null || !t) {
        setHover(null);
        return;
      }
      setHover({ price, time: t });
    });

    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Swap series type when style changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (seriesRef.current) {
      chart.removeSeries(seriesRef.current);
      seriesRef.current = null;
    }

    if (style === "candle") {
      seriesRef.current = chart.addSeries(CandlestickSeries, {
        upColor: "hsl(162 42% 32%)",
        downColor: "hsl(8 72% 48%)",
        borderUpColor: "hsl(162 42% 28%)",
        borderDownColor: "hsl(8 72% 42%)",
        wickUpColor: "hsl(162 42% 28%)",
        wickDownColor: "hsl(8 72% 42%)",
        priceLineVisible: false,
      });
    } else {
      seriesRef.current = chart.addSeries(AreaSeries, {
        lineColor: "hsl(162 42% 28%)",
        topColor: "hsla(162, 42%, 28%, 0.28)",
        bottomColor: "hsla(162, 42%, 28%, 0)",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerRadius: 4,
      });
    }
  }, [style]);

  // Push data
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || points.length < 2) return;

    if (style === "candle") {
      const candles = toCandleData(points, CANDLE_BUCKET_SEC[range]);
      if (candles.length < 1) return;
      (series as ISeriesApi<"Candlestick">).setData(candles);
    } else {
      const line = up ? "hsl(162 42% 28%)" : "hsl(8 72% 48%)";
      const area = series as ISeriesApi<"Area">;
      area.applyOptions({
        lineColor: line,
        topColor: up ? "hsla(162, 42%, 28%, 0.28)" : "hsla(8, 72%, 48%, 0.28)",
        bottomColor: up ? "hsla(162, 42%, 28%, 0)" : "hsla(8, 72%, 48%, 0)",
      });
      area.setData(toLineData(points));
    }
    chart.timeScale().fitContent();
    setHover(null);
  }, [points, up, style, range]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-display text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-ink-400">
            {pairLive.baseSymbol} / USDC
          </p>
          <p className="font-amount mt-1 text-2xl text-ink-900 sm:text-3xl">
            {midLoading && !displayPrice
              ? "—"
              : displayPrice.toLocaleString(undefined, {
                  maximumFractionDigits: priceDigits(displayPrice),
                })}
            <span className="font-display ml-2 text-sm font-bold text-ink-400">
              {hover
                ? formatHoverTime(hover.time, range)
                : live
                  ? "live"
                  : "Uniswap V2"}
            </span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="text-right">
            <p
              className={cn(
                "font-amount text-sm font-semibold",
                displayUp ? "text-brand-700" : "text-red-600"
              )}
            >
              {points.length
                ? `${displayUp ? "+" : ""}${displayChange.toFixed(2)}%`
                : "—"}
            </p>
            <p className="font-sans text-[0.65rem] text-ink-400">
              {hover
                ? "vs range open"
                : `${RANGES.find((r) => r.id === range)?.label} pool`}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <div
              className="flex gap-0.5 rounded-lg bg-ink-100/70 p-0.5"
              role="group"
              aria-label="Chart style"
            >
              {(
                [
                  { id: "line" as const, label: "Line" },
                  { id: "candle" as const, label: "Candle" },
                ] as const
              ).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStyle(s.id)}
                  className={cn(
                    "font-display rounded-md px-2 py-1 text-[0.65rem] font-semibold tracking-wide transition-colors",
                    style === s.id
                      ? "bg-white text-ink-900 shadow-sm"
                      : "text-ink-400 hover:text-ink-700"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div
              className="flex gap-0.5 rounded-lg bg-ink-100/70 p-0.5"
              role="group"
              aria-label="Chart range"
            >
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRange(r.id)}
                  className={cn(
                    "font-display min-w-[2.25rem] rounded-md px-2 py-1 text-[0.65rem] font-semibold tracking-wide transition-colors",
                    range === r.id
                      ? "bg-white text-ink-900 shadow-sm"
                      : "text-ink-400 hover:text-ink-700"
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="relative mt-3 h-52 w-full sm:h-64">
        {isLoading && (
          <div className="absolute inset-0 z-10 animate-pulse rounded-xl bg-ink-100/60" />
        )}
        {error && points.length < 2 && (
          <p className="absolute inset-0 z-10 flex items-center font-sans text-xs text-ink-400">
            Chart unavailable ({error}). Mid still from Uniswap.
          </p>
        )}
        <div
          ref={hostRef}
          className="h-full w-full touch-pan-y"
          aria-label={`${pairLive.baseSymbol} price chart`}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-sans text-[0.65rem] text-ink-400">
          Uniswap V2 {style === "candle" ? "OHLC from pool syncs" : "pool mid"}
          {source ? ` · ${source}` : ""} · scroll zoom · drag pan
          {minP > 0 && maxP > 0
            ? ` · $${minP.toFixed(priceDigits(minP) > 2 ? 3 : 0)}–$${maxP.toFixed(priceDigits(maxP) > 2 ? 3 : 0)}`
            : ""}
        </p>
        <button
          type="button"
          onClick={() => chartRef.current?.timeScale().fitContent()}
          className="font-display text-[0.65rem] font-semibold tracking-wide text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline"
        >
          Reset view
        </button>
      </div>
    </div>
  );
}
