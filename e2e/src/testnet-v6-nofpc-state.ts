/** Planning and durable public projections for the isolated, self-paid rehearsal. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { assertRegistrableLabel, labelFromCanonical } from '@ans/sdk';
import { TxStatus } from '@aztec-labs/aztec.js/tx';
import { PUBLIC_V6_MANIFESTS, REPO, assertPrivateDir, within, type Manifest } from './deploy-v6-plan.js';
import { physicalPath } from './deploy-v6.js';
import { manifestBinding, savePrivateJson } from './testnet-v6-e2e-state.js';
import { V6_PROFILES, assertV6Url } from './v6-network.js';
import { RegistrationFailure } from './testnet-v6-nofpc-errors.js';

const { assertV6ManifestFile } = createRequire(import.meta.url)('../../scripts/deployment-config.mjs');
export const REGISTER_STEPS = ['deploy-user', 'mint', 'commit', 'register', 'set-address'] as const;
export type RegisterStep = typeof REGISTER_STEPS[number];
export type RegisterOptions = {
  manifest: string; stateDir: string; name?: string; nodeUrl: string;
  funderStateDir?: string; initUser: boolean; dryRun: boolean; confirm?: string;
};
export function refuseManifestPath(path: string) {
  assert(!within(REPO, path), 'Rehearsal manifest cannot be inside repository (including deployments)');
}
export function parseRegisterArgs(argv: string[]): RegisterOptions {
  const flags = new Set(['init-user', 'dry-run']);
  const allowed = new Set([...flags, 'manifest', 'state-dir', 'name', 'node-url', 'confirm', 'funder-state-dir']);
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    assert(argv[i].startsWith('--') && allowed.has(key) && !values.has(key), 'Unknown or duplicate registration option');
    if (flags.has(key)) values.set(key, 'true');
    else {
      assert(argv[i + 1] && !argv[i + 1].startsWith('--'), 'Missing registration option value');
      values.set(key, argv[++i]);
    }
  }
  assert(values.get('manifest') && values.get('state-dir'), '--manifest and --state-dir are required');
  const manifest = resolve(values.get('manifest')!), stateDir = resolve(values.get('state-dir')!);
  refuseManifestPath(manifest);
  // The dated deployer-only Fee Juice directory rule does not apply to user state.
  assertPrivateDir(stateDir, 'testnet-v6', undefined, undefined, 'sponsored');
  assert(!within(stateDir, REPO), 'User state must not contain repository');
  const initUser = values.has('init-user'), dryRun = values.has('dry-run'), name = values.get('name');
  assert(!(initUser && (dryRun || values.has('confirm') || values.has('funder-state-dir'))), '--init-user cannot be combined with transaction options');
  if (!initUser) assert(name, '--name is required');
  if (name) assertRegistrableLabel(labelFromCanonical(name));
  if (!initUser && !dryRun) assert(values.get('confirm'), 'Exact --confirm from --dry-run is required');
  const nodeUrl = values.get('node-url') ?? V6_PROFILES['testnet-v6'].nodeUrl;
  assertV6Url('testnet-v6', nodeUrl);
  return { manifest, stateDir, name, nodeUrl, initUser, dryRun, confirm: values.get('confirm'),
    funderStateDir: values.has('funder-state-dir') ? resolve(values.get('funder-state-dir')!) : undefined };
}
export async function registerPaths(c: RegisterOptions): Promise<RegisterOptions> {
  const manifest = await physicalPath(c.manifest), stateDir = await physicalPath(c.stateDir);
  refuseManifestPath(manifest);
  assertPrivateDir(stateDir, 'testnet-v6', undefined, undefined, 'sponsored');
  assert(!within(stateDir, REPO), 'User state must not contain repository');
  const independent = (other: string) => {
    assert(!within(other, stateDir) && !within(stateDir, other), 'User and deployer state directories must be independent');
  };
  independent(dirname(manifest));
  let funderStateDir;
  if (c.funderStateDir) {
    funderStateDir = await physicalPath(c.funderStateDir);
    assertPrivateDir(funderStateDir, 'testnet-v6', undefined, undefined, 'sponsored');
    assert(!within(funderStateDir, REPO), 'Funder state must not contain repository');
    independent(funderStateDir);
  }
  // Refuse a deployment directory even when its manifest is stored elsewhere. No contents are opened.
  for (const name of ['keys.json', 'state.json']) {
    try { await lstat(join(stateDir, name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    throw new Error('User state contains deployer files; choose a separate private directory');
  }
  for (const dir of [stateDir, ...(funderStateDir ? [funderStateDir] : [])]) {
    try {
      const stat = await lstat(dir);
      assert(stat.isDirectory() && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o700,
        'Registration directories must be owned and mode 0700');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dir === funderStateDir) throw e; }
  }
  return { ...c, manifest, stateDir, funderStateDir };
}
export async function loadRehearsalManifest(path: string): Promise<Manifest> {
  path = await physicalPath(resolve(path));
  refuseManifestPath(path);
  const m = assertV6ManifestFile(path, { expectNetwork: 'testnet-v6' }) as Manifest;
  assert(m.feePayment === 'fee-juice' && m.sponsoredFpc === null, 'Rehearsal requires Fee Juice and no FPC');
  assert(m.feeSymbol === 'mAZTEC' && m.feeDecimals === 18, 'Rehearsal requires mAZTEC fee token');
  // Both the current free deployment and the archived paid one are public; a free deployment has no token (zero).
  for (const file of PUBLIC_V6_MANIFESTS) {
    const known = JSON.parse(await readFile(file, 'utf8')) as Manifest;
    for (const field of ['registry', 'registrar', 'resolver', 'feeToken', 'owner'] as const)
      assert(BigInt(known[field]) === 0n || BigInt(m[field]) !== BigInt(known[field]), 'Canonical deployment addresses cannot be used for rehearsal');
  }
  return m;
}
export function registerConfirmation(c: RegisterOptions, m: Manifest) {
  const binding = createHash('sha256').update(JSON.stringify({
    manifest: c.manifest, binding: manifestBinding(m), stateDir: c.stateDir,
    funderStateDir: c.funderStateDir ?? null, nodeUrl: c.nodeUrl, name: c.name, duration: '31536000',
  })).digest('hex');
  return `register:testnet-v6:11155111:679261766:fee-juice:${c.name}:${binding}`;
}
export function assertRegisterConfirmation(c: RegisterOptions, m: Manifest) {
  if (!(c.dryRun || c.initUser || c.confirm === registerConfirmation(c, m)))
    throw new RegistrationFailure('CONFIRM_MISMATCH');
}
export type TransactionRecord = {
  txHash: string; payer: string; status: string; blockNumber: number | null; transactionFee: string | null;
  userFeeJuiceBefore: string; userFeeJuiceAfter?: string;
};
export type RegisterState = {
  schema: 'ans-v6-nofpc-register/1'; binding: string; confirmation: string;
  user: string; name: string; identity: { chainId: string; rollupVersion: string; rollup: string };
  transactions: Record<string, string>; records: Partial<Record<RegisterStep, TransactionRecord>>;
  done: string[]; plan?: string; funding?: { before: string; amount: string };
  feeJuice: { before: string; after?: string }; resolved?: string;
};
/** O_NOFOLLOW and exact permissions also protect private registration plans and user keys. */
export async function readRegisterJson<T>(path: string): Promise<T | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  try {
    const stat = await file.stat();
    assert(stat.isFile() && stat.uid === process.getuid!() && (stat.mode & 0o777) === 0o600, 'Registration file must be owned and mode 0600');
    return JSON.parse(await file.readFile('utf8')) as T;
  } finally { await file.close(); }
}
export function validateRegisterState(s: RegisterState, m: Manifest, c: RegisterOptions, user: string, identity: RegisterState['identity']) {
  assert(s.schema === 'ans-v6-nofpc-register/1' && s.binding === manifestBinding(m) &&
    s.confirmation === registerConfirmation(c, m) && s.name === c.name && s.user === user,
    'Registration checkpoint binding mismatch');
  assert.deepEqual(s.identity, identity, 'Registration checkpoint network mismatch');
  assert(new Set(s.done).size === s.done.length, 'Duplicate completed step');
  for (const [step, hash] of Object.entries(s.transactions)) {
    assert((REGISTER_STEPS as readonly string[]).includes(step) && /^0x[0-9a-f]{64}$/i.test(hash), 'Invalid checkpoint transaction');
    const r = s.records[step as RegisterStep];
    assert(r && r.txHash === hash && r.payer === (step === 'mint' ? m.owner : user), 'Invalid transaction record');
  }
  assert(s.done.every(step => s.transactions[step]), 'Completed step has no transaction hash');
  for (const step of Object.keys(s.transactions)) {
    const required = step === 'mint' || step === 'commit' ? ['deploy-user'] :
      step === 'register' ? ['deploy-user', 'commit'] : step === 'set-address' ? ['deploy-user', 'commit', 'register'] : [];
    assert(required.every(k => s.done.includes(k)), 'Invalid checkpoint step order');
  }
  if (s.transactions.mint && s.transactions.commit) assert(s.done.includes('mint'), 'Commit precedes completed mint');
  if (s.transactions.commit) assert(s.plan, 'Commit hash has no recovery plan');
}
/** Explicit projection: registration plans, keys and bridge claims never enter the report. */
export function registerReport(s: RegisterState) {
  return { schema: 'ans-v6-nofpc-register-report/1', network: 'testnet-v6', feePayment: 'fee-juice',
    realProofs: true, identity: { ...s.identity }, user: s.user, name: s.name,
    feeJuice: { before: s.feeJuice.before, after: s.feeJuice.after ?? null }, resolved: s.resolved ?? null,
    transactions: Object.fromEntries(REGISTER_STEPS.filter(k => s.records[k]).map(k => {
      const r = s.records[k]!;
      return [k, { txHash: r.txHash, payer: r.payer, status: r.status, blockNumber: r.blockNumber,
        transactionFee: r.transactionFee, userFeeJuiceBefore: r.userFeeJuiceBefore,
        userFeeJuiceAfter: r.userFeeJuiceAfter ?? null }];
    })), done: REGISTER_STEPS.filter(k => s.done.includes(k)) };
}
export async function saveRegisterState(dir: string, s: RegisterState) {
  await savePrivateJson(join(dir, 'register-state.json'), s);
  await savePrivateJson(join(dir, 'register-report.json'), registerReport(s));
}
/** The locally computed hash is durable before forwarding. Ambiguous sends never clear it. */
export async function captureRegisterBroadcast(s: RegisterState, step: RegisterStep | undefined, hash: string,
  payer: string, balance: string, identity: () => Promise<unknown>, save: () => Promise<void>, send: () => Promise<void>) {
  assert(step && !s.transactions[step], 'Refusing duplicate or uncheckpointed broadcast');
  await identity();
  s.transactions[step] = hash;
  s.records[step] = { txHash: hash, payer, status: 'broadcast_checkpointed', blockNumber: null,
    transactionFee: null, userFeeJuiceBefore: balance };
  await save();
  await send();
}
export type PublicReceipt = {
  status: TxStatus; blockNumber?: number; transactionFee?: bigint; hasExecutionReverted(): boolean;
};
export function recordRegisterReceipt(s: RegisterState, step: RegisterStep, receipt: PublicReceipt, balance: string) {
  const r = s.records[step];
  assert(r && s.transactions[step] === r.txHash, 'Receipt has no transaction checkpoint');
  const blockNumber = receipt.blockNumber === undefined ? null : Number(receipt.blockNumber);
  // Rechecking an old receipt must not replace its observed post-inclusion balance with today's balance.
  if (blockNumber === null) delete r.userFeeJuiceAfter;
  else if (r.blockNumber !== blockNumber || r.userFeeJuiceAfter === undefined) r.userFeeJuiceAfter = balance;
  r.status = receipt.hasExecutionReverted() ? 'reverted' : receipt.status;
  r.blockNumber = blockNumber;
  r.transactionFee = receipt.transactionFee === undefined ? null : String(receipt.transactionFee);
  s.feeJuice.after = balance;
}
/** Called before any private wallet operation on resume, including for completed steps. */
export async function recheckRegisterTransactions(s: RegisterState,
  receipt: (hash: string) => Promise<PublicReceipt>, record: (step: RegisterStep, r: PublicReceipt) => Promise<void>) {
  for (const step of REGISTER_STEPS) {
    if (!s.transactions[step]) continue;
    const r = await receipt(s.transactions[step]);
    await record(step, r);
    assert(r.status !== TxStatus.DROPPED && !r.hasExecutionReverted(), 'Saved transaction dropped or reverted; checkpoint retained; no resend');
  }
}
