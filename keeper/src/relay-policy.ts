/**
 * @file Relayer economic anti-grief policy
 * @description The gas-in-kind refund is only collected at settlement, so a
 * relayed order that is created then cancelled (or never executed) is pure
 * gas loss for the relayer. This module bounds that exposure OFF-CHAIN — no
 * contract change, nothing new revealed on-chain, so the privacy model is
 * untouched (the relayer already knows which vaultIds it relays for):
 *
 *  1. In-flight cap: max N relayed orders per vaultId that have not reached
 *     a terminal state (settled / cancelled / expired).
 *  2. Settlement-ratio throttle: vaults whose relayed orders keep ending
 *     without settlement (cancel spam) are refused for a cooldown period,
 *     then given a fresh window. They can always trade via the direct
 *     (self-paid) path.
 *  3. Global rolling 24h gas budget: once the relayer has burned the
 *     configured amount of gas, new relayed creations/cancels are refused
 *     until spend rolls out of the window. Executions (which collect the
 *     refund) are never budget-blocked.
 *
 * PRIVACY: per-vaultId accounting lives only in the local state file. The
 * stats() surface exposed over HTTP is aggregate-only (counts and totals,
 * never vaultIds or orderIds).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface RelayPolicyConfig {
  /** Max non-terminal relayed orders per vaultId (default 2). */
  maxInflightPerVault: number;
  /** Below this settled/(settled+wasted) ratio a vault is throttled (default 0.5). */
  minSettleRatio: number;
  /** Terminal orders required before the ratio is enforced (default 5). */
  ratioMinSample: number;
  /** How long a throttled vault is refused relaying (default 6h). */
  throttleCooldownMs: number;
  /** In-flight orders older than this count as wasted (default 2h). */
  inflightTtlMs: number;
  /** Rolling 24h relayer gas budget in wei (default 0.2 ETH). 0 disables. */
  dailyGasBudgetWei: bigint;
  /** JSON state file; empty string disables persistence (tests). */
  statePath: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface PolicyDecision {
  allowed: boolean;
  /** Machine-readable refusal reason. */
  reason?: 'gas_budget_exhausted' | 'vault_throttled' | 'inflight_cap';
  /** Suggested HTTP status (429 per-vault, 503 global). */
  httpStatus?: number;
  /** Human hint returned to the client. */
  hint?: string;
}

interface VaultStats {
  /** orderId -> createdAt (ms). */
  inflight: Record<string, number>;
  settled: number;
  wasted: number;
  throttledUntil: number;
}

interface PersistedState {
  vaults: Record<string, VaultStats>;
  /** orderId -> vaultId, so lifecycle events can be attributed. */
  orderVault: Record<string, string>;
  /** Rolling gas spend entries: [timestamp ms, wei as string]. */
  gasSpend: Array<[number, string]>;
}

const GAS_WINDOW_MS = 24 * 60 * 60 * 1000;

function emptyState(): PersistedState {
  return { vaults: {}, orderVault: {}, gasSpend: [] };
}

