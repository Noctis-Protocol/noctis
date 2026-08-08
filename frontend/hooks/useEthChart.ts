/**
 * Uniswap V2 pool chart — history from API, live tip from Sync events.
 */

"use client";

import { useEffect, useState } from "react";
import { useUniswapPairLive } from "./useUniswapPairLive";

export type ChartRange = "15m" | "1h" | "4h" | "1d" | "7d" | "30d";

export interface ChartPoint {
  t: number;
  p: number;
}

const RANGE_SECONDS: Record<ChartRange, number> = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

function trimToRange(points: ChartPoint[], range: ChartRange): ChartPoint[] {
  const cutoff = Date.now() - RANGE_SECONDS[range] * 1000;
  return points.filter((p) => p.t >= cutoff);
}

export function useEthChart(range: ChartRange = "4h") {
  const live = useUniswapPairLive();
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);

  // Historical bootstrap + slow repair
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    async function load() {
      try {
        const res = await fetch(
          `/api/market/eth-chart?range=${encodeURIComponent(range)}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "chart failed");
        const next = (data.prices || []) as ChartPoint[];
        if (!cancelled) {
          setPoints((prev) => {
            // Keep any live tip newer than history
            const lastHist = next[next.length - 1]?.t ?? 0;
            const liveTail = prev.filter((p) => p.t > lastHist);
            return trimToRange([...next, ...liveTail], range);
          });
          setSource(data.source || "uniswap-v2");
          setError(next.length < 2 ? "Not enough pool activity" : null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "chart failed");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    const id = setInterval(load, 120_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [range]);

  // Live tip on Sync / heartbeat
  useEffect(() => {
    if (live.midPrice == null || live.tick === 0) return;
    const t = live.lastSyncAt ?? Date.now();
    const p = live.midPrice;
    setPoints((prev) => {
      const last = prev[prev.length - 1];
      // Skip no-op duplicates within 2s
      if (last && Math.abs(last.p - p) < 1e-9 && t - last.t < 2_000) {
        return prev;
      }
      // Update last candle tip if same second bucket
      if (last && Math.floor(last.t / 1000) === Math.floor(t / 1000)) {
        const copy = prev.slice(0, -1);
        copy.push({ t, p });
        return trimToRange(copy, range);
      }
      return trimToRange([...prev, { t, p }], range);
    });
    setSource("uniswap-v2");
    setError(null);
  }, [live.tick, live.midPrice, live.lastSyncAt, range]);

  return {
    points,
    isLoading: isLoading && points.length < 2,
    error,
    source,
    live: live.isReady,
  };
}
