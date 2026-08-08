# Noctis Keeper Monitoring

Monitoring/alerting service for the Noctis Sepolia desk. Lives in
`src/monitor/` and runs as the `monitor` service in `docker-compose.yml`
(container `noctis-ops-monitor`). It supersedes the single-file
`src/ops-monitor.ts`, which remains available as `npm run monitor:legacy`.

## Checks

Each check runs on its own interval and never throws; checks that depend on
optional infrastructure degrade to `skipped` instead of alerting.

| Check | Default interval | Fails when | Severity |
|---|---|---|---|
| `relayer-health` | 30s | `GET /api/relay/health` unreachable, non-200, or `status` degraded/error | critical |
| `rpc-chain-head` | 30s | RPC unreachable, or chain head unchanged for > `CHAIN_STALL_MS` (5 min) | critical |
| `relayer-balance` | 60s | Relayer EOA ETH balance < `MONITOR_MIN_ETH` (0.05 ETH) | critical |
| `contracts-paused` | 60s | `NoctisExchange.paused()` or `NoctisVault.paused()` returns true (skips per-contract if the getter is missing) | critical |
| `subgraph-lag` | 120s | `_meta.hasIndexingErrors`, or chain head − subgraph block > `SUBGRAPH_LAG_BLOCKS` (50) | warn |
| `stuck-orders` | 300s | Subgraph `orders` with `status: PENDING` older than `STUCK_ORDER_MAX_AGE_MIN` (30 min); a pending order with `swapRequested` counts as mid-execution (skips if the query is unavailable) | warn |

Contract addresses, the relayer EOA and the subgraph URL default to the SSOT
file `noctis-protocol/deployments/sepolia.json`; env vars override.

## Alerting

- **Channels** (any combination): `ALERT_WEBHOOK_URL` (Discord-compatible,
  receives `POST { "content": "..." }`; `DISCORD_WEBHOOK_URL` is a legacy
  alias) and Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`). Every alert
  is also written to stdout and appended to `logs/alerts.jsonl`.
- **Deduplication**: the same alert key (= check name) is not re-sent within
  `ALERT_COOLDOWN_MS` (default 30 min). After the cooldown the alert is
  repeated as a reminder with its original start time.
- **Persistence**: dedup state is kept in memory and persisted to
  `logs/monitor-state.json`, so a restart neither re-fires active alerts nor
  loses the cooldown clock.
- **Recovery**: when a previously-failing check passes again, a single
  `RECOVERED` notice is sent with the approximate downtime.
- **Heartbeat**: a daily summary of all check states is sent
  (`HEARTBEAT_ENABLED=1`, interval `HEARTBEAT_INTERVAL_MS`, default 24 h). The
  last-sent timestamp is persisted, so restarts do not spam.

No secrets ever appear in alerts, logs, the state file or `/status`
(RPC/subgraph URLs are redacted to scheme + host).

## Status endpoint

`GET /status` on port `MONITOR_STATUS_PORT` (default 3002) returns the last
result of every check:

```json
{
  "status": "ok",
  "failingChecks": 0,
  "activeAlerts": [],
  "checks": { "relayer-health": { "ok": true, "summary": "..." } },
  "uptimeSec": 1234,
  "ts": "2026-08-09T00:00:00.000Z"
}
```

In docker compose the port is published on `127.0.0.1:3002` only (same policy
as the relayer). The container healthcheck curls this endpoint.

## Running

Docker (with the relayer):

```bash
cd keeper
cp .env.example .env   # fill in values
docker compose --profile monitor up -d --build
docker compose --profile monitor logs -f monitor
curl -s http://127.0.0.1:3002/status | jq
```

Standalone (uses `.env` in `keeper/`):

```bash
npm install
npm run monitor          # start the monitoring service
npm run monitor:ping     # send a test alert to configured channels and exit
```

## Configuration

All settings via env — see the "Monitoring service" section of `.env.example`
for the complete annotated list. Key variables:

- `RELAYER_HEALTH_URL` — relayer health endpoint (compose sets
  `http://relayer:3001/api/relay/health` automatically)
- `MONITOR_RPC_URL` — read RPC (public node recommended)
- `SUBGRAPH_URL` — subgraph query URL (SSOT default)
- `MONITOR_MIN_ETH`, `SUBGRAPH_LAG_BLOCKS`, `STUCK_ORDER_MAX_AGE_MIN`,
  `CHAIN_STALL_MS` — thresholds
- `CHECK_*_INTERVAL_MS` — per-check intervals
- `ALERT_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` — channels
- `ALERT_COOLDOWN_MS`, `MONITOR_STATE_PATH` — deduplication
- `HEARTBEAT_ENABLED`, `HEARTBEAT_INTERVAL_MS` — heartbeat
- `MONITOR_STATUS_PORT` — status endpoint port

## Tests

Unit tests cover the alert dedup/cooldown/recovery/persistence logic using
node's built-in test runner:

```bash
npm run test:monitor
```
