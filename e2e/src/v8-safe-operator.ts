/** Safe preparation only. Mock durability engine; no public signer or execution adapter. */
import assert from 'node:assert/strict';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { V8_RESERVED_HASH, v8WaitCheckpoint } from './v8-rehearsal-plan.js';

export const PUBLIC_PAUSE =
  'PUBLIC_UNCONDITIONALLY_PAUSED: new owner risk disposition, budget approval and reviewed signer boundary required';
export function safeArguments(args: string[]) {
  assert(
    args.every((arg) => arg === '--dry-run'),
    PUBLIC_PAUSE,
  );
  return { mode: 'dry-run', publicExecutionAllowed: false } as const;
}
const READ_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getCode',
  'eth_getBalance',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getLogs',
  'node_getNodeInfo',
  'node_getCurrentMinFees',
  'node_getTxReceipt',
  'node_getContract',
  'node_getContractClass',
]);
/** Injected HTTP client must not contain wallet middleware. No batch or arbitrary RPC escape. */
export function readOnlyRpc(transport: (method: string, params: unknown[]) => Promise<unknown>) {
  return async (method: string, params: unknown[] = []) => {
    assert(READ_METHODS.has(method), 'read-only RPC method refused');
    return transport(method, structuredClone(params));
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  assert(
    value !== undefined && typeof value !== 'bigint' && typeof value !== 'function',
    'invalid binding value',
  );
  return JSON.stringify(value);
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export type Identity = {
  chainId: number;
  rollupVersion: number;
  realProofs: boolean;
  nodeVersion: string;
  classes: string[];
  codeHashes: string[];
};
export type Binding = {
  schema: 'ans-v8-safe-prep/1';
  run: string;
  identity: Identity;
  artifacts: Record<string, string>;
  actors: {
    owner: string;
    treasury: string;
    administrator: string;
    holder: string;
    recipient: string;
  };
  reservations: { count: number; hash: string; batches: number };
  edges: [string, string][];
  configHash: string;
};
const hashPattern = /^[0-9a-f]{64}$/;
export function validateBinding(binding: Binding) {
  assert.equal(binding.schema, 'ans-v8-safe-prep/1');
  assert(/^[a-z0-9-]{1,80}$/.test(binding.run));
  assert.equal(binding.reservations.count, 325);
  assert.equal(binding.reservations.batches, 11);
  assert.equal(binding.reservations.hash, V8_RESERVED_HASH);
  assert.deepEqual(
    Object.keys(binding.actors).sort(),
    ['administrator', 'holder', 'owner', 'recipient', 'treasury'],
    'complete actor roles required',
  );
  for (const actor of Object.values(binding.actors))
    assert(/^0x[0-9a-f]{64}$/.test(actor) && BigInt(actor) !== 0n, 'nonzero bound actor required');
  assert(
    Object.keys(binding.artifacts).length > 0 &&
      Object.values(binding.artifacts).every((h) => hashPattern.test(h)),
    'exact artifact hashes required',
  );
  assert(hashPattern.test(binding.configHash));
  const [a, b] = binding.edges;
  assert.equal(binding.edges.length, 2);
  assert.deepEqual(
    binding.edges,
    [
      [metadata.v8.classId, metadata.v8Rehearsal.classId],
      [metadata.v8Rehearsal.classId, metadata.v8.classId],
    ],
    'only the two frozen reviewed V8 edges',
  );
  assert(
    a && b && a[0] !== a[1] && a[0] === b[1] && a[1] === b[0],
    'exact directed forward/rollback edges required',
  );
  assert(binding.identity.classes.includes(a[0]) && binding.identity.classes.includes(a[1]));
  assert(
    binding.identity.codeHashes.length > 0 &&
      binding.identity.codeHashes.every((h) => hashPattern.test(h)),
    'exact contract code required; no fallback',
  );
}
export function verifyIdentity(expected: Identity, actual: Identity) {
  assert.equal(
    canonical(actual),
    canonical(expected),
    'chain/rollup/realProofs/class/contract code identity mismatch; no fallback',
  );
}
export type Budget = {
  complete: boolean;
  measured: bigint;
  ceiling: bigint;
  step: bigint;
  actorAvailable: bigint;
  sampledAt: number;
  l2Price: bigint;
  approvedL2Price: bigint;
  daPrice: bigint;
  activationAt?: number;
};
export function checkStepBudget(b: Budget, now: number) {
  assert(b.complete, 'budget incomplete');
  for (const n of [
    b.measured,
    b.ceiling,
    b.step,
    b.actorAvailable,
    b.l2Price,
    b.approvedL2Price,
    b.daPrice,
  ])
    assert(n >= 0n, 'negative budget');
  assert(
    Number.isSafeInteger(now) &&
      Number.isSafeInteger(b.sampledAt) &&
      now >= b.sampledAt &&
      now - b.sampledAt <= 60,
    're-sample before every step and after each wait',
  );
  assert(
    b.daPrice === 0n,
    'DA changed from zero: STOP; nonzero DA requires new approved absolute ceiling',
  );
  assert(b.l2Price <= b.approvedL2Price, 'price movement exceeds approved ceiling');
  assert(
    b.measured + b.step <= b.ceiling && b.step <= b.actorAvailable,
    'budget overrun or actor deficit',
  );
  if (b.activationAt !== undefined)
    assert(b.activationAt - now > 900, 'activation margin exhausted');
}
export function fullDelay(
  stage: Parameters<typeof v8WaitCheckpoint>[0],
  startedAt: bigint,
  now: bigint,
  recordedReadyAt: bigint,
) {
  assert(startedAt >= 0n && recordedReadyAt === startedAt + 86400n, 'full 86400 delay required');
  return v8WaitCheckpoint(stage, now, recordedReadyAt);
}
export function bridgeReadiness(input: {
  attempts: number;
  maximum: number;
  expectedMessage: string;
  observedMessage: string;
  proven: boolean;
}) {
  assert(
    Number.isSafeInteger(input.maximum) &&
      input.maximum > 0 &&
      input.maximum <= 20 &&
      Number.isSafeInteger(input.attempts) &&
      input.attempts >= 0 &&
      input.attempts < input.maximum,
    'bounded bridge wait exhausted',
  );
  assert(
    hashPattern.test(input.expectedMessage) && input.expectedMessage === input.observedMessage,
    'bridge message mismatch',
  );
  return input.proven ? 'ready-for-fresh-readback' : 'waiting-exit-no-deposit-resend';
}

type Phase = 'intent' | 'hashed' | 'broadcasting' | 'tracking' | 'confirmed' | 'halted';
export type Checkpoint = {
  sequence: number;
  binding: string;
  previous: string | null;
  step: string;
  phase: Phase;
  hash?: string;
  outcome?: string;
};
function validateTransition(entries: Checkpoint[], entry: Checkpoint) {
  const prior = entries.at(-1);
  const seen = entries.filter((row) => row.step === entry.step);
  if (entry.phase === 'intent') {
    assert(
      !seen.length && (!prior || prior.phase === 'confirmed'),
      'invalid step start or repeated completed step',
    );
    assert(entry.hash === undefined);
    return;
  }
  assert(prior && prior.step === entry.step, 'step transition mismatch');
  const allowed: Record<Phase, Phase[]> = {
    intent: ['hashed', 'halted'],
    hashed: ['broadcasting', 'tracking', 'confirmed'],
    broadcasting: ['tracking', 'confirmed'],
    tracking: ['tracking', 'confirmed'],
    confirmed: ['halted'],
    halted: [],
  };
  assert(allowed[prior.phase].includes(entry.phase), 'invalid checkpoint FSM transition');
  if (prior.hash) assert.equal(entry.hash, prior.hash, 'saved hash immutable');
  if (entry.phase !== 'halted')
    assert(entry.hash && hashPattern.test(entry.hash), 'mock hash required');
}
/** Private existing directory only. Immutable journal entries, exclusive lock, fsync file and directory. */
export class MockJournal {
  private constructor(
    private directory: string,
    private binding: Binding,
    private lock: Awaited<ReturnType<typeof open>>,
    private entries: Checkpoint[],
  ) {}
  private poisoned = false;
  seen(step: string) {
    return this.entries.some((entry) => entry.step === step);
  }
  trackAttempts(step: string) {
    return this.entries.filter((entry) => entry.step === step && entry.phase === 'tracking').length;
  }
  static async acquire(directory: string, binding: Binding) {
    validateBinding(binding);
    assert(isAbsolute(directory), 'absolute private directory required');
    const normalized = resolve(directory);
    assert.equal(directory, normalized, 'canonical directory required');
    let cursor = parse(normalized).root;
    for (const component of relative(cursor, normalized).split('/')) {
      cursor = join(cursor, component);
      const stat = await lstat(cursor);
      assert(!stat.isSymbolicLink() && stat.isDirectory(), 'symlink/directory refused');
    }
    assert.equal(await realpath(directory), directory);
    const stat = await lstat(directory);
    assert.equal(stat.uid, process.getuid?.());
    assert.equal(stat.mode & 0o777, 0o700, 'private directory mode0700 required');
    const lockPath = join(directory, 'operator.lock');
    const lock = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await lock.writeFile('mock-only\n');
      await lock.sync();
      const bindingPath = join(directory, 'binding.json');
      let bindingFile;
      try {
        bindingFile = await open(
          bindingPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (bindingFile) {
        try {
          await bindingFile.writeFile(canonical(binding) + '\n');
          await bindingFile.sync();
        } finally {
          await bindingFile.close();
        }
        const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
      const savedBinding = await open(bindingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = await savedBinding.stat();
        assert(
          s.isFile() && s.nlink === 1 && s.uid === stat.uid && (s.mode & 0o777) === 0o600,
          'unsafe binding file',
        );
        assert.equal(
          canonical(JSON.parse(await savedBinding.readFile('utf8'))),
          canonical(binding),
          'immutable run binding drift',
        );
      } finally {
        await savedBinding.close();
      }
      const names = (await readdir(directory))
        .filter((n) => !['operator.lock', 'binding.json'].includes(n))
        .sort();
      const entries: Checkpoint[] = [];
      for (const [index, name] of names.entries()) {
        assert.equal(
          name,
          `${String(index).padStart(6, '0')}.json`,
          'unexpected journal file or gap',
        );
        const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const s = await file.stat();
          assert(
            s.isFile() && s.nlink === 1 && s.uid === stat.uid && (s.mode & 0o777) === 0o600,
            'unsafe checkpoint permissions/link',
          );
          const entry: Checkpoint = JSON.parse(await file.readFile('utf8'));
          assert.equal(entry.sequence, index);
          assert.equal(entry.binding, digest(binding), 'immutable run binding drift');
          assert.equal(
            entry.previous,
            index ? digest(entries[index - 1]) : null,
            'journal history drift',
          );
          assert(
            ['intent', 'hashed', 'broadcasting', 'tracking', 'confirmed', 'halted'].includes(
              entry.phase,
            ),
          );
          assert(typeof entry.step === 'string' && entry.step.length > 0);
          if (entry.hash !== undefined) assert(hashPattern.test(entry.hash), 'invalid mock hash');
          if (['hashed', 'broadcasting', 'tracking', 'confirmed'].includes(entry.phase))
            assert(entry.hash, 'saved hash required');
          const previous = entries.at(-1);
          if (previous?.step === entry.step && previous.hash)
            assert.equal(entry.hash, previous.hash, 'saved hash immutable');
          validateTransition(entries, entry);
          entries.push(entry);
        } finally {
          await file.close();
        }
      }
      return new MockJournal(directory, structuredClone(binding), lock, entries);
    } catch (error) {
      await lock.close();
      await unlink(lockPath);
      throw error;
    }
  }
  latest() {
    return structuredClone(this.entries.at(-1));
  }
  async append(step: string, phase: Phase, hash?: string, outcome?: string) {
    assert(!this.poisoned, 'journal fsync failure: close and inspect, no broadcast');
    this.poisoned = true;
    const entry: Checkpoint = {
      sequence: this.entries.length,
      binding: digest(this.binding),
      previous: this.entries.length ? digest(this.entries.at(-1)) : null,
      step,
      phase,
      ...(hash ? { hash } : {}),
      ...(outcome ? { outcome } : {}),
    };
    validateTransition(this.entries, entry);
    const file = await open(
      join(this.directory, `${String(entry.sequence).padStart(6, '0')}.json`),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(canonical(entry) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    this.entries.push(entry);
    this.poisoned = false;
    return entry;
  }
  async close() {
    await this.lock.close();
    await unlink(join(this.directory, 'operator.lock'));
  }
}
export type MockAdapter = {
  kind: 'pure-local-mock';
  endpoint: string;
  chainId: 31337;
  prove(): Promise<Uint8Array>;
  broadcast(bytes: Uint8Array, hash: string): Promise<void>;
  receipt(
    hash: string,
  ): Promise<'pending' | 'unknown' | 'reverted' | 'dropped' | 'reorg' | 'success'>;
  readback(): Promise<void>;
};
/** Toy SHA256 mock hash, NOT Aztec transaction construction or a live-ready signer boundary. */
export async function mockStep(
  journal: MockJournal,
  step: string,
  adapter: MockAdapter,
  guard: () => Promise<void>,
) {
  assert.equal(adapter.kind, 'pure-local-mock');
  assert.equal(adapter.chainId, 31337);
  const url = new URL(adapter.endpoint);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  assert(!url.username && !url.password);
  await guard();
  const last = journal.latest();
  if (last && last.step === step) {
    if (!last.hash || last.phase === 'halted') return 'STOP';
    if (last.phase === 'confirmed') {
      try {
        await adapter.readback();
      } catch {
        await journal.append(step, 'halted', last.hash, 'confirmed-readback-drift');
        return 'STOP';
      }
      return 'confirmed';
    }
    assert(journal.trackAttempts(step) < 20, 'finite receipt tracking exhausted; STOP');
    // Any saved hash is TRACK ONLY, including a crash before broadcast; never reconstruct or resend.
    let outcome: string;
    try {
      outcome = await adapter.receipt(last.hash);
    } catch {
      outcome = 'unknown';
    }
    if (outcome === 'success') {
      try {
        await adapter.readback();
      } catch {
        await journal.append(step, 'tracking', last.hash, 'readback-failed');
        return 'STOP';
      }
      await journal.append(step, 'confirmed', last.hash, outcome);
      return 'confirmed';
    }
    await journal.append(step, 'tracking', last.hash, outcome);
    return 'STOP';
  }
  assert(!journal.seen(step), 'completed step cannot be repeated');
  assert(!last || last.phase === 'confirmed', 'previous step unresolved');
  await journal.append(step, 'intent');
  let bytes: Uint8Array;
  try {
    bytes = await adapter.prove();
  } catch {
    await journal.append(step, 'halted', undefined, 'proof-failed');
    return 'STOP';
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  await journal.append(step, 'hashed', hash); // Both fsyncs complete before even entering broadcast boundary.
  await guard();
  await journal.append(step, 'broadcasting', hash);
  try {
    await adapter.broadcast(bytes, hash);
  } catch {
    await journal.append(step, 'tracking', hash, 'broadcast-ambiguous');
    return 'STOP';
  }
  await journal.append(step, 'tracking', hash);
  return 'TRACK_ONLY';
}
