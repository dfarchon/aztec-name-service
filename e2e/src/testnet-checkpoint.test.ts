import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptanceChecks, runCheckpointedStep } from './testnet-checkpoint.js';

test('completed steps reread saved receipts without rebroadcasting or repeating superseded state assertions', async () => {
  const state = { done: ['transfer'], transactions: { transfer: 'saved-hash' } };
  const unexpected = async () => { throw new Error('must not run'); };
  const receipt = await runCheckpointedStep(state, 'transfer', unexpected, async hash => {
    assert.equal(hash, 'saved-hash'); return { state: 'proven' };
  }, unexpected, unexpected);
  assert.deepEqual(receipt, { state: 'proven' });
  await assert.rejects(runCheckpointedStep(state, 'transfer', unexpected, async () => {
    throw new Error('transaction reorged');
  }, unexpected, unexpected), /transaction reorged/);
});

test('pending checkpoint is resumed and verified without a second transaction', async () => {
  const state = { done: [] as string[], transactions: { commit: 'existing-hash' } };
  const calls: string[] = [];
  await runCheckpointedStep(state, 'commit', async () => { throw new Error('duplicate broadcast'); },
    async hash => { calls.push(hash); }, async () => { calls.push('verify'); }, async () => { calls.push('save'); });
  assert.deepEqual(calls, ['existing-hash', 'verify', 'save']);
  assert.deepEqual(state.done, ['commit']);
});

test('missing receipt on a completed step fails closed and failed verification never marks a step done', async () => {
  const empty = async () => {};
  await assert.rejects(runCheckpointedStep({ done: ['deploy'], transactions: {} }, 'deploy',
    async () => { throw new Error('must not broadcast'); }, empty, empty, empty), /no transaction checkpoint/);
  const state = { done: [] as string[], transactions: {} as Record<string, string> };
  await assert.rejects(runCheckpointedStep(state, 'register', async () => { state.transactions.register = 'new-hash'; },
    empty, async () => { throw new Error('readback failed'); }, empty), /readback failed/);
  assert.deepEqual(state.done, []);
  assert.equal(state.transactions.register, 'new-hash');
});

test('acceptance reports distinguish historical checks from assertions executed on this run', () => {
  const historical = ['old behavioral assertion', 'current class assertion'];
  const checks = acceptanceChecks(historical);
  checks.check('current class assertion', true);
  checks.check('current state assertion', true);
  checks.check('current state assertion', true);
  assert.throws(() => checks.check('failed assertion', false));
  assert.deepEqual(checks.report(), {
    checks: ['current class assertion', 'current state assertion'],
    historicalChecks: ['old behavioral assertion', 'current class assertion', 'current state assertion'],
  });
});
