import test from 'node:test';
import assert from 'node:assert/strict';
import reservations from '../../deployments/reserved-labels.json' with { type: 'json' };
import { prepareV8Rehearsal, v8WaitCheckpoint } from './v8-rehearsal-plan.js';
import { v8BoundDeployment, assertV8DeploymentOwner } from './v8-deployment.js';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
test('V8 offline plan retains full reservations, independent suite and unmeasured budget stop', () => {
  const plan = prepareV8Rehearsal(reservations, '/private/testnet-v8-upgrade-rehearsal-new', '/private');
  assert.equal(plan.reservations.count, 325); assert.equal(plan.reservations.batches, 11);
  assert.equal(plan.publicExecutionAllowed, false); assert.equal(plan.budget.estimate, null);
  assert.equal(plan.waits.forwardAndRollbackMinimumSeconds, 345600);
  assert(plan.operations.some(step => step.operation === 'publish-successor-class'));
  assert.equal(plan.deploymentPolicy.universalDeploy, false);
  assert.equal(plan.deploymentPolicy.nonzeroBoundOwnerRequired, true);
});
test('V8 deployment refuses zero owner and mismatched initializer readback', () => {
  const owner = AztecAddress.fromBigIntUnsafe(1n), other = AztecAddress.fromBigIntUnsafe(2n);
  assert.throws(() => v8BoundDeployment(AztecAddress.ZERO), /nonzero/);
  assert.deepEqual(v8BoundDeployment(owner), { deployer: owner });
  assertV8DeploymentOwner(owner, owner, owner);
  for (const [deployer, administrator] of [[AztecAddress.ZERO, owner], [other, owner], [owner, other], [owner, undefined]] as const)
    assert.throws(() => assertV8DeploymentOwner(owner, deployer, administrator), /differs/);
});
test('V8 plan rejects old or repository checkpoint directories and truncated list', () => {
  assert.throws(() => prepareV8Rehearsal(reservations, '/repo/checkpoint', '/private'));
  assert.throws(() => prepareV8Rehearsal(reservations, '/private/testnet-v7-launch-rehearsal-old', '/private'));
  assert.throws(() => prepareV8Rehearsal({ categories: { small: ['reserved'] } }, '/private/testnet-v8-upgrade-rehearsal-new', '/private'));
});
test('V8 wait checkpoint exits with explicit Asia/Taipei resume time and does not poll', () => {
  const wait = v8WaitCheckpoint('application', 1700000000n, 1700086400n);
  assert.equal(wait.status, 'waiting'); assert.match(wait.earliestNextResumeAsiaTaipei, /GMT\+8/);
  assert.equal(v8WaitCheckpoint('protocol', 1700086400n, 1700086400n).status, 'ready-for-fresh-readback');
});

test('V8 measured envelope cannot omit class publication or silently increase funding', async () => {
  const { evaluateV8RehearsalBudget, V8_REQUIRED_BUDGET_OPERATIONS } = await import('./v8-rehearsal-plan.js');
  assert.equal(evaluateV8RehearsalBudget([], [], undefined, undefined).status, 'unmeasured');
  const operations = [...V8_REQUIRED_BUDGET_OPERATIONS];
  const measurements = operations.map(operation => ({ operation, transactions: 1, feeJuiceBaseUnitsPerTransaction: 10n ** 18n }));
  const pass = evaluateV8RehearsalBudget(operations, measurements, 90n * 10n ** 18n, 6n * 10n ** 15n);
  assert.equal(pass.status, 'within-envelope'); assert.equal(pass.fundingAuthorized, false); assert.equal(pass.publicExecutionAuthorized, false);
  assert.equal(evaluateV8RehearsalBudget(operations, measurements.slice(1), 90n * 10n ** 18n, 0n).status, 'unmeasured');
  assert.equal(evaluateV8RehearsalBudget(operations, measurements, 0n, 0n).status, 'balance-deficit');
  assert.equal(evaluateV8RehearsalBudget(operations, measurements.map(row => ({ ...row, feeJuiceBaseUnitsPerTransaction: 10n * 10n ** 18n })), 1000n * 10n ** 18n, 0n).status, 'over-budget-stop-before-funding');
  assert.equal(evaluateV8RehearsalBudget(operations, measurements, 90n * 10n ** 18n, 6000000000000001n).status, 'over-budget-stop-before-funding');
});


test('V8 future and rehearsal profiles pin exact release IDs with explicit successor opt-in', async () => {
  const { default: future } = await import('../../deployments/future-v8.template.json', { with: { type: 'json' } });
  const { default: rehearsal } = await import('../v8-rehearsal.json', { with: { type: 'json' } });
  const { default: metadata } = await import('../../sdk/src/artifacts/modular-metadata.json', { with: { type: 'json' } });
  assert.equal(future.initialClassId, metadata.v8.classId); assert.equal(future.allowRehearsalSuccessor, false); assert.deepEqual(future.approvedSuccessorClassIds, []);
  assert.equal(rehearsal.allowRehearsalSuccessor, true); assert.deepEqual(rehearsal.approvedSuccessorClassIds, [metadata.v8Rehearsal.classId]);
  assert.deepEqual(rehearsal.reviewedUpgradeEdges, [{ from: metadata.v8.classId, to: metadata.v8Rehearsal.classId, kind: 'forward' }, { from: metadata.v8Rehearsal.classId, to: metadata.v8.classId, kind: 'rollback' }]);
  for (const profile of [future, rehearsal]) { assert.equal(profile.publicTransactionsAllowed, false); assert.equal(profile.sitePublicationAllowed, false); }
});