export function loadPolicyConfigFromEnv(defaultsDir: string): RelayPolicyConfig {
  const num = (name: string, def: number): number => {
    const v = parseFloat(process.env[name] || '');
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  const budgetEth = process.env.RELAY_DAILY_GAS_BUDGET_ETH || '0.2';
  let budgetWei = 0n;
  try {
    // parseEther without importing ethers here: eth * 1e18 via string math
    const [int, frac = ''] = budgetEth.split('.');
    budgetWei = BigInt(int || '0') * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
  } catch {
    budgetWei = 200_000_000_000_000_000n; // 0.2 ETH
  }
  return {
    maxInflightPerVault: num('RELAY_MAX_INFLIGHT_PER_VAULT', 2),
    minSettleRatio: num('RELAY_MIN_SETTLE_RATIO', 0.5),
    ratioMinSample: num('RELAY_RATIO_MIN_SAMPLE', 5),
    throttleCooldownMs: num('RELAY_THROTTLE_COOLDOWN_MS', 6 * 60 * 60 * 1000),
    inflightTtlMs: num('RELAY_INFLIGHT_TTL_MS', 2 * 60 * 60 * 1000),
    dailyGasBudgetWei: budgetWei,
    statePath:
      process.env.RELAY_POLICY_STATE_PATH || path.join(defaultsDir, 'relay-policy.json'),
  };
}

export class RelayPolicy {
  private readonly cfg: RelayPolicyConfig;
  private readonly now: () => number;
  private state: PersistedState = emptyState();

  constructor(cfg: RelayPolicyConfig) {
    this.cfg = cfg;
    this.now = cfg.now ?? Date.now;
    this.load();
  }

  // ── Decisions ──────────────────────────────────────────────────────────

  /** Gate for POST /api/relay/createOrder. */
  checkCreate(vaultId: string): PolicyDecision {
    this.expireStaleInflight();
    const budget = this.checkGasBudget();
    if (!budget.allowed) return budget;

    const v = this.state.vaults[vaultId];
    if (!v) return { allowed: true };

    const nowMs = this.now();
    if (v.throttledUntil > nowMs) {
      return {
        allowed: false,
        reason: 'vault_throttled',
        httpStatus: 429,
        hint:
          'Too many relayed orders ended without settlement. ' +
          'Retry later or trade via the direct (self-paid) path.',
      };
    }
    if (Object.keys(v.inflight).length >= this.cfg.maxInflightPerVault) {
      return {
        allowed: false,
        reason: 'inflight_cap',
        httpStatus: 429,
        hint: 'Settle or cancel your pending relayed orders first.',
      };
    }
    return { allowed: true };
  }

  /** Gate for relayed cancels (order can always be cancelled directly, self-paid). */
  checkCancel(): PolicyDecision {
    return this.checkGasBudget();
  }

  private checkGasBudget(): PolicyDecision {
    if (this.cfg.dailyGasBudgetWei === 0n) return { allowed: true };
    if (this.gasSpent24h() >= this.cfg.dailyGasBudgetWei) {
      return {
        allowed: false,
        reason: 'gas_budget_exhausted',
        httpStatus: 503,
        hint: 'Relayer daily gas budget exhausted — retry later or use the direct path.',
      };
    }
    return { allowed: true };
  }

  // ── Lifecycle notifications ────────────────────────────────────────────

  noteCreated(vaultId: string, orderId: string): void {
    const v = this.vault(vaultId);
    v.inflight[orderId] = this.now();
    this.state.orderVault[orderId] = vaultId;
    this.save();
  }

  /** Terminal success: order executed (refund skimmed at settlement). */
  noteSettled(orderId: string): void {
    this.terminal(orderId, 'settled');
  }

  /** Terminal without settlement: cancelled or expired — relayer gas lost. */
  noteWasted(orderId: string): void {
    this.terminal(orderId, 'wasted');
  }

  /** Record gas burned by any relayed transaction (wei). */
  noteGasSpent(wei: bigint): void {
    if (wei <= 0n) return;
    this.state.gasSpend.push([this.now(), wei.toString()]);
    this.pruneGasSpend();
    this.save();
  }

  private terminal(orderId: string, kind: 'settled' | 'wasted'): void {
    const vaultId = this.state.orderVault[orderId];
    if (!vaultId) return; // not relayed by us, or already accounted
    delete this.state.orderVault[orderId];
    const v = this.vault(vaultId);
    delete v.inflight[orderId];
    v[kind]++;
    if (kind === 'wasted') this.maybeThrottle(vaultId, v);
    this.save();
  }

  private maybeThrottle(vaultId: string, v: VaultStats): void {
    const terminal = v.settled + v.wasted;
    if (terminal < this.cfg.ratioMinSample) return;
    const ratio = v.settled / terminal;
    if (ratio < this.cfg.minSettleRatio) {
      v.throttledUntil = this.now() + this.cfg.throttleCooldownMs;
      // Fresh window after the cooldown, so the vault can redeem itself.
      v.settled = 0;
      v.wasted = 0;
      console.warn(
        `[POLICY] vault throttled for ${Math.round(this.cfg.throttleCooldownMs / 60000)} min ` +
          `(settle ratio ${(ratio * 100).toFixed(0)}% < ${(this.cfg.minSettleRatio * 100).toFixed(0)}%)`
      );
    }
  }

  /** In-flight orders older than TTL count as wasted (never settled). */
  expireStaleInflight(): void {
    const cutoff = this.now() - this.cfg.inflightTtlMs;
    for (const [vaultId, v] of Object.entries(this.state.vaults)) {
      for (const [orderId, createdAt] of Object.entries(v.inflight)) {
        if (createdAt < cutoff) {
          delete v.inflight[orderId];
          delete this.state.orderVault[orderId];
          v.wasted++;
          this.maybeThrottle(vaultId, v);
        }
      }
    }
  }

  // ── Reporting (aggregate only — no vaultIds/orderIds ever exposed) ─────

  gasSpent24h(): bigint {
    this.pruneGasSpend();
    return this.state.gasSpend.reduce((acc, [, wei]) => acc + BigInt(wei), 0n);
  }

  stats(): Record<string, unknown> {
    this.expireStaleInflight();
    const nowMs = this.now();
    let inflightTotal = 0;
    let settled = 0;
    let wasted = 0;
    let throttledVaults = 0;
    for (const v of Object.values(this.state.vaults)) {
      inflightTotal += Object.keys(v.inflight).length;
      settled += v.settled;
      wasted += v.wasted;
      if (v.throttledUntil > nowMs) throttledVaults++;
    }
    const terminal = settled + wasted;
    const spent = this.gasSpent24h();
    const budget = this.cfg.dailyGasBudgetWei;
    return {
      inflightTotal,
      trackedVaults: Object.keys(this.state.vaults).length,
      throttledVaults,
      settled,
      wasted,
      settleRatio: terminal > 0 ? Number((settled / terminal).toFixed(3)) : null,
      gasSpent24hWei: spent.toString(),
      dailyGasBudgetWei: budget.toString(),
      budgetUsedPct: budget > 0n ? Number((spent * 10000n) / budget) / 100 : 0,
      budgetExhausted: budget > 0n && spent >= budget,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private vault(vaultId: string): VaultStats {
    let v = this.state.vaults[vaultId];
    if (!v) {
      v = { inflight: {}, settled: 0, wasted: 0, throttledUntil: 0 };
      this.state.vaults[vaultId] = v;
    }
    return v;
  }

  private pruneGasSpend(): void {
    const cutoff = this.now() - GAS_WINDOW_MS;
    this.state.gasSpend = this.state.gasSpend.filter(([ts]) => ts >= cutoff);
  }

  private load(): void {
    if (!this.cfg.statePath) return;
    try {
      if (!fs.existsSync(this.cfg.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.cfg.statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.state = {
          vaults: raw.vaults ?? {},
          orderVault: raw.orderVault ?? {},
          gasSpend: Array.isArray(raw.gasSpend) ? raw.gasSpend : [],
        };
      }
    } catch (e: any) {
      console.warn('[POLICY] state file unreadable, starting fresh:', e.message);
      this.state = emptyState();
    }
  }

  private save(): void {
    if (!this.cfg.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.cfg.statePath), { recursive: true });
      fs.writeFileSync(this.cfg.statePath, JSON.stringify(this.state), 'utf8');
    } catch (e: any) {
      console.warn('[POLICY] state persist failed:', e.message);
    }
  }
}
