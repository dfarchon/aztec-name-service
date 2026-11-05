/** Pure public rehearsal planning; no wallet or filesystem dependencies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export type RehearsalConfig = {
  schema: string;
  network: string;
  registryVersion: number;
  registrarKind: string;
  minPublicLength: number;
  maxRenewAhead: string;
  reservedLabels: string[];
  name: string;
  mintName: string;
  quoteWindowsSeconds: number[];
  registrationFeeJuice: string;
  l1Address: string;
  balanceAccounts: string[];
  balanceSource: string;
  resolverProbe: string;
};
export function rehearsalPlan(c: RehearsalConfig, stateDir: string) {
  assert.equal(c.schema, 'ans-v7-launch-rehearsal/1');
  assert.equal(c.network, 'testnet-v6');
  assert.equal(c.registryVersion, 7);
  assert.equal(c.registrarKind, 'launch');
  assert.equal(c.minPublicLength, 7);
  assert.equal(c.maxRenewAhead, '31536000');
  assert.equal(c.registrationFeeJuice, '3.96');
  assert(/^[a-z][a-z0-9-]{6,30}$/.test(c.name));
  assert(!c.reservedLabels.includes(c.name));
  assert(
    c.reservedLabels.length > 0 && c.reservedLabels.every((n) => /^[a-z][a-z0-9-]{6,30}$/.test(n)),
  );
  assert(/^[a-z]{3}$/.test(c.mintName));
  assert.deepEqual(c.quoteWindowsSeconds, [60, 120, 180, 240, 300]);
  assert(/^0x[\da-f]{40}$/i.test(c.l1Address));
  assert(c.balanceAccounts.every((a) => /^0x[\da-f]{64}$/i.test(a)));
  const steps = [
    ['deploy-registry', 4],
    ['deploy-resolver', 3],
    ['deploy-registrar', 4],
    ['deploy-custom-resolver', 3],
    ['configure', 1.98],
    ['seed-reserved', 1.98],
    ['resume', 1.98],
    ['commit', 1.98],
    ['register', 1.98],
    ['choose-custom-resolver', 1.98],
    ['custom-write', 1.98],
    ['offer-transfer', 1.98],
    ['accept-transfer', 1.98],
    ['old-resolver-rejected', 0],
    ['reserved-rejected', 0],
    ['short-rejected', 0],
    ['admin-commit', 1.98],
    ['admin-mint', 1.98],
    ['pause', 1.98],
    ['paused-rejected', 0],
    ['resume-final', 1.98],
  ].map(([step, feeJuice]) => ({
    step: String(step),
    feeJuice: Number(feeJuice),
    basis:
      Number(feeJuice) === 0
        ? 'read-only simulation/preflight'
        : String(step).startsWith('deploy-')
          ? 'provisional deployment allowance; unmeasured'
          : 'budget allocation from prior ~3.96 FJ per user registration; per-call split and other calls unmeasured',
  }));
  const base = Number(steps.reduce((n, s) => n + s.feeJuice, 0).toFixed(2));
  return {
    dryRun: true,
    network: c.network,
    protocol: 7,
    stateDir,
    configHash: createHash('sha256').update(JSON.stringify(c)).digest('hex'),
    steps,
    totalFeeJuice: base,
    recommendedFeeJuice: Math.ceil(base * 1.5),
    feeEstimate:
      'Planning allowances, not a gas simulation or guaranteed bound; account deployment/bridge claims and failed real transactions are additional.',
    resolverProbe: c.resolverProbe,
    quoteWindowsSeconds: c.quoteWindowsSeconds,
    quoteRule:
      'SDK requires 300 seconds remaining before commit. Probe 60–300 seconds read-only; measure actual commit start -> checkpoint latency using a 86400-second quote, then report remaining reveal margin for each window.',
    sepolia: {
      bridgeGasPerAccount: 600000,
      gasPriceGweiBudget: 5,
      accounts: 2,
      ethBudget: '0.006',
      basis:
        'Conservative gas allowance for mint, approve, deposit per account; gas price read live; no ETH purchase of FJ assumed. Mint handler availability/limits require bridge dry-run.',
    },
    requirements: [
      'Supervisor creates a new private directory under ~/.local/share/ans/ and generates independent owner/treasury keys using existing offline --init-keys.',
      'Fund both new public accounts through the existing checkpointed bridge runner before --send; old balances are observational only.',
      'Use the same checkpoint on resume. Saved hashes, including reverted/dropped/ambiguous hashes, are never removed or automatically resent.',
      'Confirm network version, chain, rollup and real proving before every wallet operation and raw send.',
    ],
  };
}
export function rehearsalConfirmation(plan: ReturnType<typeof rehearsalPlan>) {
  return `rehearse:testnet-v6:7:${plan.configHash}:${plan.stateDir}`;
}
export function quoteWindowMeasurements(
  windows: number[],
  elapsedMs: number,
  chainElapsedSeconds: number,
) {
  assert(elapsedMs >= 0 && chainElapsedSeconds >= 0);
  return windows.map((seconds) => ({
    seconds,
    sdkCommitMarginAccepted: seconds >= 300,
    commitToCheckpointMs: elapsedMs,
    remainingAfterMaturitySeconds: seconds - Math.max(60, chainElapsedSeconds),
    revealMarginSatisfied: seconds - Math.max(60, chainElapsedSeconds) >= 60,
  }));
}
