/**
 * @file Lightweight ops monitor for Noctis Sepolia desk
 * @description Polls relayer health (?deep=1) + independent on-chain checks.
 * Alerts on state transitions via Discord / Telegram / generic webhook.
 *
 * Run: npm run monitor
 * Env: see .env.example (DISCORD_WEBHOOK_URL, EXPECTED_FEE_RECIPIENT, …)
 */
import { ethers, formatEther, formatUnits } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

type Severity = 'info' | 'warn' | 'critical';

interface CheckResult {
  ok: boolean;
  failures: string[];
  details: Record<string, unknown>;
}

const CONFIG = {
  healthUrl:
    process.env.RELAYER_HEALTH_URL ||
    `http://127.0.0.1:${process.env.RELAYER_PORT || '3001'}/api/relay/health?deep=1`,
  // Prefer a public read RPC — Flashbots rejects batched eth_call
  rpcUrl:
    process.env.MONITOR_RPC_URL ||
    process.env.SEPOLIA_RPC ||
    'https://ethereum-sepolia-rpc.publicnode.com',
  vault: process.env.VAULT_ADDRESS || '',
  exchange: process.env.EXCHANGE_ADDRESS || '',
  expectedFee: process.env.EXPECTED_FEE_RECIPIENT || process.env.FEE_RECIPIENT || '',
  expectedRelayer: process.env.EXPECTED_RELAYER || '',
  minKeeperEth: process.env.MIN_KEEPER_ETH || '0.01',
  intervalMs: parseInt(process.env.MONITOR_INTERVAL_MS || '30000', 10),
  remindMs: parseInt(process.env.MONITOR_REMIND_MS || String(15 * 60 * 1000), 10),
  maxFeeSilenceHours: parseFloat(process.env.MAX_FEE_SILENCE_HOURS || '0'),
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  genericWebhook: process.env.ALERT_WEBHOOK_URL || '',
  // Always-on durable sink (Phase A5) — survives without Discord
  alertLogPath:
    process.env.ALERT_LOG_PATH || path.join(__dirname, '..', 'logs', 'alerts.jsonl'),
  usdc: process.env.USDT_ADDRESS || process.env.USDC_ADDRESS || '',
  pingOnly: process.env.MONITOR_PING === '1' || process.argv.includes('--ping'),
};

function loadSsotDefaults() {
  const ssotPath = path.join(
    __dirname,
    '..',
    '..',
    'noctis-protocol',
    'deployments',
    'sepolia.json'
  );
  if (!fs.existsSync(ssotPath)) return;
  try {
    const ssot = JSON.parse(fs.readFileSync(ssotPath, 'utf8'));
    if (!CONFIG.vault) CONFIG.vault = ssot.contracts.NoctisVault;
    if (!CONFIG.exchange) CONFIG.exchange = ssot.contracts.NoctisExchange;
    if (!CONFIG.expectedFee) CONFIG.expectedFee = ssot.contracts.feeRecipient;
    if (!CONFIG.expectedRelayer && ssot.ops?.relayer) {
      CONFIG.expectedRelayer = ssot.ops.relayer;
    }
    // V2 SSOT uses "USDC"; older files used "USDT" for the same Circle token
    if (!CONFIG.usdc) CONFIG.usdc = ssot.contracts.USDC || ssot.contracts.USDT;
  } catch {
    /* ignore */
  }
}

function appendAlertLog(severity: Severity, title: string, body: string) {
  try {
    const dir = path.dirname(CONFIG.alertLogPath);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      severity,
      title,
      body: body.slice(0, 4000),
    });
    fs.appendFileSync(CONFIG.alertLogPath, line + '\n', { mode: 0o600 });
  } catch (e: any) {
    console.error('Alert log write failed:', e.message);
  }
}

async function sendAlert(severity: Severity, title: string, body: string) {
  const text = `[Noctis ${severity.toUpperCase()}] ${title}\n${body}`;
  console.log(`\n🚨 ${text}\n`);

  // Durable local channel (always on)
  appendAlertLog(severity, title, body);

  const tasks: Promise<unknown>[] = [];

  if (CONFIG.discordWebhook) {
    tasks.push(
      fetch(CONFIG.discordWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text.slice(0, 1900),
        }),
      }).catch((e) => console.error('Discord alert failed:', e.message))
    );
  }

  if (CONFIG.telegramBotToken && CONFIG.telegramChatId) {
    const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
    tasks.push(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.telegramChatId,
          text: text.slice(0, 3500),
        }),
      }).catch((e) => console.error('Telegram alert failed:', e.message))
    );
  }

  if (CONFIG.genericWebhook) {
    tasks.push(
      fetch(CONFIG.genericWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ severity, title, body, ts: new Date().toISOString() }),
      }).catch((e) => console.error('Webhook alert failed:', e.message))
    );
  }

  await Promise.all(tasks);
}

