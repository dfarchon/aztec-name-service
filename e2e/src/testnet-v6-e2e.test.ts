/** Offline only: no node clients, deployment key files or public transactions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, chmod, stat, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TxStatus } from '@aztec-labs/aztec.js/tx';
import { loadE2EKeys, runSafely } from './testnet-v6-e2e.js';
import { initKeys } from './init-keys.js';
import { V6_PROFILES, type V6NodeInfo } from './v6-network.js';
import { REPO } from './deploy-v6-plan.js';
import {
  assertPayment,
  assertStableBaseline,
  prepareRebroadcast,
  parseRebroadcast,
  COMMIT_OPTIONS,
  TX_OPTIONS,
  STEPS,
  captureBroadcast,
  checkpointStep,
  loadManifest,
  manifestBinding,
  preflightIdentity,
  privateDirectory,
  publicReport,
  readPrivateState,
  savePrivateJson,
  testNames,
  validateState,
  type E2EState,
} from './testnet-v6-e2e-state.js';
const manifest = loadManifest(join(REPO, 'deployments/testnet-v6.json'));
const profile = V6_PROFILES['testnet-v6'];
const info = (): V6NodeInfo => ({
  nodeVersion: profile.nodeVersion,
  l1ChainId: Number(profile.chainId),
  rollupVersion: Number(profile.rollupVersion),
  realProofs: true,
  l1ContractAddresses: { rollupAddress: { toString: () => profile.rollup } },
});
const hash = `0x${'1'.repeat(64)}`;
const fake = (id: string) => ({
  address: id,
  secret: 'SENTINEL-SECRET',
  salt: 'SENTINEL-SALT',
  signingKey: 'SENTINEL-SIGNING',
});
const fresh = (): E2EState => ({
  schema: 'ans-testnet-v6-e2e/1',
  binding: manifestBinding(manifest),
  names: testNames(),
  accounts: { user: fake('user'), recipient: fake('recipient') },
  plans: { long: 'SENTINEL-PLAN' },
  before: {},
  transactions: {},
  done: [],
});
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'ans-v6-e2e-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  return dir;
}

test('public runner rejects local, wrong identity, sample and noncanonical manifest before private reads', async (t) => {
  const dir = await fixture(t),
    path = join(dir, 'manifest.json');
  for (const changed of [
    { network: 'local' },
    { chainId: '31337' },
    { rollupVersion: '1' },
    { realProofs: false },
    { sample: true },
    { nodeUrl: 'http://localhost:8080' },
    { registrarKind: 'flat', lengthPrices: null },
  ]) {
    await writeFile(path, JSON.stringify({ ...manifest, ...changed }));
    assert.throws(() => loadManifest(path));
  }
  assert.equal(loadManifest(join(REPO, 'deployments/testnet-v6.json')).network, 'testnet-v6');
});

test('each node identity field fails before key loader or broadcast boundary', async () => {
  for (const changed of [
    { nodeVersion: '5.2.1' },
    { l1ChainId: 31337 },
    { rollupVersion: 1 },
    { realProofs: false },
    { l1ContractAddresses: { rollupAddress: { toString: () => 'wrong' } } },
  ]) {
    const badInfo = async () => ({ ...info(), ...changed });
    let loads = 0,
      sends = 0,
      saves = 0;
    await assert.rejects(
      loadE2EKeys(badInfo, '/never/read/keys.json', manifest, async () => {
        loads++;
        throw new Error('must not read');
      }),
      /identity mismatch/,
    );
    const s = fresh();
    await assert.rejects(
      captureBroadcast(
        s,
        'mint',
        hash,
        () => preflightIdentity(badInfo),
        async () => {
          saves++;
        },
        async () => {
          sends++;
        },
      ),
      /identity mismatch/,
    );
    assert.deepEqual([loads, sends, saves, Object.keys(s.transactions).length], [0, 0, 0, 0]);
  }
});

test('existing private key mechanism restores temporary testnet keys and refuses owner/treasury mismatch', async (t) => {
  const dir = await fixture(t),
    output: string[] = [];
  t.mock.method(console, 'log', (...v: unknown[]) => output.push(v.join(' ')));
  const pub = await initKeys({ network: 'testnet-v6', stateDir: dir, assertPath: () => {} });
  const m = { ...manifest, owner: pub.owner, treasury: pub.treasury };
  const k = await loadE2EKeys(async () => info(), join(dir, 'keys.json'), m);
  assert.equal(k.network, 'testnet-v6');
  await assert.rejects(
    loadE2EKeys(async () => info(), join(dir, 'keys.json'), { ...m, owner: manifest.owner }),
    /Owner keys/,
  );
  await assert.rejects(
    loadE2EKeys(async () => info(), join(dir, 'keys.json'), { ...m, treasury: manifest.treasury }),
    /Treasury keys/,
  );
  for (const a of [k.owner, k.treasury])
    for (const v of [a.secret, a.salt, a.signingKey]) assert(!output.join('\n').includes(v));
});

test('lost send response saves hash first and resumes with chain receipt, never a second broadcast', async () => {
  const s = fresh(),
    calls: string[] = [];
  const save = async () => {
    calls.push('save');
  };
  const send = () =>
    captureBroadcast(
      s,
      'mint',
      hash,
      async () => {
        calls.push('identity');
      },
      save,
      async () => {
        calls.push('broadcast');
        throw new Error('RPC response lost');
      },
    );
  await assert.rejects(
    checkpointStep(
      s,
      'mint',
      async () => {
        calls.push('chain-before');
      },
      send,
      async () => {
        throw new Error('not reached');
      },
      async () => {},
      save,
    ),
  );
  assert.deepEqual(calls, ['chain-before', 'identity', 'save', 'broadcast']);
  let sends = 1,
    verified = 0;
  const unexpected = async () => {
    sends++;
    throw new Error('duplicate');
  };
  await checkpointStep(
    s,
    'mint',
    unexpected,
    unexpected,
    async (h) => {
      assert.equal(h, hash);
      calls.push('receipt');
    },
    async () => {
      verified++;
    },
    save,
  );
  assert.equal(sends, 1);
  assert.equal(verified, 1);
  assert.deepEqual(s.done, ['mint']);
  await checkpointStep(
    s,
    'mint',
    unexpected,
    unexpected,
    async (h) => {
      assert.equal(h, hash);
    },
    unexpected,
    unexpected,
  );
  assert.equal(sends, 1);
  assert.equal(verified, 1);
});

test('dropped/pending receipts and read errors retain hashes without retrying send', async () => {
  const s = fresh();
  s.transactions.mint = hash;
  for (const error of ['dropped', 'timeout', 'RPC temporarily unavailable']) {
    await assert.rejects(
      checkpointStep(
        s,
        'mint',
        async () => {
          throw new Error('no pre-send');
        },
        async () => {
          throw new Error('no broadcast');
        },
        async () => {
          throw new Error(error);
        },
        async () => {},
        async () => {},
      ),
      new RegExp(error),
    );
    assert.equal(s.transactions.mint, hash);
    assert.deepEqual(s.done, []);
  }
});

test('saving failure and duplicate checkpoint block the broadcasting boundary', async () => {
  const s = fresh();
  let sent = 0;
  await assert.rejects(
    captureBroadcast(
      s,
      'mint',
      hash,
      async () => {},
      async () => {
        throw new Error('disk full');
      },
      async () => {
        sent++;
      },
    ),
    /disk full/,
  );
  await assert.rejects(
    captureBroadcast(
      s,
      'mint',
      hash,
      async () => {},
      async () => {},
      async () => {
        sent++;
      },
    ),
    /duplicate/,
  );
  assert.equal(sent, 0);
});

test('names have requested prefix, base36 date and randomness; short labels are exactly four valid characters', () => {
  const n = testNames(Date.UTC(2026, 9, 28), 'abcd1234', 35);
  assert.equal(
    n.long,
    `ans-e2e-${Math.floor(Date.UTC(2026, 9, 28) / 86400000).toString(36)}-abcd1234`,
  );
  assert.equal(n.short, 'a00z');
  assert(n.long.length >= 5 && n.long.length <= 31);
  const names = Array.from({ length: 100 }, () => testNames());
  assert.equal(new Set(names.map((n) => n.long)).size, 100);
  assert(
    names.every(
      (n) => /^ans-e2e-[a-z0-9]+-[a-z0-9]{8}$/.test(n.long) && /^a[a-z0-9]{3}$/.test(n.short),
    ),
  );
  assert.equal(STEPS.length, 9);
  assert(STEPS.length <= 15);
  assert(TX_OPTIONS.timeoutMs >= 15 * 60_000 && COMMIT_OPTIONS.timeoutMs >= 30 * 60_000);
});

test('private checkpoint modes are 0700/0600 even under umask zero and symlinks/public files are rejected', async (t) => {
  const dir = await fixture(t),
    path = join(dir, 'state.json'),
    mask = process.umask(0);
  try {
    await privateDirectory(join(dir, 'private'));
    assert.equal((await stat(join(dir, 'private'))).mode & 0o777, 0o700);
    await savePrivateJson(path, fresh());
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readPrivateState(path))!.schema, 'ans-testnet-v6-e2e/1');
    await symlink(path, join(dir, 'link'));
    await assert.rejects(readPrivateState(join(dir, 'link')));
    await chmod(path, 0o644);
    await assert.rejects(readPrivateState(path), /0600/);
    await chmod(join(dir, 'private'), 0o755);
    await assert.rejects(privateDirectory(join(dir, 'private')), /0700/);
  } finally {
    process.umask(mask);
  }
});

test('checkpoint binds deployment and step order; missing hashes fail closed', () => {
  validateState(fresh(), manifest);
  const s = fresh();
  s.binding = 'wrong';
  assert.throws(() => validateState(s, manifest), /deployment mismatch/);
  s.binding = manifestBinding(manifest);
  s.done = ['mint'];
  assert.throws(() => validateState(s, manifest), /no hash/);
  s.done = ['long-register'];
  s.transactions['long-register'] = hash;
  assert.throws(() => validateState(s, manifest), /step order/);
});

test('public report and CLI error output exclude private values, plans and arbitrary error details', async (t) => {
  const s = fresh();
  s.transactions.mint = hash;
  s.done = ['mint'];
  const output: string[] = [];
  t.mock.method(console, 'error', (...v: unknown[]) => output.push(v.join(' ')));
  output.push(JSON.stringify(publicReport(s)));
  assert.equal(
    await runSafely(async () => {
      throw new Error(JSON.stringify(s));
    }),
    false,
  );
  for (const sentinel of ['SENTINEL-SECRET', 'SENTINEL-SALT', 'SENTINEL-SIGNING', 'SENTINEL-PLAN'])
    assert(!output.join('\n').includes(sentinel));
  assert.deepEqual(Object.keys(publicReport(s)), [
    'network',
    'names',
    'transactions',
    'passed',
    'plannedTransactions',
  ]);
  assert.equal(publicReport(s).passed, 1);
});

test('all nine steps can resume after capture; completed behavioral assertions are not repeated after later changes', async () => {
  const s = fresh(),
    sent = new Map<string, number>();
  let verified = 0;
  const save = async () => {};
  const replay = async (interrupt?: string) => {
    for (const name of STEPS) {
      const h = `0x${(STEPS.indexOf(name) + 1).toString(16).padStart(64, '0')}`;
      await checkpointStep(
        s,
        name,
        async () => {
          assert(!s.transactions[name]); // queried chain and checked checkpoint before preparing a send
        },
        async () => {
          await captureBroadcast(
            s,
            name,
            h,
            async () => {},
            save,
            async () => {
              sent.set(name, (sent.get(name) ?? 0) + 1);
              if (interrupt === name) throw new Error('interrupted after send');
            },
          );
        },
        async (hash) => {
          assert.equal(hash, h);
        },
        async () => {
          verified++;
        },
        save,
      );
    }
  };
  for (const name of STEPS) await assert.rejects(replay(name), /interrupted after send/);
  await replay();
  assert.equal(verified, STEPS.length);
  assert.deepEqual(
    [...sent.values()],
    STEPS.map(() => 1),
  );
  await replay();
  assert.equal(verified, STEPS.length);
  assert.equal(publicReport(s).passed, 9);
});

const beforePayment = { user: '100', treasury: '1000', expiry: '12', generation: 1, revision: 2 };
test('payment check accepts a treasury delta above the payment (third-party traffic)', () => {
  assertPayment(beforePayment, { user: '90', treasury: '1017' }, 10n);
});
test('payment check rejects a treasury delta below the payment', () => {
  assert.throws(() => assertPayment(beforePayment, { user: '90', treasury: '1009' }, 10n), /delta 9 below payment 10/);
});
test('payment check still requires the exact payer balance change', () => {
  assert.throws(() => assertPayment(beforePayment, { user: '89', treasury: '1017' }, 10n), /Exact user debit/);
});
test('resume baseline ignores treasury drift but rejects user or name record drift', () => {
  assertStableBaseline(beforePayment, { ...beforePayment, treasury: '9000' });
  for (const changed of [{ user: '99' }, { expiry: '13' }, { generation: 2 }, { revision: 3 }])
    assert.throws(() => assertStableBaseline(beforePayment, { ...beforePayment, ...changed }), /Chain state changed/);
});
const pending = () => {
  const s = fresh();
  s.transactions.mint = hash;
  s.done = ['mint'];
  s.transactions['long-commit'] = `0x${'2'.repeat(64)}`;
  s.before['long-commit'] = { ...beforePayment };
  return s;
};
const absent = { receiptStatus: TxStatus.DROPPED, effectAbsent: true };
test('rebroadcast refuses an unknown step or a step without a saved hash', () => {
  const s = pending(), original = structuredClone(s);
  for (const step of ['unknown', 'renew']) assert.throws(() => prepareRebroadcast(s, step, absent));
  assert.deepEqual(s, original);
});
test('rebroadcast refuses a step that is not the last broadcast step', () => {
  const s = pending();
  s.done = [];
  assert.throws(() => prepareRebroadcast(s, 'mint', absent), /last broadcast step/);
});
test('rebroadcast refuses unless the receipt is DROPPED', () => {
  const s = pending(), original = structuredClone(s);
  for (const receiptStatus of [TxStatus.PENDING, TxStatus.PROPOSED, TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED])
    assert.throws(() => prepareRebroadcast(s, 'long-commit', { receiptStatus, effectAbsent: true }), /DROPPED/);
  assert.deepEqual(s, original);
});
test("rebroadcast refuses when the step's on-chain effect is present", () => {
  const s = pending(), original = structuredClone(s);
  assert.throws(() => prepareRebroadcast(s, 'long-commit', { ...absent, effectAbsent: false }), /chain effect exists/);
  assert.deepEqual(s, original);
});
test('rebroadcast clears only the named step hash when dropped and absent', () => {
  const s = pending(), original = structuredClone(s);
  const next = prepareRebroadcast(s, 'long-commit', absent);
  assert.deepEqual(s, original);
  assert.deepEqual(next.transactions, { mint: hash });
  assert.deepEqual(next.before, s.before);
  assert.deepEqual(next.done, s.done);
  assert.deepEqual(next.plans, s.plans);
  validateState(next, manifest);
  assert.throws(() => prepareRebroadcast(s, 'mint', absent), /pending saved hash/);
});
test('a dropped hash without --rebroadcast is never resent', async () => {
  const s = pending();
  let sends = 0;
  await assert.rejects(checkpointStep(s, 'long-commit', async () => {}, async () => { sends++; },
    async () => { throw Object.assign(new Error('dropped'), { code: 'dropped' }); },
    async () => {}, async () => {}), /--rebroadcast long-commit/);
  assert.equal(sends, 0);
  assert.ok(s.transactions['long-commit']);
});
test('rebroadcast CLI requires one known explicit step', () => {
  assert.equal(parseRebroadcast([]), undefined);
  for (const step of STEPS) assert.equal(parseRebroadcast(['--rebroadcast', step]), step);
  for (const args of [['--rebroadcast'], ['--rebroadcast', 'unknown'], ['--rebroadcast', 'mint', '--rebroadcast', 'renew'], ['mint']])
    assert.throws(() => parseRebroadcast(args), /Usage/);
});
