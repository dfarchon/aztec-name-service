/**
 * Fail-closed, read-only chain-time gated auto-resumer for the V8 public testnet rehearsal.
 * Runs exclusively as `ans-signer`. Never touches credentials directly; reads only `report.json` + `runner.lock`.
 * Resumes `--send` ONLY when a clean `WAITING_*` checkpoint exists AND both proposed & checkpointed L2 timestamps
 * have reached `earliestChainTimestamp`. Any crash or non-zero exit writes `halted.json` and stops permanently.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlockNumber } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { formatUnits } from 'viem';
import { assertIsolatedSignerDirectory, currentSignerIdentity, type SignerIdentity } from './v8-account-generator.js';
import { savePrivateJson } from './testnet-v6-e2e-state.js';
import { V6_PROFILES } from './v6-network.js';

export type RehearsalReport = {
  schema: 'ans-v8-live-rehearsal-report/1';
  status: string;
  stage?: string;
  confirmation: string;
  l1FundingAddress: string;
  actors: Record<string, { address: string; bridgeAmountFeeJuice: string }>;
  addresses: Record<string, string> | null;
  l1Transactions: Record<string, string>;
  l1Done: string[];
  l1SpentWei: string;
  l2Transactions: Record<string, string>;
  l2Done: string[];
  l2SpentFeeJuiceWei: string;
  waitTimestamps: Record<string, string>;
  earliestChainTimestamp?: string;
  earliestNextResumeAsiaTaipei?: string;
  completedAt?: string;
};

export type PublicAutoStatus = {
  schema: 'ans-v8-autoresume-status/1';
  checkedAt: string;
  phase:
    | 'ACTIVE_RUNNER'
    | 'WAITING_CHAIN_DELAY'
    | 'RESUMING'
    | 'COMPLETED'
    | 'HALTED_INSPECT_REQUIRED';
  reportStatus: string;
  waitStage: string | null;
  activePid: number | null;
  l1DoneCount: number;
  l2DoneCount: number;
  lastCompletedStep: string | null;
  inFlightSteps: string[];
  l1SpentEth: string;
  l2SpentFeeJuice: string;
  addresses: Record<string, string> | null;
  safeChainNow: string | null;
  earliestChainTimestamp: string | null;
  remainingSeconds: number | null;
  earliestNextResumeAsiaTaipei: string | null;
  waitTimestamps: Record<string, string>;
  haltReason: string | null;
};

export function defaultPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readSignerReport(stateDir: string, signer: SignerIdentity): Promise<RehearsalReport> {
  const f = await open(join(stateDir, 'report.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    assert(s.isFile() && s.uid === signer.uid && (s.mode & 0o777) === 0o600, 'Unsafe report.json permissions');
    const parsed = JSON.parse(await f.readFile('utf8')) as RehearsalReport;
    assert.equal(parsed.schema, 'ans-v8-live-rehearsal-report/1', 'Invalid report schema');
    return parsed;
  } finally {
    await f.close();
  }
}

async function writePublicStatus(statusOut: string | undefined, payload: PublicAutoStatus) {
  if (!statusOut) return;
  await mkdir(dirname(statusOut), { recursive: true });
  const tmp = `${statusOut}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o644 });
  await rename(tmp, statusOut);
}

export async function evaluateAndMaybeResume(opts: {
  stateDir: string;
  statusOut?: string;
  signer?: SignerIdentity;
  isPidAlive?: (pid: number) => boolean;
  readSafeChainNow?: () => Promise<bigint>;
  invokeSend?: (confirmation: string) => Promise<void>;
}): Promise<PublicAutoStatus> {
  const signer = opts.signer ?? currentSignerIdentity();
  await assertIsolatedSignerDirectory(opts.stateDir, signer, true);
  const isPidAlive = opts.isPidAlive ?? defaultPidAlive;

  const report = await readSignerReport(opts.stateDir, signer);
  const haltedPath = join(opts.stateDir, 'halted.json');
  const lockPath = join(opts.stateDir, 'runner.lock');

  const doneSet = new Set(report.l2Done);
  const inFlightSteps = Object.keys(report.l2Transactions).filter((k) => !doneSet.has(k));
  const base = (
    phase: PublicAutoStatus['phase'],
    extra: Partial<PublicAutoStatus> = {},
  ): PublicAutoStatus => ({
    schema: 'ans-v8-autoresume-status/1',
    checkedAt: new Date().toISOString(),
    phase,
    reportStatus: report.status,
    waitStage: report.stage ?? null,
    activePid: null,
    l1DoneCount: report.l1Done.length,
    l2DoneCount: report.l2Done.length,
    lastCompletedStep: report.l2Done.at(-1) ?? null,
    inFlightSteps,
    l1SpentEth: formatUnits(BigInt(report.l1SpentWei || '0'), 18),
    l2SpentFeeJuice: formatUnits(BigInt(report.l2SpentFeeJuiceWei || '0'), 18),
    addresses: report.addresses ?? null,
    safeChainNow: null,
    earliestChainTimestamp: report.earliestChainTimestamp ?? null,
    remainingSeconds: null,
    earliestNextResumeAsiaTaipei: report.earliestNextResumeAsiaTaipei ?? null,
    waitTimestamps: report.waitTimestamps ?? {},
    haltReason: null,
    ...extra,
  });

  // 1. Check permanent halt latches first (never auto-retry after a failure).
  try {
    const rawHalt = JSON.parse(await readFile(haltedPath, 'utf8')) as { reason?: string };
    const out = base('HALTED_INSPECT_REQUIRED', { haltReason: rawHalt.reason ?? 'halted' });
    await writePublicStatus(opts.statusOut, out);
    return out;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // 2. Check active runner lock before inspecting IN_PROGRESS vs WAITING.
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number };
    if (typeof lock.pid === 'number' && isPidAlive(lock.pid)) {
      const out = base('ACTIVE_RUNNER', { activePid: lock.pid });
      await writePublicStatus(opts.statusOut, out);
      return out;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // 3. Completed rehearsal is terminal no-op.
  if (report.status === 'COMPLETED') {
    const out = base('COMPLETED');
    await writePublicStatus(opts.statusOut, out);
    return out;
  }

  // 4. IN_PROGRESS without a live lock means the runner crashed or failed mid-step -> HALT immediately!
  const isWaiting =
    (report.status === 'waiting' || report.status.startsWith('WAITING_')) &&
    typeof report.earliestChainTimestamp === 'string' &&
    /^[0-9]+$/.test(report.earliestChainTimestamp);

  if (!isWaiting) {
    const reason = `Runner not active while report status=${report.status}; halting without auto-retry`;
    await savePrivateJson(haltedPath, { haltedAt: new Date().toISOString(), reason, reportStatus: report.status });
    const out = base('HALTED_INSPECT_REQUIRED', { haltReason: reason });
    await writePublicStatus(opts.statusOut, out);
    return out;
  }

  // 5. Read-only chain timestamp check (both proposed and checkpointed blocks must reach readyAt).
  const readyAt = BigInt(report.earliestChainTimestamp!);
  const readSafeChainNow =
    opts.readSafeChainNow ??
    (async () => {
      const node = createAztecNodeClient(V6_PROFILES['testnet-v6'].nodeUrl, { maxBatchSize: 10 });
      const tips = await node.getChainTips();
      const [bProp, bCheck] = await Promise.all([
        node.getBlockData(BlockNumber(tips.proposed.number)),
        node.getBlockData(BlockNumber(tips.checkpointed.block.number)),
      ]);
      assert(bProp && bCheck, 'Missing Aztec block header from RPC');
      const tProp = BigInt(bProp.header.globalVariables.timestamp);
      const tCheck = BigInt(bCheck.header.globalVariables.timestamp);
      return tProp < tCheck ? tProp : tCheck;
    });

  const safeNow = await readSafeChainNow();
  if (safeNow < readyAt) {
    const out = base('WAITING_CHAIN_DELAY', {
      safeChainNow: String(safeNow),
      remainingSeconds: Number(readyAt - safeNow),
    });
    await writePublicStatus(opts.statusOut, out);
    return out;
  }

  // 6. Chain delay satisfied! Mark RESUMING, invoke `--send` ONCE, and latch `halted.json` on any error.
  await writePublicStatus(
    opts.statusOut,
    base('RESUMING', { safeChainNow: String(safeNow), remainingSeconds: 0 }),
  );

  const invokeSend =
    opts.invokeSend ??
    (async (confirmation: string) => {
      const entry = resolve(dirname(fileURLToPath(import.meta.url)), 'testnet-v8-upgrade-rehearsal.ts');
      await new Promise<void>((res, rej) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', entry, '--send', '--state-dir', opts.stateDir, '--confirm', confirmation],
          { stdio: 'inherit', cwd: resolve(dirname(entry), '../..') },
        );
        child.on('error', rej);
        child.on('exit', (code, signal) => {
          if (code === 0) res();
          else rej(new Error(`Rehearsal send exited code=${code} signal=${signal}`));
        });
      });
    });

  try {
    await invokeSend(report.confirmation);
  } catch (err) {
    const reason = `Auto-resume leg failed: ${(err as Error).message ?? 'unknown error'}`;
    await savePrivateJson(haltedPath, { haltedAt: new Date().toISOString(), reason });
    const out = base('HALTED_INSPECT_REQUIRED', {
      safeChainNow: String(safeNow),
      remainingSeconds: 0,
      haltReason: reason,
    });
    await writePublicStatus(opts.statusOut, out);
    return out;
  }

  // Refresh public status from updated report.json after clean leg exit!
  const updated = await readSignerReport(opts.stateDir, signer);
  const nextWaiting =
    (updated.status === 'waiting' || updated.status.startsWith('WAITING_')) &&
    typeof updated.earliestChainTimestamp === 'string';
  const finalPhase: PublicAutoStatus['phase'] =
    updated.status === 'COMPLETED'
      ? 'COMPLETED'
      : nextWaiting
        ? 'WAITING_CHAIN_DELAY'
        : 'HALTED_INSPECT_REQUIRED';
  const rem =
    nextWaiting && BigInt(updated.earliestChainTimestamp!) > safeNow
      ? Number(BigInt(updated.earliestChainTimestamp!) - safeNow)
      : 0;
  const doneAfter = new Set(updated.l2Done);
  const finalOut: PublicAutoStatus = {
    schema: 'ans-v8-autoresume-status/1',
    checkedAt: new Date().toISOString(),
    phase: finalPhase,
    reportStatus: updated.status,
    waitStage: updated.stage ?? null,
    activePid: null,
    l1DoneCount: updated.l1Done.length,
    l2DoneCount: updated.l2Done.length,
    lastCompletedStep: updated.l2Done.at(-1) ?? null,
    inFlightSteps: Object.keys(updated.l2Transactions).filter((k) => !doneAfter.has(k)),
    l1SpentEth: formatUnits(BigInt(updated.l1SpentWei || '0'), 18),
    l2SpentFeeJuice: formatUnits(BigInt(updated.l2SpentFeeJuiceWei || '0'), 18),
    addresses: updated.addresses ?? null,
    safeChainNow: String(safeNow),
    earliestChainTimestamp: updated.earliestChainTimestamp ?? null,
    remainingSeconds: nextWaiting ? rem : null,
    earliestNextResumeAsiaTaipei: updated.earliestNextResumeAsiaTaipei ?? null,
    waitTimestamps: updated.waitTimestamps ?? {},
    haltReason: finalPhase === 'HALTED_INSPECT_REQUIRED' ? `Unexpected post-send status=${updated.status}` : null,
  };
  await writePublicStatus(opts.statusOut, finalOut);
  return finalOut;
}

function parseAutoArgs(argv: string[]) {
  let stateDir: string | undefined;
  let statusOut: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir') stateDir = argv[++i];
    else if (argv[i] === '--status-out') statusOut = argv[++i];
    else throw new Error(`Unknown flag: ${argv[i]}`);
  }
  assert(stateDir, '--state-dir is required');
  return { stateDir: resolve(stateDir), statusOut: statusOut ? resolve(statusOut) : undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseAutoArgs(process.argv.slice(2));
  evaluateAndMaybeResume(args)
    .then((res) => {
      console.log(
        `[autoresume] phase=${res.phase} l2Done=${res.l2DoneCount} last=${res.lastCompletedStep ?? 'none'} remainingSec=${res.remainingSeconds ?? '-'}`,
      );
    })
    .catch((err) => {
      console.error(`[autoresume] ERROR: ${(err as Error).message}`);
      process.exitCode = 1;
    });
}