async function checkHttpHealth(): Promise<CheckResult> {
  const failures: string[] = [];
  const details: Record<string, unknown> = {};
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(CONFIG.healthUrl, { signal: ctrl.signal });
    clearTimeout(t);
    const json = (await res.json()) as Record<string, unknown>;
    details.httpStatus = res.status;
    details.health = json;
    if (!res.ok || json.status === 'degraded' || json.status === 'error') {
      failures.push('relayer_health_degraded');
      const f = json.failures;
      if (Array.isArray(f)) {
        for (const x of f) failures.push(String(x));
      }
    }
    if (CONFIG.expectedRelayer && json.relayer) {
      if (String(json.relayer).toLowerCase() !== CONFIG.expectedRelayer.toLowerCase()) {
        failures.push('unexpected_relayer_address');
      }
    }
  } catch (e: any) {
    failures.push('relayer_unreachable');
    details.error = e.message || String(e);
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)], details };
}

async function checkOnchain(): Promise<CheckResult> {
  const failures: string[] = [];
  const details: Record<string, unknown> = {};
  if (!CONFIG.exchange || !CONFIG.vault) {
    return { ok: false, failures: ['missing_addresses'], details };
  }

  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const exchange = new ethers.Contract(
    CONFIG.exchange,
    [
      'function paused() view returns (bool)',
      'function feeRecipient() view returns (address)',
      'function RELAYER_ROLE() view returns (bytes32)',
      'function hasRole(bytes32,address) view returns (bool)',
      'event ProtocolFeeCollected(uint256 indexed orderId, address indexed token, uint256 feeAmount, address indexed recipient)',
    ],
    provider
  );
  // V2: vault has no keeper set (isKeeper was removed) — paused() only
  const vault = new ethers.Contract(
    CONFIG.vault,
    ['function paused() view returns (bool)'],
    provider
  );

  try {
    const exPaused = (await exchange.paused()) as boolean;
    const vaultPaused = (await vault.paused()) as boolean;
    const feeRecipient = (await exchange.feeRecipient()) as string;
    const role = (await exchange.RELAYER_ROLE()) as string;

    details.exchangePaused = exPaused;
    details.vaultPaused = vaultPaused;
    details.feeRecipient = feeRecipient;

    if (exPaused) failures.push('exchange_paused');
    if (vaultPaused) failures.push('vault_paused');
    if (
      CONFIG.expectedFee &&
      feeRecipient.toLowerCase() !== CONFIG.expectedFee.toLowerCase()
    ) {
      failures.push('fee_recipient_mismatch');
      details.expectedFeeRecipient = CONFIG.expectedFee;
    }

    let relayer = CONFIG.expectedRelayer;
    if (!relayer) {
      try {
        const r = await fetch(CONFIG.healthUrl.replace(/\?.*$/, ''));
        const j = (await r.json()) as { relayer?: string };
        relayer = j.relayer || '';
      } catch {
        relayer = '';
      }
    }

    if (relayer) {
      details.relayer = relayer;
      const hasRole = (await exchange.hasRole(role, relayer)) as boolean;
      const bal = await provider.getBalance(relayer);
      details.hasRelayerRole = hasRole;
      details.keeperEth = formatEther(bal);
      if (!hasRole) failures.push('missing_relayer_role');
      if (bal < ethers.parseEther(CONFIG.minKeeperEth)) failures.push('low_keeper_eth');
    } else {
      failures.push('relayer_address_unknown');
    }

    // Optional: fee silence (disabled when MAX_FEE_SILENCE_HOURS=0)
    if (CONFIG.maxFeeSilenceHours > 0 && CONFIG.expectedFee) {
      const latest = await provider.getBlockNumber();
      const fromBlock = Math.max(0, latest - 50_000);
      const topic = exchange.interface.getEvent('ProtocolFeeCollected')!.topicHash;
      const logs = await provider.getLogs({
        address: CONFIG.exchange,
        topics: [topic],
        fromBlock,
        toBlock: latest,
      });
      let lastFeeBlock = 0;
      for (const log of logs) {
        const parsed = exchange.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (
          parsed &&
          String(parsed.args.recipient).toLowerCase() === CONFIG.expectedFee.toLowerCase()
        ) {
          lastFeeBlock = Math.max(lastFeeBlock, log.blockNumber);
        }
      }
      details.lastFeeToSafeBlock = lastFeeBlock || null;
      if (lastFeeBlock > 0) {
        const blk = await provider.getBlock(lastFeeBlock);
        const ageH = (Date.now() / 1000 - Number(blk?.timestamp || 0)) / 3600;
        details.hoursSinceLastFeeToSafe = Number(ageH.toFixed(2));
        if (ageH > CONFIG.maxFeeSilenceHours) failures.push('fee_silence');
      }
    }

    if (CONFIG.usdc && CONFIG.expectedFee) {
      const usdc = new ethers.Contract(
        CONFIG.usdc,
        [
          'function balanceOf(address) view returns (uint256)',
          'function decimals() view returns (uint8)',
        ],
        provider
      );
      const bal = (await usdc.balanceOf(CONFIG.expectedFee)) as bigint;
      const dec = (await usdc.decimals()) as number;
      details.safeUsdc = formatUnits(bal, dec);
      details.safeEth = formatEther(await provider.getBalance(CONFIG.expectedFee));
    }
  } catch (e: any) {
    failures.push('onchain_read_failed');
    details.error = e.shortMessage || e.message || String(e);
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)], details };
}

