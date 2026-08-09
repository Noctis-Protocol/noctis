/**
 * @file Monitoring checks for the Noctis Sepolia desk
 * @description Each check is self-contained, returns a CheckResult and never
 * throws. Checks that depend on optional infrastructure (subgraph, missing
 * getters) degrade to `skipped` instead of failing.
 */
import { ethers, formatEther } from 'ethers';
import type { Severity } from './alerts';
import type { MonitorConfig } from './config';
import { redactUrl } from './config';

export interface CheckResult {
  ok: boolean;
  /** Check could not run for a benign reason (missing config, optional dep). */
  skipped?: boolean;
  /** Severity to use when the check is failing. */
  severity: Severity;
  summary: string;
  details: Record<string, unknown>;
}

export interface CheckDef {
  /** Stable key — also used as the alert deduplication key. */
  name: string;
  intervalMs: number;
  run: () => Promise<CheckResult>;
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

async function querySubgraph(url: string, query: string): Promise<any> {
  const { status, json } = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (status !== 200) throw new Error(`subgraph HTTP ${status}`);
  if (json.errors?.length) throw new Error(`subgraph error: ${JSON.stringify(json.errors[0])}`);
  return json.data;
}

/**
 * Build the full check list. Some checks keep private state between runs
 * (chain-head progression, cached relayer address), hence the factory.
 */
export function buildChecks(cfg: MonitorConfig): CheckDef[] {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);

  const pausedAbi = ['function paused() view returns (bool)'];
  const exchange = cfg.exchange ? new ethers.Contract(cfg.exchange, pausedAbi, provider) : null;
  const vault = cfg.vault ? new ethers.Contract(cfg.vault, pausedAbi, provider) : null;

  // ── 1. Relayer HTTP health ───────────────────────────────────────────
  let cachedRelayerFromHealth = '';
  const relayerHealth: CheckDef = {
    name: 'relayer-health',
    intervalMs: cfg.intervals.relayerHealth,
    run: async () => {
      try {
        const { status, json } = await fetchJson(cfg.relayerHealthUrl);
        const healthy = status === 200 && json.status !== 'degraded' && json.status !== 'error';
        if (typeof json.relayer === 'string') cachedRelayerFromHealth = json.relayer;
        // Never echo the raw `rpc` field — it may embed an API key.
        const { rpc: _rpc, ...safe } = json;
        return {
          ok: healthy,
          severity: 'critical',
          summary: healthy
            ? `relayer healthy (HTTP ${status})`
            : `relayer degraded (HTTP ${status}, status=${json.status ?? 'n/a'})`,
          details: { httpStatus: status, health: safe },
        };
      } catch (e: any) {
        return {
          ok: false,
          severity: 'critical',
          summary: 'relayer unreachable',
          details: { url: redactUrl(cfg.relayerHealthUrl), error: e.message || String(e) },
        };
      }
    },
  };

  // ── 2. RPC reachability + chain head advancing ───────────────────────
  let lastHead = 0;
  let lastHeadChangeAt = 0;
  const rpcHead: CheckDef = {
    name: 'rpc-chain-head',
    intervalMs: cfg.intervals.rpc,
    run: async () => {
      try {
        const head = await provider.getBlockNumber();
        const now = Date.now();
        if (head !== lastHead) {
          lastHead = head;
          lastHeadChangeAt = now;
        }
        const stalledMs = lastHeadChangeAt ? now - lastHeadChangeAt : 0;
        const stalled = stalledMs > cfg.chainStallMs;
        return {
          ok: !stalled,
          severity: 'critical',
          summary: stalled
            ? `chain head stuck at ${head} for ${Math.round(stalledMs / 1000)}s`
            : `chain head ${head}`,
          details: {
            head,
            rpc: redactUrl(cfg.rpcUrl),
            secondsSinceHeadChange: Math.round(stalledMs / 1000),
          },
        };
      } catch (e: any) {
        return {
          ok: false,
          severity: 'critical',
          summary: 'RPC unreachable',
          details: { rpc: redactUrl(cfg.rpcUrl), error: e.shortMessage || e.message || String(e) },
        };
      }
    },
  };

