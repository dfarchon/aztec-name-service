/** Offline preparation only. No wallet, RPC, bridge, deployment or public send implementation. */
import assert from 'node:assert/strict';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
export const V8_RESERVED_HASH = '743b1b4c3ab4762cb2d12662765406fdf91971845a5ec6137b1f7444223657fa';
export const V8_REHEARSAL_CASES = [
  'independent-registry-launch-resolver-and-accounts', 'free-registration-no-token-auth',
  'lengths-1-through-6-blocked', 'length-7-plus-allowed', 'all-325-reservations-readback',
  'admin-mint', 'pause-resume', 'fixed-year-renewal-cap', 'quote-60-120-180-240-300-seconds',
  'transferred-old-resolver-rejects-writes', 'constructor-runtime-class-binding',
  'registered-unapproved-target-rejected', 'exact-releases-and-directed-edges',
  'application-86400-protocol-86400', 'strict-cancel-before-activation-only',
  'state-and-pending-commit-same-instance', 'post-upgrade-writes', 'compatible-delayed-rollback',
  'revocation-reapproval-full-fresh-wait', 'two-step-admin-handoff',
] as const;
export function prepareV8Rehearsal(reservations: { categories: Record<string, string[]> }, checkpointDirectory: string, privateRoot: string) {
  const rel = relative(privateRoot, checkpointDirectory);
  assert(isAbsolute(checkpointDirectory) && rel && !rel.startsWith('..') && !isAbsolute(rel) && /^testnet-v8-upgrade-rehearsal-[a-z0-9-]+$/.test(rel), 'new independent private V8 checkpoint directory required');
  const labels = Object.values(reservations.categories).flat().sort();
  assert.equal(labels.length, 325); assert.equal(new Set(labels).size, 325);
  const hash = createHash('sha256').update(JSON.stringify(labels)).digest('hex'); assert.equal(hash, V8_RESERVED_HASH);
  const operations = [
    ['publish-root-class', 1], ['publish-successor-class', 1], ['deploy-independent-accounts', 2],
    ['deploy-registry', 1], ['deploy-resolver', 1], ['deploy-launch', 1], ['deploy-custom-resolver', 1], ['bootstrap', 1],
    ['seed-reservations', Math.ceil(labels.length / 32)], ['business-cases', null],
    ['approve-release', 1], ['approve-forward-and-rollback-edges', 1],
    ['propose-and-cancel', 2], ['propose-forward', 1], ['execute-and-cancel-scheduled', 2],
    ['propose-forward-again', 1], ['execute-forward', 1], ['post-upgrade-business-writes', null],
    ['propose-rollback', 1], ['execute-rollback', 1], ['settle-and-readback', null],
  ].map(([operation, transactions]) => ({ operation, transactions, measuredFeeJuice: null, status: 'unmeasured' }));
  return { schema: 'ans-v8-rehearsal-plan/1', offline: true, publicExecutionAllowed: false,
    checkpointDirectory, exactReleases: { root: metadata.v8.classId, successor: metadata.v8Rehearsal.classId, allowRehearsalSuccessor: true }, independentSuite: ['NameRegistryV8', 'NameRegistrarLaunch', 'NameResolver', 'new owner/treasury accounts'],
    reservations: { count: labels.length, hash, batches: Math.ceil(labels.length / 32) },
    cases: V8_REHEARSAL_CASES, operations,
    deploymentPolicy: { universalDeploy: false, nonzeroBoundOwnerRequired: true,
      beforeBootstrap: 'Use v8BoundDeployment(owner); read back instance.deployer and administrator with assertV8DeploymentOwner before further transactions. Persist the bound owner with the deployment checkpoint.' },
    waits: { applicationSeconds: 86400, protocolSeconds: 86400, forwardAndRollbackMinimumSeconds: 345600 },
    budget: { maximumFeeJuice: '90', maximumSepoliaEth: '0.006', estimate: null,
      decision: 'BLOCKED until independent safety review, Sonnet, fresh real-proof/network identity/balances and measured fees including both class publications; significant overrun stops before funding' },
    recovery: 'Persist hash before broadcast. Known hash means track only. Ambiguous/no hash means stop. Never auto-resend or duplicate bridge through SSH. Bounded bridge proven-block recovery only.',
  };
}
/** Waiting exits with a checkpoint. Scheduling uses chain seconds; local wall time is informational only. */
export function v8WaitCheckpoint(stage: 'application' | 'protocol' | 'rollback-application' | 'rollback-protocol', chainNow: bigint, readyAt: bigint) {
  assert(chainNow >= 0n && readyAt >= 0n);
  return { stage, status: chainNow < readyAt ? 'waiting' : 'ready-for-fresh-readback', chainNow: String(chainNow), earliestChainTimestamp: String(readyAt),
    earliestNextResumeAsiaTaipei: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'long', hour12: false }).format(new Date(Number(readyAt) * 1000)),
    action: 'exit with saved state; on resume verify canonical snapshot, network identity, live approvals and saved hashes before any next step' };
}

