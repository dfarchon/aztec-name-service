import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUnits, leaseDays, leaseText, PENDING_TX, retryDelay } from '../../web/src/usability.js';
import { metricSample, transition } from '../../ops/src/monitor.js';

test('token display preserves exact precision, including tiny and large amounts', () => {
  assert.equal(formatUnits(1000000n, 6), '1');
  assert.equal(formatUnits(1n, 18), '0.000000000000000001');
  assert.equal(formatUnits(123456789123456789123456789n, 6), '123456789123456789123.456789');
  assert.equal(formatUnits(10n, 0), '10');
  assert.throws(() => formatUnits(1n, -1));
});
test('lease reminders distinguish upcoming expiry from expired names', () => {
  assert.equal(leaseDays(86401n, 1000), 1);
  assert.equal(leaseText(1n, 1001), 'Expired');
  assert.equal(leaseText(86402n, 1000), '2 days left');
  assert.equal(leaseText(86401n, 1000), '1 day left');
});
test('connection backoff is bounded and only pending known transactions are watched', () => {
  assert.equal(retryDelay(100), 30000);
  assert.ok(!PENDING_TX.has('confirmed') && !PENDING_TX.has('reverted'));
  assert.ok(PENDING_TX.has('unknown') && PENDING_TX.has('reorged'));
});
test('monitor alerts only on sustained failure and records one recovery', () => {
  const bad = [{ name: 'rpc', ok: false, detail: 'offline' }];
  const first = transition(undefined, bad, 1);
  const second = transition(first.state, bad, 2);
  const third = transition(second.state, bad, 3);
  assert.equal(first.incidents.length + second.incidents.length, 0);
  assert.deepEqual(third.incidents, [{ name: 'rpc', kind: 'alert', at: 3 }]);
  const fourth = transition(third.state, bad, 4);
  assert.equal(fourth.incidents.length, 0);
  const recovery = transition(fourth.state, [{ name: 'rpc', ok: true, detail: 'online' }], 5);
  assert.deepEqual(recovery.incidents, [{ name: 'rpc', kind: 'recovered', at: 5 }]);
  assert.equal(recovery.state.failures.rpc, 0);
  assert.deepEqual(recovery.state.open, []);
});
test('metric ingestion refuses unknown fields, secrets, invalid values and unbounded samples', () => {
  assert.equal(metricSample({ name: 'LCP', value: 1800, release: 'abc123' })?.bucket, 2500);
  for (const d of [{ name: 'CLS', value: -1, release: 'abc' }, { name: 'LCP', value: Infinity, release: 'abc' }, { name: 'LCP', value: 1, release: 'abc', secret: 'no' }, { name: 'unknown', value: 1, release: 'abc' }]) assert.equal(metricSample(d), undefined);
});
