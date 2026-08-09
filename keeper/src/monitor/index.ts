/**
 * @file Noctis keeper monitoring service
 * @description Runs periodic health checks (relayer HTTP, RPC/chain head,
 * relayer balance, contract pause state, subgraph lag, stuck orders) and
 * dispatches deduplicated alerts via webhook/Telegram. Exposes GET /status
 * with the latest results (no secrets).
 *
 * Run standalone: npm run monitor
 * Run in docker:  docker compose --profile monitor up -d --build
 * Test alert:     npm run monitor:ping
 */
import * as http from 'http';
import { AlertManager } from './alerts';
import { buildChecks, CheckDef, CheckResult } from './checks';
import { loadConfig, redactUrl } from './config';

interface StoredResult extends CheckResult {
  checkedAt: string;
  durationMs: number;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const startedAt = Date.now();

  const alerts = new AlertManager({
    channels: {
      webhookUrl: cfg.alertWebhookUrl,
      telegramBotToken: cfg.telegramBotToken,
      telegramChatId: cfg.telegramChatId,
    },
    cooldownMs: cfg.alertCooldownMs,
    statePath: cfg.statePath,
    alertLogPath: cfg.alertLogPath,
  });

  console.log('═══════════════════════════════════════════════════');
  console.log('🩺 Noctis keeper monitor');
  console.log(`   relayer:  ${cfg.relayerHealthUrl}`);
  console.log(`   rpc:      ${redactUrl(cfg.rpcUrl)}`);
  console.log(`   exchange: ${cfg.exchange || '(unset)'}`);
  console.log(`   vault:    ${cfg.vault || '(unset)'}`);
  console.log(`   subgraph: ${cfg.subgraphUrl ? redactUrl(cfg.subgraphUrl) : '(unset)'}`);
  console.log(`   minEth:   ${cfg.minRelayerEth}`);
  console.log(`   cooldown: ${cfg.alertCooldownMs / 60000} min`);
  console.log(`   status:   http://${cfg.statusHost}:${cfg.statusPort}/status`);
  console.log(
    `   alerts:   ${['stdout', 'file', cfg.alertWebhookUrl && 'webhook', cfg.telegramBotToken && 'telegram']
      .filter(Boolean)
      .join(', ')}`
  );
  console.log('═══════════════════════════════════════════════════');

  if (process.argv.includes('--ping') || process.env.MONITOR_PING === '1') {
    await alerts.raw('info', '🔔 Test alert from Noctis keeper monitor (--ping)');
    console.log('Ping dispatched.');
    process.exit(0);
  }

  const checks = buildChecks(cfg);
  const lastResults = new Map<string, StoredResult>();

  const runCheck = async (check: CheckDef): Promise<void> => {
    const t0 = Date.now();
    let result: CheckResult;
    try {
      result = await check.run();
    } catch (e: any) {
      // Checks are designed not to throw; this is a safety net.
      result = {
        ok: false,
        severity: 'warn',
        summary: `check crashed: ${e.message || e}`,
        details: {},
      };
    }
    const stored: StoredResult = {
      ...result,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    };
    lastResults.set(check.name, stored);

    const icon = result.skipped ? '⏭️' : result.ok ? '✅' : '❌';
    console.log(`[${stored.checkedAt}] ${icon} ${check.name}: ${result.summary}`);

    if (result.skipped) return;
    if (result.ok) {
      await alerts.pass(check.name, result.summary);
    } else {
      await alerts.fail(
        check.name,
        result.severity,
        result.summary,
        JSON.stringify(result.details, null, 2)
      );
    }
  };

  // Run every check once at startup, then on its own interval.
  for (const check of checks) {
    runCheck(check).catch((e) => console.error(`${check.name} error`, e));
    const timer = setInterval(() => {
      runCheck(check).catch((e) => console.error(`${check.name} error`, e));
    }, check.intervalMs);
    timer.unref?.();
  }

  // ── Daily heartbeat ────────────────────────────────────────────────────
  const heartbeatSummary = (): string => {
    const lines: string[] = [];
    for (const [name, r] of lastResults) {
      const state = r.skipped ? 'skipped' : r.ok ? 'ok' : 'FAILING';
      lines.push(`• ${name}: ${state} — ${r.summary}`);
    }
    const active = alerts.activeKeys();
    lines.push(active.length ? `Active alerts: ${active.join(', ')}` : 'No active alerts.');
    lines.push(`Uptime: ${Math.round((Date.now() - startedAt) / 60000)} min`);
    return lines.join('\n');
  };

  if (cfg.heartbeatEnabled) {
    const heartbeatTick = async () => {
      const due = Date.now() - alerts.getLastHeartbeatAt() >= cfg.heartbeatIntervalMs;
      if (due) await alerts.heartbeat(heartbeatSummary());
    };
    // Check once a minute; the persisted timestamp survives restarts.
    const hbTimer = setInterval(() => {
      heartbeatTick().catch((e) => console.error('heartbeat error', e));
    }, 60_000);
    hbTimer.unref?.();
    // Give the initial round of checks time to populate results.
    setTimeout(() => {
      heartbeatTick().catch((e) => console.error('heartbeat error', e));
    }, 15_000).unref?.();
  }

  // ── HTTP /status endpoint ──────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/status' || req.url === '/')) {
      const checksOut: Record<string, StoredResult> = {};
      let failing = 0;
      for (const [name, r] of lastResults) {
        checksOut[name] = r;
        if (!r.ok && !r.skipped) failing++;
      }
      const body = {
        status: failing === 0 ? 'ok' : 'degraded',
        failingChecks: failing,
        activeAlerts: alerts.activeKeys(),
        checks: checksOut,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        ts: new Date().toISOString(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(cfg.statusPort, cfg.statusHost, () => {
    console.log(`Status endpoint listening on ${cfg.statusHost}:${cfg.statusPort}`);
  });

  const shutdown = () => {
    console.log('Monitor shutting down…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
