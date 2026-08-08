/**
 * @file Monitor configuration
 * @description All settings come from environment variables with sensible
 * defaults. Contract/subgraph addresses fall back to the SSOT file
 * noctis-protocol/deployments/sepolia.json when present (same convention as
 * ops-monitor.ts). No secrets are ever exposed through /status.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

function intEnv(name: string, def: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function boolEnv(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === '1' || v.toLowerCase() === 'true';
}

export interface MonitorConfig {
  // Targets
  relayerHealthUrl: string;
  rpcUrl: string;
  vault: string;
  exchange: string;
  relayerAddress: string;
  subgraphUrl: string;

  // Thresholds
  minRelayerEth: string; // in ETH, parsed with parseEther
  subgraphLagBlocks: number;
  stuckOrderMaxAgeMin: number;
  chainStallMs: number;

  // Per-check intervals (ms)
  intervals: {
    relayerHealth: number;
    rpc: number;
    balance: number;
    paused: number;
    subgraph: number;
    stuckOrders: number;
  };

  // Alerting
  alertWebhookUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  alertCooldownMs: number;
  statePath: string;
  alertLogPath: string;

  // Heartbeat
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number;

  // HTTP status server
  statusPort: number;
  statusHost: string;
}

export function loadConfig(): MonitorConfig {
  const cfg: MonitorConfig = {
    relayerHealthUrl:
      process.env.RELAYER_HEALTH_URL ||
      `http://127.0.0.1:${process.env.RELAYER_PORT || '3001'}/api/relay/health`,
    // Prefer a public read RPC — Flashbots rejects batched eth_call
    rpcUrl:
      process.env.MONITOR_RPC_URL ||
      process.env.SEPOLIA_RPC ||
      process.env.RPC_URL ||
      'https://ethereum-sepolia-rpc.publicnode.com',
    vault: process.env.VAULT_ADDRESS || '',
    exchange: process.env.EXCHANGE_ADDRESS || '',
    relayerAddress: process.env.EXPECTED_RELAYER || process.env.RELAYER_ADDRESS || '',
    subgraphUrl: process.env.SUBGRAPH_URL || '',

    minRelayerEth: process.env.MONITOR_MIN_ETH || process.env.MIN_KEEPER_ETH || '0.05',
    subgraphLagBlocks: intEnv('SUBGRAPH_LAG_BLOCKS', 50),
    stuckOrderMaxAgeMin: intEnv('STUCK_ORDER_MAX_AGE_MIN', 30),
    chainStallMs: intEnv('CHAIN_STALL_MS', 5 * 60 * 1000),

    intervals: {
      relayerHealth: intEnv('CHECK_HEALTH_INTERVAL_MS', 30_000),
      rpc: intEnv('CHECK_RPC_INTERVAL_MS', 30_000),
      balance: intEnv('CHECK_BALANCE_INTERVAL_MS', 60_000),
      paused: intEnv('CHECK_PAUSED_INTERVAL_MS', 60_000),
      subgraph: intEnv('CHECK_SUBGRAPH_INTERVAL_MS', 120_000),
      stuckOrders: intEnv('CHECK_ORDERS_INTERVAL_MS', 300_000),
    },

    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    alertCooldownMs: intEnv('ALERT_COOLDOWN_MS', 30 * 60 * 1000),
    statePath:
      process.env.MONITOR_STATE_PATH ||
      path.join(__dirname, '..', '..', 'logs', 'monitor-state.json'),
    alertLogPath:
      process.env.ALERT_LOG_PATH || path.join(__dirname, '..', '..', 'logs', 'alerts.jsonl'),

    heartbeatEnabled: boolEnv('HEARTBEAT_ENABLED', true),
    heartbeatIntervalMs: intEnv('HEARTBEAT_INTERVAL_MS', 24 * 60 * 60 * 1000),

    statusPort: intEnv('MONITOR_STATUS_PORT', 3002),
    statusHost: process.env.MONITOR_STATUS_HOST || '0.0.0.0',
  };

  applySsotDefaults(cfg);
  return cfg;
}

/** Fill missing addresses/URLs from noctis-protocol/deployments/sepolia.json. */
function applySsotDefaults(cfg: MonitorConfig): void {
  const ssotPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'noctis-protocol',
    'deployments',
    'sepolia.json'
  );
  if (!fs.existsSync(ssotPath)) return;
  try {
    const ssot = JSON.parse(fs.readFileSync(ssotPath, 'utf8'));
    if (!cfg.vault) cfg.vault = ssot.contracts?.NoctisVault || '';
    if (!cfg.exchange) cfg.exchange = ssot.contracts?.NoctisExchange || '';
    if (!cfg.relayerAddress) cfg.relayerAddress = ssot.ops?.relayer || '';
    if (!cfg.subgraphUrl) cfg.subgraphUrl = ssot.subgraph?.queryUrl || '';
  } catch {
    // SSOT unreadable — env vars remain the only source.
  }
}

/** Redact anything that could contain credentials (e.g. RPC API keys in URL). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid url)';
  }
}
