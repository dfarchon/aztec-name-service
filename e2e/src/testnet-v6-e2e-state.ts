/** Private checkpoints and public projections for the standalone V6 acceptance runner. */
import assert from 'node:assert/strict';
import { TxStatus } from '@aztec-labs/aztec.js/tx';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Manifest } from './deploy-v6-plan.js';
import { assertV6Network, V6_PROFILES, type V6NodeInfo } from './v6-network.js';
import { runCheckpointedStep } from './testnet-checkpoint.js';

const { assertV6ManifestFile } = createRequire(import.meta.url)(
  '../../scripts/deployment-config.mjs',
);
export const STEPS = [
  'mint',
  'long-commit',
  'long-register',
  'set-address',
  'renew',
  'short-commit',
  'short-register',
  'offer-transfer',
  'accept-transfer',
] as const;
export type Step = (typeof STEPS)[number];
export const TX_OPTIONS = { timeoutMs: 30 * 60_000, pollMs: 5000, waitFor: 'confirmed' as const };
export const COMMIT_OPTIONS = { timeoutMs: 30 * 60_000, pollMs: 5000 };
export type AccountKeys = { address: string; secret: string; salt: string; signingKey: string };
export type Before = {
  user: string;
  treasury: string;
  expiry?: string;
  generation?: number;
  revision?: number;
};
export function stableBaseline({ treasury: _treasury, ...stable }: Before) {
  return stable;
}
export function assertStableBaseline(saved: Before, fresh: Before) {
  assert.deepEqual(stableBaseline(saved), stableBaseline(fresh),
    'Chain state changed before an unbroadcast step; inspect checkpoint');
}
export function assertPayment(before: Before, after: Before, amount: bigint) {
  assert(BigInt(before.user) - BigInt(after.user) === amount, 'Exact user debit mismatch');
  const delta = BigInt(after.treasury) - BigInt(before.treasury);
  assert(delta >= amount, `Treasury credit delta ${delta} below payment ${amount}`);
}
export type E2EState = {
  schema: 'ans-testnet-v6-e2e/1';
  binding: string;
  names: { long: string; short: string };
  accounts: { user: AccountKeys; recipient: AccountKeys };
  plans: Partial<Record<'long' | 'short', string>>;
  before: Partial<Record<Step, Before>>;
  transactions: Record<string, string>;
  done: string[];
};
export function parseRebroadcast(args: string[]): Step | undefined {
  if (!args.length) return;
  assert(args.length === 2 && args[0] === '--rebroadcast' &&
    (STEPS as readonly string[]).includes(args[1]),
    'Usage: testnet-v6-e2e [--rebroadcast <step>]');
  return args[1] as Step;
}
export function assertRebroadcastStep(state: E2EState, step: string): asserts step is Step {
  assert((STEPS as readonly string[]).includes(step), 'Unknown rebroadcast step');
  assert(state.transactions[step] && !state.done.includes(step), 'Rebroadcast requires a pending saved hash');
  assert(STEPS.filter((k) => state.transactions[k]).at(-1) === step,
    'Rebroadcast requires the last broadcast step');
}
/** Same explicit DROPPED + absent effect rule as deploy-v6; no automatic hash removal. */
export function prepareRebroadcast(
  state: E2EState, step: string,
  evidence: { receiptStatus: TxStatus; effectAbsent: boolean },
): E2EState {
  assertRebroadcastStep(state, step);
  assert(evidence.receiptStatus === TxStatus.DROPPED, 'Rebroadcast requires a DROPPED receipt');
  assert(evidence.effectAbsent, 'Rebroadcast forbidden: chain effect exists');
  const transactions = { ...state.transactions };
  delete transactions[step];
  return { ...state, transactions };
}
export function loadManifest(path: string): Manifest {
  const m = assertV6ManifestFile(path, {
    expectNetwork: 'testnet-v6',
    canonical: true,
  }) as Manifest;
  assert(
    m.registrarKind === 'tiered' && m.feeSymbol === 'mAZTEC' && m.feeDecimals === 18,
    'Tiered mAZTEC deployment required',
  );
  assert(
    BigInt(m.lengthPrices!['4']) === 32n * 10n ** 18n,
    'Four-character price must be 32 mAZTEC',
  );
  return m;
}
export function manifestBinding(manifest: Manifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
/** Used before loading any private file, and again at every broadcast boundary. */
export async function preflightIdentity(getInfo: () => Promise<V6NodeInfo>) {
  return assertV6Network('testnet-v6', await getInfo(), V6_PROFILES['testnet-v6'].nodeUrl);
}
export function testNames(
  now = Date.now(),
  suffix = randomBytes(4).toString('hex'),
  short = randomInt(36 ** 3),
) {
  assert(/^[a-z0-9]{8}$/.test(suffix), 'Invalid name randomness');
  return {
    long: `ans-e2e-${Math.floor(now / 86400000).toString(36)}-${suffix}`,
    short: `a${short.toString(36).padStart(3, '0')}`,
  };
}
export function validateState(s: E2EState, manifest: Manifest) {
  assert(
    s.schema === 'ans-testnet-v6-e2e/1' && s.binding === manifestBinding(manifest),
    'Checkpoint deployment mismatch',
  );
  assert(
    /^ans-e2e-[a-z0-9]+-[a-z0-9]{8}$/.test(s.names.long) &&
      s.names.long.length <= 31 &&
      /^a[a-z0-9]{3}$/.test(s.names.short),
    'Checkpoint names invalid',
  );
  assert(
    s.accounts.user.address !== s.accounts.recipient.address,
    'Checkpoint accounts must differ',
  );
  assert(
    Object.keys(s.transactions).every(
      (k) =>
        (STEPS as readonly string[]).includes(k) && /^0x[0-9a-f]{64}$/i.test(s.transactions[k]),
    ),
    'Checkpoint hashes invalid',
  );
  assert(new Set(s.done).size === s.done.length, 'Checkpoint completed steps must be unique');
  assert(
    s.done.every((k) => (STEPS as readonly string[]).includes(k) && s.transactions[k]),
    'Checkpoint completed step has no hash',
  );
  const firstPending = STEPS.findIndex((k) => !s.done.includes(k));
  assert(
    firstPending < 0 ||
      STEPS.slice(firstPending + 1).every((k) => !s.done.includes(k) && !s.transactions[k]),
    'Checkpoint step order invalid',
  );
}
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  assert(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid!() &&
      (s.mode & 0o777) === 0o700,
    'E2E directory must be owned and 0700',
  );
}
export async function readPrivateState(path: string): Promise<E2EState | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot open private e2e checkpoint');
  }
  try {
    const s = await file.stat();
    assert(
      s.isFile() && s.uid === process.getuid!() && (s.mode & 0o777) === 0o600,
      'E2E checkpoint must be owned and 0600',
    );
    return JSON.parse(await file.readFile('utf8')) as E2EState;
  } finally {
    await file.close();
  }
}
/** Exclusive temporary file, fsync before atomic rename; never follows an existing temporary symlink. */
export async function savePrivateJson(path: string, value: unknown) {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(tmp, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
/** No send retry: a persisted hash always wins, including an RPC error after submission. */
export async function checkpointStep(
  state: E2EState,
  name: Step,
  preSend: () => Promise<void>,
  send: () => Promise<unknown>,
  track: (hash: string) => Promise<unknown>,
  verify: () => Promise<void>,
  save: () => Promise<void>,
) {
  return runCheckpointedStep(
    state,
    name,
    async () => {
      await preSend();
      await send();
    },
    async (hash) => {
      try { return await track(hash); }
      catch (error) {
        if ((error as { code?: string }).code === 'dropped')
          throw new Error(`Step ${name} dropped; inspect chain state, then explicitly use --rebroadcast ${name}`, { cause: error });
        throw error;
      }
    },
    verify,
    save,
  );
}
/** Save before calling sendTx, so a lost RPC response or process interruption cannot cause a second send. */
export async function captureBroadcast(
  state: E2EState,
  step: Step | undefined,
  hash: string,
  identity: () => Promise<unknown>,
  save: () => Promise<void>,
  send: () => Promise<void>,
) {
  assert(step && !state.transactions[step], 'Refusing duplicate or uncheckpointed broadcast');
  await identity();
  state.transactions[step] = hash;
  await save();
  await send();
}
/** Whitelist fields; never pass state, plans, key-loader errors or wallet errors to a logger. */
export function publicReport(state: E2EState) {
  return {
    network: 'testnet-v6',
    names: { long: state.names.long, short: state.names.short },
    transactions: Object.fromEntries(
      STEPS.filter((k) => state.transactions[k]).map((k) => [k, state.transactions[k]]),
    ),
    passed: state.done.filter((k) => (STEPS as readonly string[]).includes(k)).length,
    plannedTransactions: STEPS.length,
  };
}
export function safeFailure() {
  return 'V6 public e2e stopped; private checkpoint retained. Resume with the same state directory; no automatic rebroadcast. For a dropped step, inspect chain state and explicitly use --rebroadcast <step>.';
}