export const V8_REQUIRED_BUDGET_OPERATIONS = [
  'publish-root-class', 'publish-successor-class', 'deploy-independent-accounts', 'deploy-registry',
  'deploy-resolver', 'deploy-launch', 'deploy-custom-resolver', 'bootstrap', 'seed-reservations', 'business-cases',
  'approve-release', 'approve-forward-and-rollback-edges', 'propose-and-cancel', 'propose-forward',
  'execute-and-cancel-scheduled', 'propose-forward-again', 'execute-forward', 'post-upgrade-business-writes',
  'propose-rollback', 'execute-rollback', 'settle-and-readback',
] as const;
export type V8FeeMeasurement = { operation: string; transactions: number; feeJuiceBaseUnitsPerTransaction: bigint };
/** Read-only envelope comparison. Measurements and fresh independent-account balances are supplied after reviews. */
export function evaluateV8RehearsalBudget(requiredOperations: string[], measurements: V8FeeMeasurement[], availableFeeJuiceBaseUnits: bigint | undefined, estimatedSepoliaWei: bigint | undefined) {
  const maximumFeeJuice = 90n * 10n ** 18n, maximumSepolia = 6n * 10n ** 15n;
  assert(availableFeeJuiceBaseUnits === undefined || availableFeeJuiceBaseUnits >= 0n, 'invalid Fee Juice balance units');
  assert(estimatedSepoliaWei === undefined || estimatedSepoliaWei >= 0n, 'invalid Sepolia estimate units');
  const unique = new Map(measurements.map(row => [row.operation, row]));
  assert.equal(unique.size, measurements.length, 'duplicate fee measurement');
  for (const row of measurements) assert(Number.isSafeInteger(row.transactions) && row.transactions > 0 && row.feeJuiceBaseUnitsPerTransaction >= 0n, 'invalid fee measurement units/count');
  const required = new Set([...requiredOperations, ...V8_REQUIRED_BUDGET_OPERATIONS]);
  const missing = [...required].filter(operation => !unique.has(operation));
  const total = measurements.reduce((sum, row) => sum + BigInt(row.transactions) * row.feeJuiceBaseUnitsPerTransaction, 0n);
  const status = missing.length || estimatedSepoliaWei === undefined || availableFeeJuiceBaseUnits === undefined ? 'unmeasured'
    : total > maximumFeeJuice || estimatedSepoliaWei > maximumSepolia ? 'over-budget-stop-before-funding'
    : availableFeeJuiceBaseUnits < total ? 'balance-deficit' : 'within-envelope';
  return { readOnly: true, fundingAuthorized: false, publicExecutionAuthorized: false, status, missingMeasurements: missing,
    measuredFeeJuiceBaseUnits: String(total), estimatedSepoliaWei: estimatedSepoliaWei === undefined ? null : String(estimatedSepoliaWei),
    maximumFeeJuice: '90', maximumSepoliaEth: '0.006',
    next: 'Independent safety review and Sonnet precede fresh real-proof/network identity/balance/fee evidence. Stop/report any overrun before funding; no automatic resend or budget increase.' };
}
