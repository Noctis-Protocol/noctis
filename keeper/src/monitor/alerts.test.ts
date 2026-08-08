/**
 * @file Unit tests for AlertManager dedup/cooldown/recovery/persistence
 * @description Uses node's built-in test runner via tsx: npm run test:monitor
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AlertManager, Severity } from './alerts';

const COOLDOWN = 30 * 60 * 1000; // 30 min

interface Sent {
  text: string;
  severity: Severity;
}

function makeManager(opts: { statePath?: string; startAt?: number } = {}) {
  const sent: Sent[] = [];
  let now = opts.startAt ?? 1_000_000;
  const manager = new AlertManager({
    channels: {},
    cooldownMs: COOLDOWN,
    statePath: opts.statePath ?? '',
    now: () => now,
    send: async (text, severity) => {
      sent.push({ text, severity });
    },
  });
  return {
    manager,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('first failure sends an alert', async () => {
  const { manager, sent } = makeManager();
  const dispatched = await manager.fail('relayer-health', 'critical', 'down', 'body');
  assert.equal(dispatched, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /relayer-health/);
  assert.equal(sent[0].severity, 'critical');
});

test('same key within cooldown is deduplicated', async () => {
  const { manager, sent, advance } = makeManager();
  await manager.fail('rpc', 'critical', 'down', 'body');
  advance(COOLDOWN - 1);
  const dispatched = await manager.fail('rpc', 'critical', 'still down', 'body');
  assert.equal(dispatched, false);
  assert.equal(sent.length, 1);
});

test('same key after cooldown is re-sent as a reminder', async () => {
  const { manager, sent, advance } = makeManager();
  await manager.fail('rpc', 'critical', 'down', 'body');
  advance(COOLDOWN + 1);
  const dispatched = await manager.fail('rpc', 'critical', 'still down', 'body');
  assert.equal(dispatched, true);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /ongoing since/);
});

test('different keys are independent', async () => {
  const { manager, sent } = makeManager();
  await manager.fail('rpc', 'critical', 'down', 'body');
  await manager.fail('subgraph-lag', 'warn', 'lagging', 'body');
  assert.equal(sent.length, 2);
});

test('pass on an active alert sends a recovery notice once', async () => {
  const { manager, sent, advance } = makeManager();
  await manager.fail('relayer-balance', 'critical', 'low balance', 'body');
  advance(5 * 60 * 1000);
  const recovered = await manager.pass('relayer-balance');
  assert.equal(recovered, true);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /RECOVERED/);
  assert.match(sent[1].text, /~5 min/);

  // Passing again while healthy stays silent.
  const again = await manager.pass('relayer-balance');
  assert.equal(again, false);
  assert.equal(sent.length, 2);
});

test('pass on a never-failing key sends nothing', async () => {
  const { manager, sent } = makeManager();
  const recovered = await manager.pass('contracts-paused');
  assert.equal(recovered, false);
  assert.equal(sent.length, 0);
});

test('failure then recovery then new failure alerts again immediately', async () => {
  const { manager, sent, advance } = makeManager();
  await manager.fail('rpc', 'critical', 'down', 'body');
  advance(60_000);
  await manager.pass('rpc');
  advance(60_000);
  const dispatched = await manager.fail('rpc', 'critical', 'down again', 'body');
  assert.equal(dispatched, true);
  assert.equal(sent.length, 3);
});

test('state persists across instances (cooldown survives restart)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctis-monitor-test-'));
  const statePath = path.join(dir, 'monitor-state.json');
  try {
    const a = makeManager({ statePath, startAt: 2_000_000 });
    await a.manager.fail('rpc', 'critical', 'down', 'body');
    assert.equal(a.sent.length, 1);

    // New instance (simulated restart) shortly after: still in cooldown.
    const b = makeManager({ statePath, startAt: 2_000_000 + 60_000 });
    const dispatched = await b.manager.fail('rpc', 'critical', 'down', 'body');
    assert.equal(dispatched, false);
    assert.equal(b.sent.length, 0);
    assert.deepEqual(b.manager.activeKeys(), ['rpc']);

    // Recovery after restart still produces a notice.
    const recovered = await b.manager.pass('rpc');
    assert.equal(recovered, true);
    assert.equal(b.sent.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt state file is tolerated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctis-monitor-test-'));
  const statePath = path.join(dir, 'monitor-state.json');
  try {
    fs.writeFileSync(statePath, '{not json');
    const { manager, sent } = makeManager({ statePath });
    const dispatched = await manager.fail('rpc', 'critical', 'down', 'body');
    assert.equal(dispatched, true);
    assert.equal(sent.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat timestamp is persisted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noctis-monitor-test-'));
  const statePath = path.join(dir, 'monitor-state.json');
  try {
    const a = makeManager({ statePath, startAt: 3_000_000 });
    await a.manager.heartbeat('all good');
    assert.equal(a.manager.getLastHeartbeatAt(), 3_000_000);

    const b = makeManager({ statePath, startAt: 3_000_000 + 1 });
    assert.equal(b.manager.getLastHeartbeatAt(), 3_000_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
