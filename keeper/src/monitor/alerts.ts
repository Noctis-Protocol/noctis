/**
 * @file Alert dispatcher with deduplication, cooldown and recovery notices
 * @description Sends alerts to a Discord-compatible webhook (ALERT_WEBHOOK_URL)
 * and/or Telegram. The same alert key is never re-sent within the cooldown
 * window. State (active alerts + heartbeat timestamp) is kept in memory and
 * persisted to a JSON file so restarts do not re-fire every active alert.
 *
 * No secrets are ever written to the state file or the alert log.
 */
import * as fs from 'fs';
import * as path from 'path';

export type Severity = 'info' | 'warn' | 'critical';

export interface AlertChannels {
  /** Discord-compatible webhook: POST { content: "..." } */
  webhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

interface ActiveAlert {
  firstFailedAt: number;
  lastSentAt: number;
  title: string;
  severity: Severity;
}

interface PersistedState {
  active: Record<string, ActiveAlert>;
  lastHeartbeatAt: number;
}

export interface AlertManagerOptions {
  channels: AlertChannels;
  /** Minimum ms between two notifications for the same alert key. */
  cooldownMs: number;
  /** JSON state file path. Empty string disables persistence. */
  statePath: string;
  /** Optional JSONL sink for a durable local trail of every alert sent. */
  alertLogPath?: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable transport (tests). Replaces webhook/Telegram delivery. */
  send?: (text: string, severity: Severity) => Promise<void>;
}

const SEVERITY_ICON: Record<Severity, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  critical: '🚨',
};

export class AlertManager {
  private readonly channels: AlertChannels;
  private readonly cooldownMs: number;
  private readonly statePath: string;
  private readonly alertLogPath: string;
  private readonly now: () => number;
  private readonly sendOverride?: (text: string, severity: Severity) => Promise<void>;
  private state: PersistedState = { active: {}, lastHeartbeatAt: 0 };

  constructor(opts: AlertManagerOptions) {
    this.channels = opts.channels;
    this.cooldownMs = opts.cooldownMs;
    this.statePath = opts.statePath;
    this.alertLogPath = opts.alertLogPath || '';
    this.now = opts.now || Date.now;
    this.sendOverride = opts.send;
    this.loadState();
  }

  /**
   * Report a failing check. Sends a notification only when the alert is new
   * or the cooldown has elapsed since the last notification for this key.
   * @returns true when a notification was actually dispatched.
   */
  async fail(key: string, severity: Severity, title: string, body: string): Promise<boolean> {
    const now = this.now();
    const existing = this.state.active[key];

    if (existing && now - existing.lastSentAt < this.cooldownMs) {
      // Keep tracking the failure but stay silent within the cooldown window.
      existing.title = title;
      existing.severity = severity;
      this.saveState();
      return false;
    }

    const firstFailedAt = existing ? existing.firstFailedAt : now;
    this.state.active[key] = { firstFailedAt, lastSentAt: now, title, severity };
    this.saveState();

    const ongoing = existing
      ? ` (ongoing since ${new Date(firstFailedAt).toISOString()})`
      : '';
    await this.dispatch(severity, `${SEVERITY_ICON[severity]} [${key}] ${title}${ongoing}\n${body}`);
    return true;
  }

  /**
   * Report a passing check. Sends a recovery notice only if the key was
   * previously in a failing state.
   * @returns true when a recovery notice was dispatched.
   */
  async pass(key: string, body = ''): Promise<boolean> {
    const existing = this.state.active[key];
    if (!existing) return false;

    delete this.state.active[key];
    this.saveState();

    const downMs = this.now() - existing.firstFailedAt;
    const downMin = Math.round(downMs / 60_000);
    await this.dispatch(
      'info',
      `✅ [${key}] RECOVERED — ${existing.title} (was failing for ~${downMin} min)${body ? `\n${body}` : ''}`
    );
    return true;
  }

  /** Keys currently in a failing state. */
  activeKeys(): string[] {
    return Object.keys(this.state.active);
  }

  getLastHeartbeatAt(): number {
    return this.state.lastHeartbeatAt;
  }

  /** Send a heartbeat/summary message (dedup does not apply). */
  async heartbeat(body: string): Promise<void> {
    this.state.lastHeartbeatAt = this.now();
    this.saveState();
    await this.dispatch('info', `💓 Noctis monitor heartbeat\n${body}`);
  }

  /** Send an arbitrary one-off message (e.g. startup notice, --ping). */
  async raw(severity: Severity, text: string): Promise<void> {
    await this.dispatch(severity, text);
  }

  // ── Transport ──────────────────────────────────────────────────────────

  private async dispatch(severity: Severity, text: string): Promise<void> {
    console.log(`[alert:${severity}] ${text}`);
    this.appendAlertLog(severity, text);

    if (this.sendOverride) {
      await this.sendOverride(text, severity);
      return;
    }

    const tasks: Promise<unknown>[] = [];

    if (this.channels.webhookUrl) {
      tasks.push(
        this.post(this.channels.webhookUrl, { content: text.slice(0, 1900) }).catch((e) =>
          console.error('Webhook alert failed:', e.message || e)
        )
      );
    }

    if (this.channels.telegramBotToken && this.channels.telegramChatId) {
      const url = `https://api.telegram.org/bot${this.channels.telegramBotToken}/sendMessage`;
      tasks.push(
        this.post(url, {
          chat_id: this.channels.telegramChatId,
          text: text.slice(0, 3500),
        }).catch((e) => console.error('Telegram alert failed:', e.message || e))
      );
    }

    await Promise.all(tasks);
  }

  private async post(url: string, payload: unknown): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private appendAlertLog(severity: Severity, text: string): void {
    if (!this.alertLogPath) return;
    try {
      fs.mkdirSync(path.dirname(this.alertLogPath), { recursive: true });
      const line = JSON.stringify({
        ts: new Date(this.now()).toISOString(),
        severity,
        text: text.slice(0, 4000),
      });
      fs.appendFileSync(this.alertLogPath, line + '\n', { mode: 0o600 });
    } catch (e: any) {
      console.error('Alert log write failed:', e.message || e);
    }
  }

  // ── State persistence ──────────────────────────────────────────────────

  private loadState(): void {
    if (!this.statePath) return;
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = {
        active: parsed.active && typeof parsed.active === 'object' ? parsed.active : {},
        lastHeartbeatAt: typeof parsed.lastHeartbeatAt === 'number' ? parsed.lastHeartbeatAt : 0,
      };
    } catch {
      // Missing or corrupt state file — start fresh.
      this.state = { active: {}, lastHeartbeatAt: 0 };
    }
  }

  private saveState(): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
    } catch (e: any) {
      console.error('Monitor state write failed:', e.message || e);
    }
  }
}