  // ── 3. Relayer wallet ETH balance ────────────────────────────────────
  const relayerBalance: CheckDef = {
    name: 'relayer-balance',
    intervalMs: cfg.intervals.balance,
    run: async () => {
      const address = cfg.relayerAddress || cachedRelayerFromHealth;
      if (!address) {
        return {
          ok: true,
          skipped: true,
          severity: 'warn',
          summary: 'relayer address unknown — skipped',
          details: { hint: 'set EXPECTED_RELAYER or let the health check discover it' },
        };
      }
      try {
        const bal = await provider.getBalance(address);
        const threshold = ethers.parseEther(cfg.minRelayerEth);
        const low = bal < threshold;
        return {
          ok: !low,
          severity: 'critical',
          summary: low
            ? `relayer ETH low: ${formatEther(bal)} < ${cfg.minRelayerEth}`
            : `relayer ETH ok: ${formatEther(bal)}`,
          details: { relayer: address, balanceEth: formatEther(bal), minEth: cfg.minRelayerEth },
        };
      } catch (e: any) {
        return {
          ok: false,
          severity: 'warn',
          summary: 'balance read failed',
          details: { relayer: address, error: e.shortMessage || e.message || String(e) },
        };
      }
    },
  };

  // ── 4. Contracts paused ──────────────────────────────────────────────
  const contractsPaused: CheckDef = {
    name: 'contracts-paused',
    intervalMs: cfg.intervals.paused,
    run: async () => {
      const details: Record<string, unknown> = {};
      const pausedNames: string[] = [];
      let readable = 0;

      const targets: Array<[string, ethers.Contract | null]> = [
        ['exchange', exchange],
        ['vault', vault],
      ];
      for (const [label, contract] of targets) {
        if (!contract) {
          details[label] = 'address not configured';
          continue;
        }
        try {
          const paused = (await contract.paused()) as boolean;
          details[`${label}Paused`] = paused;
          readable++;
          if (paused) pausedNames.push(label);
        } catch {
          // Getter missing or call reverted — skip gracefully per contract.
          details[`${label}Paused`] = 'unavailable';
        }
      }

      if (readable === 0) {
        return {
          ok: true,
          skipped: true,
          severity: 'critical',
          summary: 'paused() not readable on any contract — skipped',
          details,
        };
      }
      return {
        ok: pausedNames.length === 0,
        severity: 'critical',
        summary:
          pausedNames.length > 0
            ? `contracts PAUSED: ${pausedNames.join(', ')}`
            : 'contracts not paused',
        details,
      };
    },
  };

  // ── 5. Subgraph lag / indexing errors ────────────────────────────────
  const subgraphLag: CheckDef = {
    name: 'subgraph-lag',
    intervalMs: cfg.intervals.subgraph,
    run: async () => {
      if (!cfg.subgraphUrl) {
        return {
          ok: true,
          skipped: true,
          severity: 'warn',
          summary: 'SUBGRAPH_URL not set — skipped',
          details: {},
        };
      }
      try {
        const data = await querySubgraph(
          cfg.subgraphUrl,
          '{ _meta { block { number } hasIndexingErrors } }'
        );
        const subgraphBlock = Number(data?._meta?.block?.number || 0);
        const hasErrors = Boolean(data?._meta?.hasIndexingErrors);
        const head = await provider.getBlockNumber();
        const lag = Math.max(0, head - subgraphBlock);
        const lagging = lag > cfg.subgraphLagBlocks;
        const failures: string[] = [];
        if (hasErrors) failures.push('indexing errors');
        if (lagging) failures.push(`lag ${lag} blocks (max ${cfg.subgraphLagBlocks})`);
        return {
          ok: failures.length === 0,
          severity: 'warn',
          summary:
            failures.length > 0 ? `subgraph unhealthy: ${failures.join(', ')}` : `subgraph in sync (lag ${lag})`,
          details: { subgraphBlock, chainHead: head, lagBlocks: lag, hasIndexingErrors: hasErrors },
        };
      } catch (e: any) {
        return {
          ok: false,
          severity: 'warn',
          summary: 'subgraph unreachable',
          details: { url: redactUrl(cfg.subgraphUrl), error: e.message || String(e) },
        };
      }
    },
  };

