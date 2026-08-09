"use client";

/**
 * Public metrics dashboard — one fetch to /api/metrics (server-cached 60s).
 * Renders whatever came back; a failed source degrades to em-dashes,
 * never to a broken page.
 */

import { useEffect, useState } from "react";
import type { MetricsPayload, OrdersPerDayPoint } from "@/lib/metrics";

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US");
}

function formatAmount(
  value: string | null | undefined,
  maxDecimals: number
): string {
  if (value === null || value === undefined) return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}

function StatCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-2xl border border-border/80 bg-white/60 px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
        {label}
      </p>
      {loading ? (
        <div className="mt-2 h-8 w-24 animate-pulse rounded-md bg-ink-100" />
      ) : (
        <p className="mt-1.5 font-amount text-[1.7rem] font-semibold leading-tight tracking-tight text-ink-900 tabular">
          {value}
        </p>
      )}
      {hint && <p className="mt-1 text-xs leading-relaxed text-ink-400">{hint}</p>}
    </div>
  );
}

function OrdersPerDayChart({ points }: { points: OrdersPerDayPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));

  return (
    <div>
      <div className="flex h-32 items-end gap-1.5 sm:gap-2">
        {points.map((p) => (
          <div
            key={p.day}
            className="group relative flex h-full flex-1 flex-col justify-end"
            title={`${p.day} · ${p.count} order${p.count === 1 ? "" : "s"}`}
          >
            <div
              className={`w-full rounded-t-sm transition-colors ${
                p.count > 0
                  ? "bg-brand-500 group-hover:bg-brand-600"
                  : "bg-ink-100"
              }`}
              style={{
                height: p.count > 0 ? `${Math.max(8, (p.count / max) * 100)}%` : "3px",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[0.65rem] font-medium uppercase tracking-wide text-ink-400">
        <span>{points[0]?.day.slice(5)}</span>
        <span>Orders created per day (UTC) · last 14 days</span>
        <span>{points[points.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

export function MetricsDashboard() {
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/metrics")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<MetricsPayload>;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = !data && !failed;
  const sg = data?.subgraph;
  const oc = data?.onchain;

  const pending =
    sg?.totalOrders != null &&
    sg.totalOrdersFilled != null &&
    sg.totalOrdersCancelled != null
      ? Math.max(0, sg.totalOrders - sg.totalOrdersFilled - sg.totalOrdersCancelled)
      : null;

  const blockLag =
    sg?.headBlock != null && oc?.latestBlock != null
      ? Math.max(0, oc.latestBlock - sg.headBlock)
      : null;

  const updatedAt = data
    ? new Date(data.generatedAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "UTC",
        hour12: false,
      }) + " UTC"
    : null;

  return (
    <div className="space-y-14">
      {failed && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/90 px-5 py-4 text-sm text-amber-950">
          Metrics are temporarily unavailable. The desk itself is unaffected —
          try refreshing in a minute.
        </div>
      )}

      {/* Order lifecycle (subgraph) */}
      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <h2 className="font-display text-xl font-bold tracking-[-0.035em] text-ink-800">
            Order lifecycle
          </h2>
          <p className="text-xs text-ink-400">
            Indexed from public events · sizes stay encrypted
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total orders"
            value={formatCount(sg?.totalOrders)}
            loading={loading}
          />
          <StatCard
            label="Filled"
            value={formatCount(sg?.totalOrdersFilled)}
            loading={loading}
          />
          <StatCard
            label="Cancelled"
            value={formatCount(sg?.totalOrdersCancelled)}
            loading={loading}
          />
          <StatCard
            label="Open"
            value={formatCount(pending)}
            loading={loading}
          />
        </div>
        <div className="mt-6 rounded-2xl border border-border/80 bg-white/60 p-5 sm:p-6">
          {loading ? (
            <div className="h-36 animate-pulse rounded-lg bg-ink-100/70" />
          ) : sg?.ok && sg.ordersPerDay.length > 0 ? (
            <OrdersPerDayChart points={sg.ordersPerDay} />
          ) : (
            <p className="py-12 text-center text-sm text-ink-400">
              Order history unavailable right now.
            </p>
          )}
        </div>
      </section>

      {/* Vault & exchange (on-chain reads) */}
      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <h2 className="font-display text-xl font-bold tracking-[-0.035em] text-ink-800">
            Vault &amp; exchange
          </h2>
          <p className="text-xs text-ink-400">Read live from Sepolia</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Vault ETH"
            value={formatAmount(oc?.vaultEth, 4)}
            hint="Native balance of the vault contract"
            loading={loading}
          />
          <StatCard
            label="Vault USDC"
            value={formatAmount(oc?.vaultUsdc, 2)}
            hint="ERC-20 balance (USDT slot on Sepolia)"
            loading={loading}
          />
          <StatCard
            label="Order counter"
            value={formatCount(oc?.orderCounter)}
            hint="orderCounter() on the exchange"
            loading={loading}
          />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-400">
          Aggregate vault balances are visible to anyone on-chain. How that
          total splits across depositors is encrypted per user.
        </p>
      </section>

      {/* Public flows (subgraph) */}
      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <h2 className="font-display text-xl font-bold tracking-[-0.035em] text-ink-800">
            Public flows
          </h2>
          <p className="text-xs text-ink-400">
            Deposits and withdrawals are attributable by design
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Deposits"
            value={formatCount(sg?.totalDeposits)}
            loading={loading}
          />
          <StatCard
            label="Withdrawals"
            value={formatCount(sg?.totalWithdrawals)}
            loading={loading}
          />
          <StatCard
            label="ETH deposited"
            value={formatAmount(sg?.totalDepositedETH, 4)}
            hint="Lifetime, all wallets"
            loading={loading}
          />
          <StatCard
            label="Depositor wallets"
            value={formatCount(sg?.totalUsers)}
            loading={loading}
          />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-400">
          Settled swap volume is not shown: order sizes are FHE ciphertexts and
          the pilot subgraph intentionally indexes no amounts for orders. Fill
          sizes are only visible at the moment Uniswap executes.
        </p>
      </section>

      {/* Freshness */}
      <section>
        <div className="overflow-hidden rounded-2xl border border-border/80 bg-white/60">
          <div className="border-b border-border/60 px-5 py-3 text-xs font-medium uppercase tracking-[0.14em] text-ink-400">
            Data freshness
          </div>
          <div className="grid gap-0 sm:grid-cols-3">
            <div className="px-5 py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Subgraph head
              </p>
              <p className="mt-1.5 font-mono text-sm text-ink-800 tabular">
                {sg?.headBlock != null
                  ? `#${sg.headBlock.toLocaleString("en-US")}`
                  : "—"}
              </p>
            </div>
            <div className="border-t border-border/60 px-5 py-4 sm:border-l sm:border-t-0">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Chain tip
              </p>
              <p className="mt-1.5 font-mono text-sm text-ink-800 tabular">
                {oc?.latestBlock != null
                  ? `#${oc.latestBlock.toLocaleString("en-US")}`
                  : "—"}
              </p>
            </div>
            <div className="border-t border-border/60 px-5 py-4 sm:border-l sm:border-t-0">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-400">
                Status
              </p>
              <p className="mt-1.5 flex items-center gap-2 text-sm text-ink-800">
                {blockLag != null ? (
                  <>
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        blockLag <= 10
                          ? "bg-brand-500 animate-soft-pulse"
                          : "bg-amber-500 animate-soft-pulse"
                      }`}
                      aria-hidden
                    />
                    {blockLag <= 10 ? "Live" : `${blockLag.toLocaleString("en-US")} blocks behind`}
                  </>
                ) : (
                  "—"
                )}
              </p>
            </div>
          </div>
        </div>
        {updatedAt && (
          <p className="mt-3 text-xs text-ink-400">
            Snapshot generated at {updatedAt}. Refreshed server-side at most
            once per minute.
          </p>
        )}
      </section>
    </div>
  );
}
