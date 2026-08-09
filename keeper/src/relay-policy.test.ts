/**
 * @file Unit tests for the relayer economic anti-grief policy
 * @description Node built-in test runner via tsx: npm run test:policy
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RelayPolicy, RelayPolicyConfig } from './relay-policy';

const HOUR = 60 * 60 * 1000;

function makePolicy(overrides: Partial<RelayPolicyConfig> = {}) {
  let now = 1_000_000_000;
  const policy = new RelayPolicy({
    maxInflightPerVault: 2,
    minSettleRatio: 0.5,
    ratioMinSample: 4,
    throttleCooldownMs: 6 * HOUR,
    inflightTtlMs: 2 * HOUR,
    dailyGasBudgetWei: 1_000_000n,
    statePath: '',
    now: () => now,
    ...overrides,
  });
  return { policy, advance: (ms: number) => { now += ms; } };
}

test('first create is allowed', () => {
  const { policy } = makePolicy();
  assert.equal(policy.checkCreate('7').allowed, true);
});

test('in-flight cap blocks the third pending order and frees after settlement', () => {
  const { policy } = makePolicy();
  policy.noteCreated('7', '1');
  policy.noteCreated('7', '2');
  const blocked = policy.checkCreate('7');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'inflight_cap');
  assert.equal(blocked.httpStatus, 429);

  policy.noteSettled('1');
  assert.equal(policy.checkCreate('7').allowed, true);
});

test('in-flight cap is per vault', () => {
  const { policy } = makePolicy();
  policy.noteCreated('7', '1');
  policy.noteCreated('7', '2');
  assert.equal(policy.checkCreate('8').allowed, true);
});

test('cancel spam trips the settle-ratio throttle, cooldown then resets the window', () => {
  const { policy, advance } = makePolicy();
  for (let i = 1; i <= 4; i++) {
    policy.noteCreated('7', String(i));
    policy.noteWasted(String(i));
  }
  const blocked = policy.checkCreate('7');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'vault_throttled');

  advance(6 * HOUR + 1);
  assert.equal(policy.checkCreate('7').allowed, true);
});

test('healthy settle ratio is never throttled', () => {
  const { policy } = makePolicy();
  for (let i = 1; i <= 10; i++) {
    policy.noteCreated('7', String(i));
    if (i % 2 === 0) policy.noteWasted(String(i));
    else policy.noteSettled(String(i));
  }
  assert.equal(policy.checkCreate('7').allowed, true);
});

test('gas budget blocks creations and cancels, and rolls off after 24h', () => {
  const { policy, advance } = makePolicy();
  policy.noteGasSpent(1_000_000n);
  const create = policy.checkCreate('7');
  assert.equal(create.allowed, false);
  assert.equal(create.reason, 'gas_budget_exhausted');
  assert.equal(create.httpStatus, 503);
  assert.equal(policy.checkCancel().allowed, false);

  advance(24 * HOUR + 1);
  assert.equal(policy.checkCreate('7').allowed, true);
  assert.equal(policy.checkCancel().allowed, true);
});

test('zero budget disables the gas gate', () => {
  const { policy } = makePolicy({ dailyGasBudgetWei: 0n });
  policy.noteGasSpent(10n ** 18n);
  assert.equal(policy.checkCreate('7').allowed, true);
});

test('stale in-flight orders expire as wasted and can trip the throttle', () => {
  const { policy, advance } = makePolicy();
  for (let i = 1; i <= 4; i++) policy.noteCreated('7', String(i));
  advance(2 * HOUR + 1);
  const decision = policy.checkCreate('7'); // triggers expiry sweep
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'vault_throttled');
  const stats = policy.stats();
  assert.equal(stats.inflightTotal, 0);
  assert.equal(stats.wasted, 0); // counters reset by the throttle window
});

test('terminal notifications for unknown orders are no-ops', () => {
  const { policy } = makePolicy();
  policy.noteSettled('999');
  policy.noteWasted('999');
  const stats = policy.stats();
  assert.equal(stats.settled, 0);
  assert.equal(stats.wasted, 0);
});

test('stats are aggregate-only and expose budget usage', () => {
  const { policy } = makePolicy();
  policy.noteCreated('7', '1');
  policy.noteCreated('8', '2');
  policy.noteSettled('2');
  policy.noteGasSpent(250_000n);
  const stats = policy.stats();
  assert.equal(stats.inflightTotal, 1);
  assert.equal(stats.trackedVaults, 2);
  assert.equal(stats.settled, 1);
  assert.equal(stats.settleRatio, 1);
  assert.equal(stats.gasSpent24hWei, '250000');
  assert.equal(stats.budgetUsedPct, 25);
  assert.equal(stats.budgetExhausted, false);
  assert.equal(JSON.stringify(stats).includes('"7"'), false); // no vaultIds leaked
});

test('state survives a restart via the state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-policy-'));
  const statePath = path.join(dir, 'state.json');
  let now = 1_000_000_000;
  const cfg: RelayPolicyConfig = {
    maxInflightPerVault: 2,
    minSettleRatio: 0.5,
    ratioMinSample: 4,
    throttleCooldownMs: 6 * HOUR,
    inflightTtlMs: 2 * HOUR,
    dailyGasBudgetWei: 1_000_000n,
    statePath,
    now: () => now,
  };

  const first = new RelayPolicy(cfg);
  first.noteCreated('7', '1');
  first.noteCreated('7', '2');
  first.noteGasSpent(400_000n);

  const second = new RelayPolicy(cfg);
  assert.equal(second.checkCreate('7').allowed, false);
  assert.equal(second.gasSpent24h(), 400_000n);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('corrupt state file starts fresh instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-policy-'));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, '{not json', 'utf8');
  const policy = new RelayPolicy({
    maxInflightPerVault: 2,
    minSettleRatio: 0.5,
    ratioMinSample: 4,
    throttleCooldownMs: 6 * HOUR,
    inflightTtlMs: 2 * HOUR,
    dailyGasBudgetWei: 1_000_000n,
    statePath,
  });
  assert.equal(policy.checkCreate('7').allowed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