  // ── 6. Stuck orders (subgraph) ───────────────────────────────────────
  const stuckOrders: CheckDef = {
    name: 'stuck-orders',
    intervalMs: cfg.intervals.stuckOrders,
    run: async () => {
      if (!cfg.subgraphUrl) {
        return {
          ok: true,
          skipped: true,
          severity: 'warn',
          summary: 'SUBGRAPH_URL not set — skipped',
          details: {},
        };
      }
      const cutoff = Math.floor(Date.now() / 1000) - cfg.stuckOrderMaxAgeMin * 60;
      // Order schema has no "Executing" status: a PENDING order with
      // swapRequested=true is mid-execution; both cases count as stuck.
      const query = `{
        orders(
          first: 50
          where: { status: PENDING, createdAt_lt: "${cutoff}" }
          orderBy: createdAt
          orderDirection: asc
        ) { orderId status createdAt swapRequested }
      }`;
      try {
        const data = await querySubgraph(cfg.subgraphUrl, query);
        const orders: Array<{ orderId: string; createdAt: string; swapRequested: boolean | null }> =
          data?.orders || [];
        const list = orders.map((o) => ({
          orderId: o.orderId,
          ageMin: Math.round((Date.now() / 1000 - Number(o.createdAt)) / 60),
          executing: Boolean(o.swapRequested),
        }));
        return {
          ok: orders.length === 0,
          severity: 'warn',
          summary:
            orders.length > 0
              ? `${orders.length} order(s) pending > ${cfg.stuckOrderMaxAgeMin} min`
              : 'no stuck orders',
          details: { maxAgeMin: cfg.stuckOrderMaxAgeMin, stuck: list },
        };
      } catch (e: any) {
        // Subgraph entity/fields unavailable — skip rather than alert.
        return {
          ok: true,
          skipped: true,
          severity: 'warn',
          summary: 'stuck-orders query unavailable — skipped',
          details: { error: e.message || String(e) },
        };
      }
    },
  };

  // ── 7. Relayer gas budget / anti-grief policy ─────────────────────────
  // The relayer only recovers gas at settlement (gas-in-kind refund), so a
  // high wasted ratio or a burning budget means someone is grief-spending
  // the float. Stats are aggregate-only — no vaultIds/orderIds.
  const policyUrl = cfg.relayerHealthUrl.replace(/\/health$/, '/policyStats');
  const gasPolicy: CheckDef = {
    name: 'relayer-gas-policy',
    intervalMs: cfg.intervals.gasPolicy,
    run: async () => {
      try {
        const { status, json } = await fetchJson(policyUrl);
        if (status === 404) {
          return {
            ok: true,
            skipped: true,
            severity: 'warn',
            summary: 'policyStats endpoint not available — skipped',
            details: { url: redactUrl(policyUrl) },
          };
        }
        if (status !== 200) throw new Error(`HTTP ${status}`);
        const usedPct = Number(json.budgetUsedPct ?? 0);
        const exhausted = Boolean(json.budgetExhausted);
        const failures: string[] = [];
        if (exhausted) failures.push('gas budget EXHAUSTED — relayed creations refused');
        else if (usedPct >= cfg.gasBudgetWarnPct)
          failures.push(`gas budget ${usedPct}% consumed (warn at ${cfg.gasBudgetWarnPct}%)`);
        return {
          ok: failures.length === 0,
          severity: exhausted ? 'critical' : 'warn',
          summary:
            failures.length > 0
              ? `relayer gas policy: ${failures.join(', ')}`
              : `gas budget ${usedPct}% used, settle ratio ${json.settleRatio ?? 'n/a'}`,
          details: {
            budgetUsedPct: usedPct,
            gasSpent24hWei: json.gasSpent24hWei,
            dailyGasBudgetWei: json.dailyGasBudgetWei,
            settleRatio: json.settleRatio,
            inflightTotal: json.inflightTotal,
            throttledVaults: json.throttledVaults,
          },
        };
      } catch (e: any) {
        // Reachability alerts belong to relayer-health; skip instead of duplicating.
        return {
          ok: true,
          skipped: true,
          severity: 'warn',
          summary: 'policyStats unreachable — skipped (relayer-health covers downtime)',
          details: { url: redactUrl(policyUrl), error: e.message || String(e) },
        };
      }
    },
  };

  return [relayerHealth, rpcHead, relayerBalance, contractsPaused, subgraphLag, stuckOrders, gasPolicy];
}
