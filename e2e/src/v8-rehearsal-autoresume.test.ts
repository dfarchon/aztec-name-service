import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluateAndMaybeResume, type RehearsalReport } from './v8-rehearsal-autoresume.js';



function baseReport(overrides: Partial<RehearsalReport> = {}): RehearsalReport {
  return {
    schema: 'ans-v8-live-rehearsal-report/1',
    status: 'WAITING_APPLICATION-SCHEDULED-CANCEL',
    stage: 'application',
    confirmation: 'v8-rehearsal:test',
    l1FundingAddress: '0x79285AE983Bfb13A14EC2ECD5576037E3A12ea1D',
    actors: { A: { address: '0x01', bridgeAmountFeeJuice: '150' } },
    addresses: { registry: '0x0c07' },
    l1Transactions: { 'l1-mint': '0xaa' },
    l1Done: ['l1-mint'],
    l1SpentWei: '20479560',
    l2Transactions: { 'deploy-registry': '0xbb' },
    l2Done: ['deploy-registry'],
    l2SpentFeeJuiceWei: '1500000000000000000',
    waitTimestamps: { 'application-scheduled-cancel': '2026-11-18 12:00:00 CST' },
    earliestChainTimestamp: '1795000000',
    earliestNextResumeAsiaTaipei: '2026-11-18 12:00:00 CST',
    ...overrides,
  };
}

test('auto-resumer respects active runner lock, chain delay, one-shot resume and crash halt latch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ans-v8-autoresume-'));
  try {
    await chmod(root, 0o700);
    const fakeSigner = { uid: process.getuid!(), username: 'ans-signer', signerRoot: root };
    const stateDir = join(root, 'testnet-v8-upgrade-rehearsal-20261117');
    const statusOut = join(root, 'public', 'status.json');
    await mkdir(stateDir, { mode: 0o700 });
    await chmod(stateDir, 0o700);

    const writeReport = async (r: RehearsalReport) => {
      const p = join(stateDir, 'report.json');
      await writeFile(p, JSON.stringify(r, null, 2), { mode: 0o600 });
      await chmod(p, 0o600);
    };

    // 1. Active runner lock -> ACTIVE_RUNNER, zero RPC or send calls
    await writeReport(baseReport({ status: 'IN_PROGRESS' }));
    await writeFile(join(stateDir, 'runner.lock'), JSON.stringify({ pid: 42424, token: 't1' }), { mode: 0o600 });
    let sends = 0;
    let chainReads = 0;
    let res = await evaluateAndMaybeResume({
      stateDir,
      statusOut,
      signer: fakeSigner,
      isPidAlive: (pid) => pid === 42424,
      readSafeChainNow: async () => {
        chainReads++;
        return 0n;
      },
      invokeSend: async () => {
        sends++;
      },
    });
    assert.equal(res.phase, 'ACTIVE_RUNNER');
    assert.equal(res.activePid, 42424);
    assert.equal(chainReads, 0);
    assert.equal(sends, 0);

    // 2. Waiting before earliestChainTimestamp -> WAITING_CHAIN_DELAY, zero sends
    await rm(join(stateDir, 'runner.lock'));
    await writeReport(baseReport());
    res = await evaluateAndMaybeResume({
      stateDir,
      statusOut,
      signer: fakeSigner,
      isPidAlive: () => false,
      readSafeChainNow: async () => 1794999000n,
      invokeSend: async () => {
        sends++;
      },
    });
    assert.equal(res.phase, 'WAITING_CHAIN_DELAY');
    assert.equal(res.remainingSeconds, 1000);
    assert.equal(sends, 0);

    // 3. Chain timestamp reaches readyAt -> triggers invokeSend ONCE and updates to next WAITING_CHAIN_DELAY
    res = await evaluateAndMaybeResume({
      stateDir,
      statusOut,
      signer: fakeSigner,
      isPidAlive: () => false,
      readSafeChainNow: async () => 1795000010n,
      invokeSend: async (confirm) => {
        assert.equal(confirm, 'v8-rehearsal:test');
        sends++;
        await writeReport(
          baseReport({
            status: 'WAITING_APPLICATION',
            l2Done: ['deploy-registry', 'propose-forward-live'],
            earliestChainTimestamp: '1795086410',
          }),
        );
      },
    });
    assert.equal(sends, 1);
    assert.equal(res.phase, 'WAITING_CHAIN_DELAY');
    assert.equal(res.lastCompletedStep, 'propose-forward-live');
    assert.equal(res.remainingSeconds, 86400);

    // 4. Crash / failed send latches halted.json and blocks any subsequent retry
    res = await evaluateAndMaybeResume({
      stateDir,
      statusOut,
      signer: fakeSigner,
      isPidAlive: () => false,
      readSafeChainNow: async () => 1795090000n,
      invokeSend: async () => {
        sends++;
        throw new Error('simulated RPC timeout');
      },
    });
    assert.equal(sends, 2);
    assert.equal(res.phase, 'HALTED_INSPECT_REQUIRED');
    assert.match(res.haltReason ?? '', /simulated RPC timeout/);

    // Subsequent tick must NOT call invokeSend again!
    res = await evaluateAndMaybeResume({
      stateDir,
      statusOut,
      signer: fakeSigner,
      isPidAlive: () => false,
      readSafeChainNow: async () => 1795090100n,
      invokeSend: async () => {
        sends++;
      },
    });
    assert.equal(sends, 2);
    assert.equal(res.phase, 'HALTED_INSPECT_REQUIRED');

    const savedPublic = JSON.parse(await readFile(statusOut, 'utf8'));
    assert.equal(savedPublic.phase, 'HALTED_INSPECT_REQUIRED');
    assert.equal('confirmation' in savedPublic, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
