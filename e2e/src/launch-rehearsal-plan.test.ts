import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadReservedList } from './launch-policy.js';
import config from '../launch-rehearsal.json' with { type: 'json' };
import {
  rehearsalPlan,
  rehearsalConfirmation,
  quoteWindowMeasurements,
} from './launch-rehearsal-plan.js';
test('dry-run planner enumerates isolated fresh V7 deployment and all launch probes with explicit estimates', () => {
  const p = rehearsalPlan(config, '/example/new-checkpoint');
  assert(p.dryRun);
  assert.equal(p.protocol, 7);
  assert(p.steps.some((s) => s.step === 'old-resolver-rejected'));
  assert(p.steps.some((s) => s.step === 'admin-mint'));
  assert(p.steps.some((s) => s.step === 'pause'));
  assert.equal(
    p.steps.find((s) => s.step === 'commit')!.feeJuice +
      p.steps.find((s) => s.step === 'register')!.feeJuice,
    3.96,
  );
  assert(p.recommendedFeeJuice > p.totalFeeJuice);
  assert.equal(p.sepolia.ethBudget, '0.006');
  assert.notEqual(
    rehearsalConfirmation(p),
    rehearsalConfirmation(rehearsalPlan({ ...config, name: 'othername' }, p.stateDir)),
  );
  assert.notEqual(rehearsalConfirmation(p), rehearsalConfirmation(rehearsalPlan(config, '/other')));
  for (const patch of [
    { registryVersion: 6 },
    { network: 'mainnet' },
    { name: 'short' },
    { maxRenewAhead: '0' },
    { quoteWindowsSeconds: [60] },
    { reservedLabels: [] },
  ])
    assert.throws(() => rehearsalPlan({ ...config, ...patch }, '/new'));
});
test('quote experiment distinguishes SDK refusal, real checkpoint latency and reveal safety', () => {
  const rows = quoteWindowMeasurements([60, 120, 180, 240, 300], 180000, 180);
  assert.deepEqual(
    rows.map((r) => r.sdkCommitMarginAccepted),
    [false, false, false, false, true],
  );
  assert.deepEqual(
    rows.map((r) => r.revealMarginSatisfied),
    [false, false, false, true, true],
  );
  assert.equal(rows[4].remainingAfterMaturitySeconds, 120);
  assert.equal(rows[0].commitToCheckpointMs, 180000);
  assert.throws(() => quoteWindowMeasurements([60], -1, 0));
});

test('reservation budget scales by seed batch for the full v2 policy without changing the rehearsal fixture', () => {
  const labels = loadReservedList(JSON.parse(readFileSync(new URL('../../deployments/reserved-labels.json', import.meta.url), 'utf8')));
  const oldLabels = loadReservedList(JSON.parse(readFileSync(new URL('./fixtures/reserved-labels-v1.json', import.meta.url), 'utf8')));
  const fixture = rehearsalPlan(config, '/example/planning-only');
  const before = rehearsalPlan({ ...config, reservedLabels: oldLabels }, fixture.stateDir);
  const after = rehearsalPlan({ ...config, reservedLabels: labels }, fixture.stateDir);
  assert.equal(fixture.reservedSeedBatches, 1);
  assert.equal(before.reservedSeedBatches, 7);
  assert.equal(after.reservedSeedBatches, 9);
  assert.equal(after.steps.find(s => s.step === 'seed-reserved')!.feeJuice, 17.82);
  assert.equal(Number((after.totalFeeJuice - before.totalFeeJuice).toFixed(2)), 3.96);
  assert.deepEqual(after.steps.map(s => s.step), before.steps.map(s => s.step));
});
