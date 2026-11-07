import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveWritesAllowed, observeRpcReads, type ConnectionStatus } from '../src/connection.ts';
import { makeRpcFetch, RPC_RETRY } from '../src/rpc.ts';

const call = (method = 'aztec_getBlockNumber') => ({ jsonrpc: '2.0', id: 1, method, params: [] });
const host = 'https://only-rpc.example.invalid';
const clock = { now: () => 0, random: () => 0, sleep: async () => {} };
test('live write gate rejects unavailable states and preserves healthy setup states', () => {
  for (const status of ['booting', 'misconfigured', 'offline', 'locked', 'unlocking', 'ready'] as ConnectionStatus[])
    assert.equal(liveWritesAllowed(status), ['locked', 'unlocking', 'ready'].includes(status), status);
});
test('outage exhausts reads at the same endpoint before notifying once, without fallback', async () => {
  const hosts: unknown[] = [], failures: unknown[] = [];
  const transport = makeRpcFetch(undefined, async url => { hosts.push(url); throw new TypeError('Failed to fetch'); }, clock);
  const response = await observeRpcReads(transport, e => failures.push(e))(host, call());
  assert.equal(response.response.error.rpcRetry.retryCount, 3);
  assert.deepEqual(hosts, Array(RPC_RETRY.maxAttempts).fill(host));
  assert.equal(failures.length, 1);
});
test('healthy recovery is returned unchanged; semantic RPC errors do not declare an outage', async () => {
  const failures: unknown[] = [];
  for (const reply of [{ id: 1, result: 10 }, { id: 1, error: { code: -32602, message: 'invalid parameter' } }]) {
    const transport = makeRpcFetch(undefined, async () => Response.json(reply), clock);
    assert.deepEqual((await observeRpcReads(transport, e => failures.push(e))(host, call())).response, reply);
  }
  assert.deepEqual(failures, []);
});
test('permanent HTTP read failure is observed without retry or swallowing the error', async () => {
  let attempts = 0, notified = 0;
  const transport = makeRpcFetch(undefined, async () => { attempts++; return new Response('', { status: 403 }); }, clock);
  await assert.rejects(observeRpcReads(transport, () => notified++)(host, call()));
  assert.equal(attempts, 1);
  assert.equal(notified, 1);
});
test('sendTx network exception sends once, throws and is never replayed by the observer', async () => {
  let attempts = 0, notified = 0;
  const transport = makeRpcFetch(undefined, async () => { attempts++; throw new TypeError('Failed to fetch'); }, clock);
  await assert.rejects(observeRpcReads(transport, () => notified++)(host, call('aztec_sendTx')));
  assert.equal(attempts, 1);
  assert.equal(notified, 0);
});
test('a failed noRetry read withdraws capabilities after one attempt without replay', async () => {
  let attempts = 0, notified = 0;
  const transport = makeRpcFetch(undefined, async () => { attempts++; throw new TypeError('Failed to fetch'); }, clock);
  await assert.rejects(observeRpcReads(transport, () => notified++)(host, call(), {}, true));
  assert.equal(attempts, 1);
  assert.equal(notified, 1);
});
