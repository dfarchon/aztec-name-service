import { open } from 'node:fs/promises';
import test from 'node:test';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
const A = metadata.v8.classId,
  B = metadata.v8Rehearsal.classId;
import assert from 'node:assert/strict';
import { mkdtemp, chmod, symlink, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MockJournal,
  mockStep,
  readOnlyRpc,
  safeArguments,
  verifyIdentity,
  checkStepBudget,
  fullDelay,
  bridgeReadiness,
  digest,
  validateBinding,
  type Binding,
  type MockAdapter,
} from './v8-safe-operator.js';
import { V8_RESERVED_HASH } from './v8-rehearsal-plan.js';
const actor = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const binding: Binding = {
  schema: 'ans-v8-safe-prep/1',
  run: 'local-only',
  identity: {
    chainId: 31337,
    rollupVersion: 1,
    realProofs: false,
    nodeVersion: '6.0.0',
    classes: [A, B],
    codeHashes: ['a'.repeat(64)],
  },
  actors: {
    owner: actor(1),
    administrator: actor(1),
    treasury: actor(1),
    holder: actor(2),
    recipient: actor(3),
  },
  artifacts: { registry: 'b'.repeat(64) },
  reservations: { count: 325, hash: V8_RESERVED_HASH, batches: 11 },
  edges: [
    [A, B],
    [B, A],
  ],
  configHash: 'c'.repeat(64),
};
async function fixture(run: (path: string, journal: MockJournal) => Promise<void>) {
  const path = await mkdtemp(join(tmpdir(), 'ans-mock-'));
  await chmod(path, 0o700);
  const journal = await MockJournal.acquire(path, binding);
  try {
    await run(path, journal);
  } finally {
    await journal.close();
    await rm(path, { recursive: true, force: true });
  }
}
function adapter() {
  const calls = { prove: 0, broadcast: 0, readback: 0, receipt: 0 };
  const mock: MockAdapter = {
    kind: 'pure-local-mock',
    chainId: 31337,
    endpoint: 'http://127.0.0.1:1',
    prove: async () => {
      calls.prove++;
      return Buffer.from('pure-mock');
    },
    broadcast: async () => {
      calls.broadcast++;
    },
    receipt: async () => {
      calls.receipt++;
      return 'success';
    },
    readback: async () => {
      calls.readback++;
    },
  };
  return { mock, calls };
}
const guard = async () => {};
test('CLI defaults dry-run; flags and injected live environment never open money files or send', () => {
  assert.equal(safeArguments([]).mode, 'dry-run');
  for (const arg of ['--execute', '--live', '--force', '--config=x', '--private-key-path=x'])
    assert.throws(() => safeArguments([arg]), /PAUSED/);
  const cli = join(import.meta.dirname, 'v8-safe-operator-cli.ts');
  const run = spawnSync(process.execPath, ['--import', 'tsx', cli], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      ANS_EXECUTE: 'true',
      ANS_KEY_PATH: '/forbidden-money-file',
      ANS_CONFIG: '/forbidden-config',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.publicExecutionAllowed, false);
  assert.equal(result.liveReady, false);
  const rejected = spawnSync(process.execPath, ['--import', 'tsx', cli, '--execute'], {
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /PAUSED/);
});
test('RPC whitelist blocks all writes, unknown methods and batch before transport', async () => {
  const seen: string[] = [];
  const rpc = readOnlyRpc(async (method) => {
    seen.push(method);
    return 1;
  });
  for (const method of [
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'eth_sign',
    'personal_sign',
    'wallet_sendCalls',
    'anvil_setBalance',
    'node_sendTx',
    'eth_accounts',
    'personal_newAccount',
    'batch',
    '__proto__',
  ])
    await assert.rejects(() => rpc(method));
  assert.equal(seen.length, 0);
  await rpc('eth_getCode');
  assert.deepEqual(seen, ['eth_getCode']);
});
test('identity and binding reject drift without fallback and retain 325 inventory', () => {
  validateBinding(binding);
  for (const key of [
    'chainId',
    'rollupVersion',
    'realProofs',
    'nodeVersion',
    'classes',
    'codeHashes',
  ] as const) {
    const changed = { ...binding.identity, [key]: 'wrong' };
    assert.throws(() => verifyIdentity(binding.identity, changed as never));
  }
  for (const changed of [
    { ...binding, reservations: { ...binding.reservations, count: 324 } },
    { ...binding, actors: { ...binding.actors, owner: actor(0) } },
    {
      ...binding,
      edges: [
        [A, B],
        [A, B],
      ],
    },
  ])
    assert.throws(() => validateBinding(changed as Binding));
});
test('private store enforces modes, no symlinks, locks, immutable binding and history', async () => {
  const path = await mkdtemp(join(tmpdir(), 'ans-store-'));
  await chmod(path, 0o700);
  const alias = path + '-alias';
  try {
    await chmod(path, 0o755);
    await assert.rejects(() => MockJournal.acquire(path, binding), /mode0700/);
    await chmod(path, 0o700);
    await symlink(path, alias);
    await assert.rejects(() => MockJournal.acquire(alias, binding), /symlink/);
    const journal = await MockJournal.acquire(path, binding);
    await assert.rejects(() => MockJournal.acquire(path, binding), /EEXIST/);
    await journal.append('one', 'intent');
    await journal.close();
    for (const changed of [
      { ...binding, actors: { ...binding.actors, treasury: actor(3) } },
      { ...binding, configHash: 'e'.repeat(64) },
      { ...binding, artifacts: { registry: 'e'.repeat(64) } },
    ])
      await assert.rejects(() => MockJournal.acquire(path, changed), /drift/);
    const entry = JSON.parse(await readFile(join(path, '000000.json'), 'utf8'));
    entry.binding = 'bad';
    await writeFile(join(path, '000000.json'), JSON.stringify(entry));
    await assert.rejects(() => MockJournal.acquire(path, binding), /drift/);
  } finally {
    await rm(alias, { force: true });
    await rm(path, { recursive: true, force: true });
  }
});
test('hash and directory fsync precede mock broadcast; restart tracks saved hash with zero duplicate sends', async () => {
  await fixture(async (path, journal) => {
    const { mock, calls } = adapter();
    mock.broadcast = async (_bytes, hash) => {
      calls.broadcast++;
      const saved = JSON.parse(await readFile(join(path, '000002.json'), 'utf8'));
      assert.equal(saved.phase, 'broadcasting');
      assert.equal(saved.hash, hash);
    };
    assert.equal(await mockStep(journal, 'deploy', mock, guard), 'TRACK_ONLY');
    assert.equal(await mockStep(journal, 'deploy', mock, guard), 'confirmed');
    assert.equal(await mockStep(journal, 'deploy', mock, guard), 'confirmed');
    assert.equal(calls.prove, 1);
    assert.equal(calls.broadcast, 1);
  });
});
test('proof, hash fsync, broadcast, receipt and readback failures never duplicate', async () => {
  for (const failure of ['proof', 'hash-fsync', 'broadcast', 'receipt', 'readback'])
    await fixture(async (_path, journal) => {
      const { mock, calls } = adapter();
      if (failure === 'proof')
        mock.prove = async () => {
          throw Error('proof');
        };
      if (failure === 'broadcast')
        mock.broadcast = async () => {
          calls.broadcast++;
          throw Error('ambiguous');
        };
      if (failure === 'receipt')
        mock.receipt = async () => {
          throw Error('RPC');
        };
      if (failure === 'readback')
        mock.readback = async () => {
          throw Error('readback');
        };
      if (failure === 'hash-fsync') {
        const append = journal.append.bind(journal);
        journal.append = async (...args) => {
          if (args[1] === 'hashed') throw Error('fsync');
          return append(...args);
        };
        await assert.rejects(() => mockStep(journal, 'step', mock, guard), /fsync/);
      } else await mockStep(journal, 'step', mock, guard);
      await mockStep(journal, 'step', mock, guard);
      await mockStep(journal, 'step', mock, guard);
      assert(calls.broadcast <= 1);
      if (['proof', 'hash-fsync'].includes(failure)) assert.equal(calls.broadcast, 0);
    });
});
test('resume after crash with saved hash is track only even if no broadcast; terminal failures keep hash', async () => {
  for (const outcome of ['pending', 'unknown', 'reverted', 'dropped', 'reorg'] as const)
    await fixture(async (_path, journal) => {
      const { mock, calls } = adapter();
      const hash = digest('mock-payload');
      await journal.append('step', 'intent');
      await journal.append('step', 'hashed', hash);
      mock.receipt = async () => outcome;
      for (let i = 0; i < 20; i++)
        assert.equal(await mockStep(journal, 'step', mock, guard), 'STOP');
      await assert.rejects(() => mockStep(journal, 'step', mock, guard), /finite/);
      assert.equal(journal.latest()?.hash, hash);
      assert.equal(calls.broadcast, 0);
      assert.equal(calls.prove, 0);
    });
});
test('incomplete budget, overrun, prices, DA and activation fail closed; full waits and bounded bridge', () => {
  const b = {
    complete: true,
    measured: 1n,
    ceiling: 10n,
    step: 1n,
    actorAvailable: 2n,
    sampledAt: 100,
    l2Price: 1n,
    approvedL2Price: 1n,
    daPrice: 0n,
  };
  checkStepBudget(b, 100);
  for (const patch of [
    { complete: false },
    { measured: 10n },
    { actorAvailable: 0n },
    { l2Price: 2n },
    { daPrice: 1n },
    { sampledAt: 0 },
    { activationAt: 1000 },
  ])
    assert.throws(() => checkStepBudget({ ...b, ...patch }, 100));
  assert.throws(() => fullDelay('application', 0n, 600n, 600n));
  for (const stage of [
    'application',
    'protocol',
    'rollback-application',
    'rollback-protocol',
  ] as const) {
    assert.equal(fullDelay(stage, 1n, 86400n, 86401n).status, 'waiting');
    assert.equal(fullDelay(stage, 1n, 86401n, 86401n).status, 'ready-for-fresh-readback');
  }
  const bridge = {
    attempts: 0,
    maximum: 20,
    expectedMessage: 'a'.repeat(64),
    observedMessage: 'a'.repeat(64),
    proven: false,
  };
  assert.match(bridgeReadiness(bridge), /waiting/);
  assert.throws(() => bridgeReadiness({ ...bridge, attempts: 20 }));
  assert.throws(() => bridgeReadiness({ ...bridge, observedMessage: 'b'.repeat(64) }));
});

test('disk reopen preserves TRACK-only recovery and blocks earlier completed steps', async () => {
  const path = await mkdtemp(join(tmpdir(), 'ans-reopen-'));
  await chmod(path, 0o700);
  let journal = await MockJournal.acquire(path, binding);
  const { mock, calls } = adapter();
  try {
    await mockStep(journal, 'first', mock, guard);
    await journal.close();
    journal = await MockJournal.acquire(path, binding);
    assert.equal(await mockStep(journal, 'first', mock, guard), 'confirmed');
    await mockStep(journal, 'second', mock, guard);
    await mockStep(journal, 'second', mock, guard);
    await assert.rejects(() => mockStep(journal, 'first', mock, guard), /completed/);
    assert.equal(calls.broadcast, 2);
    assert.equal(calls.prove, 2);
  } finally {
    await journal.close();
    await rm(path, { recursive: true, force: true });
  }
});
test('guard failure after hash persistence stops broadcast and resumes by tracking only', async () => {
  await fixture(async (_path, journal) => {
    const { mock, calls } = adapter();
    let guards = 0;
    await assert.rejects(
      () =>
        mockStep(journal, 'step', mock, async () => {
          if (++guards === 2) throw Error('identity drift');
        }),
      /drift/,
    );
    assert.equal(calls.broadcast, 0);
    assert.equal(journal.latest()?.phase, 'hashed');
    await mockStep(journal, 'step', mock, guard);
    assert.equal(calls.broadcast, 0);
    assert.equal(calls.prove, 1);
  });
});

test('confirmed resume readback drift halts advancement while retaining hash', async () => {
  await fixture(async (_path, journal) => {
    const { mock, calls } = adapter();
    await mockStep(journal, 'step', mock, guard);
    await mockStep(journal, 'step', mock, guard);
    const hash = journal.latest()?.hash;
    mock.readback = async () => {
      throw Error('owner changed');
    };
    assert.equal(await mockStep(journal, 'step', mock, guard), 'STOP');
    assert.equal(journal.latest()?.hash, hash);
    await assert.rejects(() => mockStep(journal, 'next', mock, guard), /unresolved/);
    assert.equal(calls.broadcast, 1);
  });
});

test('real file/directory fsync fault injection blocks broadcast and disk resume never resends', async () => {
  for (const failAt of [3, 4, 5, 6]) {
    const path = await mkdtemp(join(tmpdir(), 'ans-sync-'));
    await chmod(path, 0o700);
    let journal = await MockJournal.acquire(path, binding);
    const { mock, calls } = adapter();
    const probe = await open(join(tmpdir(), `ans-probe-${process.pid}-${failAt}`), 'w', 0o600);
    const prototype = Object.getPrototypeOf(probe),
      original = prototype.sync;
    let syncs = 0;
    prototype.sync = async function () {
      if (++syncs === failAt) throw Error('injected fsync failure');
      return original.call(this);
    };
    try {
      await assert.rejects(() => mockStep(journal, 'step', mock, guard), /fsync/);
      assert.equal(calls.broadcast, 0);
    } finally {
      prototype.sync = original;
      await probe.close();
      await rm(join(tmpdir(), `ans-probe-${process.pid}-${failAt}`), { force: true });
    }
    try {
      await journal.close();
      journal = await MockJournal.acquire(path, binding);
      await mockStep(journal, 'step', mock, guard);
      assert.equal(calls.broadcast, 0);
      assert.equal(calls.prove, 1);
    } finally {
      await journal.close();
      await rm(path, { recursive: true, force: true });
    }
  }
});

test('instrumented CLI performs zero credential reads, key constructions, signatures and connections', async () => {
  const path = await mkdtemp(join(tmpdir(), 'ans-cli-guard-'));
  const preload = join(path, 'guard.cjs');
  await writeFile(
    preload,
    `
const fs=require('node:fs'), fsp=require('node:fs/promises'), crypto=require('node:crypto'), net=require('node:net');
const counters={credentialReads:0,keyConstructions:0,signatures:0,connections:0};
function guard(p){if(/(?:^|\\/)(?:l1-key|keys|state|bridge|auth)\\.json$|forbidden-money|forbidden-config|(?:^|\\/)\\.env(?:$|\\.)|wallet.*(?:db|store)/i.test(String(p))){counters.credentialReads++;throw Error('credential access forbidden');}}
for(const name of ['readFileSync','openSync']){const original=fs[name];fs[name]=function(p,...args){guard(p);return original.call(this,p,...args);};}
for(const name of ['readFile','open']){const original=fsp[name];fsp[name]=async function(p,...args){guard(p);return original.call(this,p,...args);};}
crypto.createPrivateKey=function(){counters.keyConstructions++;throw Error('key construction forbidden');};
crypto.sign=function(){counters.signatures++;throw Error('signing forbidden');};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const options=Array.isArray(args[0])?args[0][0]:args[0];const path=typeof options==='string'?options:options?.path; if(typeof path==='string' && path.startsWith('/')) return connect.apply(this,args); counters.connections++;throw Error('TCP network forbidden');};
require('node:module').syncBuiltinESMExports();
process.on('exit',()=>process.stderr.write('SAFE_COUNTERS='+JSON.stringify(counters)+'\\n'));
`,
    { mode: 0o600 },
  );
  try {
    for (const args of [[], ['--execute'], ['--force'], ['--config=/forbidden-config']]) {
      const child = spawnSync(
        process.execPath,
        [
          '--require',
          preload,
          '--import',
          'tsx',
          join(import.meta.dirname, 'v8-safe-operator-cli.ts'),
          ...args,
        ],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, ANS_EXECUTE: '1', ANS_KEY_PATH: '/forbidden-money' },
        },
      );
      assert.equal(child.status, args.length ? 1 : 0, child.stderr);
      const match = /SAFE_COUNTERS=(.*)/.exec(child.stderr);
      assert(match, child.stderr);
      assert.deepEqual(JSON.parse(match[1]), {
        credentialReads: 0,
        keyConstructions: 0,
        signatures: 0,
        connections: 0,
      });
    }
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