function fingerprint(failures: string[]): string {
  return [...failures].sort().join('|') || 'ok';
}

async function main() {
  loadSsotDefaults();

  console.log('═══════════════════════════════════════════════════');
  console.log('🩺 Noctis ops monitor');
  console.log(`   health:   ${CONFIG.healthUrl}`);
  console.log(`   exchange: ${CONFIG.exchange}`);
  console.log(`   vault:    ${CONFIG.vault}`);
  console.log(`   fee Safe: ${CONFIG.expectedFee || '(unset)'}`);
  console.log(`   relayer:  ${CONFIG.expectedRelayer || '(from health)'}`);
  console.log(`   interval: ${CONFIG.intervalMs / 1000}s`);
  console.log(`   alertLog: ${CONFIG.alertLogPath}`);
  console.log(
    `   alerts:   ${[
      'file',
      CONFIG.discordWebhook && 'discord',
      CONFIG.telegramBotToken && 'telegram',
      CONFIG.genericWebhook && 'webhook',
      'stdout',
    ]
      .filter(Boolean)
      .join(', ')}`
  );
  console.log('═══════════════════════════════════════════════════');

  if (CONFIG.pingOnly) {
    await sendAlert(
      'info',
      'monitor ping',
      'Test alert from ops-monitor (--ping / MONITOR_PING=1). Channels: file + optional Discord/Telegram.'
    );
    console.log('Ping sent →', CONFIG.alertLogPath);
    if (!CONFIG.discordWebhook && !CONFIG.telegramBotToken && !CONFIG.genericWebhook) {
      console.log(
        'Tip: set DISCORD_WEBHOOK_URL or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID for remote alerts.'
      );
    }
    process.exit(0);
  }

  let lastFp = '';
  let lastAlertAt = 0;
  let wasBad = false;

  const tick = async () => {
    const [http, chain] = await Promise.all([checkHttpHealth(), checkOnchain()]);
    const failures = [...new Set([...http.failures, ...chain.failures])];
    const ok = failures.length === 0;
    const fp = fingerprint(failures);
    const ts = new Date().toISOString();

    if (ok) {
      console.log(`[${ts}] ✅ ok`, {
        keeperEth: chain.details.keeperEth,
        feeRecipient: chain.details.feeRecipient,
        safeUsdc: chain.details.safeUsdc,
      });
      if (wasBad) {
        await sendAlert('info', 'Recovered', `All checks green again.\n${JSON.stringify(chain.details, null, 2)}`);
        wasBad = false;
        lastFp = fp;
      }
      return;
    }

    console.log(`[${ts}] ❌ failures:`, failures.join(', '));
    const now = Date.now();
    const changed = fp !== lastFp;
    const remind = now - lastAlertAt >= CONFIG.remindMs;
    if (changed || remind) {
      const severity: Severity = failures.some((f) =>
        ['relayer_unreachable', 'missing_relayer_role', 'exchange_paused', 'fee_recipient_mismatch'].includes(f)
      )
        ? 'critical'
        : 'warn';
      await sendAlert(
        severity,
        failures.join(', '),
        `HTTP: ${JSON.stringify(http.details, null, 2)}\n\nChain: ${JSON.stringify(chain.details, null, 2)}`
      );
      lastAlertAt = now;
      lastFp = fp;
      wasBad = true;
    }
  };

  await tick();
  setInterval(() => {
    tick().catch((e) => console.error('tick error', e));
  }, CONFIG.intervalMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
