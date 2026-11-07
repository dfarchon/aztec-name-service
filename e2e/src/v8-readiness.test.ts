import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateActualAccounts,
  writeDeterministicFixtures,
  FIXTURE_WARNING,
} from './v8-fixture-generator.js';
import { RealL1Adapter, RealAztecAdapter, LocalPinnedAdapters } from './v8-real-adapters.js';
import { MockJournal, type Binding, digest } from './v8-safe-operator.js';

test('public adapters reject before touching even hostile execution arguments', () => {
  const trap = new Proxy(
    {},
    {
      get() {
        assert.fail('credential argument inspected');
      },
    },
  );
  for (const adapter of [
    new RealL1Adapter('https://example.invalid'),
    new RealAztecAdapter('https://example.invalid'),
  ]) {
    assert.throws(() => adapter.execute(trap), /PUBLIC_UNCONDITIONALLY_PAUSED/);
  }
  assert.throws(generateActualAccounts, /isolated signer/);
});
test('local factory refuses public/ambiguous URLs before transport or wallet creation', async () => {
  for (const url of [
    'https://example.invalid',
    'http://localhost:8082',
    'http://127.0.0.1:8082/?rpc=x',
    'http://u:p@127.0.0.1:8082',
  ])
    await assert.rejects(LocalPinnedAdapters.connect(url, url, {} as never), /loopback/);
});
test('canonical sorting uses code unit order independently of localeCompare', () => {
  const prior = String.prototype.localeCompare;
  String.prototype.localeCompare = () => {
    throw new Error('locale-dependent ordering');
  };
  try {
    assert.equal(digest({ z: 1, A: 2, a: 3 }), digest({ a: 3, A: 2, z: 1 }));
  } finally {
    String.prototype.localeCompare = prior;
  }
});
test('offline fixed fixtures use pinned account derivation, exclusive output and private modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ans-fixture-test-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /(?:NODE|RPC|ANVIL).*URL/i.test(k)),
  );
  for (const key of Object.keys(env)) delete process.env[key];
  try {
    const output = join(directory, 'fixed');
    const result = await writeDeterministicFixtures(output);
    assert.equal(result.warning, FIXTURE_WARNING);
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    for (const name of ['TEST-ONLY.json', 'public-fixtures.json'])
      assert.equal((await stat(join(output, name))).mode & 0o777, 0o600);
    const publicText = await readFile(join(output, 'public-fixtures.json'), 'utf8');
    assert(!/signingKey|fundingFixture"|"secret"/.test(publicText));
    assert(!/signingKey|secret|0x/.test(JSON.stringify(result)));
    const a = JSON.parse(publicText);
    assert.equal(new Set(a.actors.map((x: { address: string }) => x.address)).size, 3);
    const second = join(directory, 'second');
    await writeDeterministicFixtures(second);
    assert.equal(await readFile(join(second, 'public-fixtures.json'), 'utf8'), publicText);
    await assert.rejects(writeDeterministicFixtures(output), /EEXIST/);
    process.env.NODE_URL = 'https://example.invalid';
    await assert.rejects(writeDeterministicFixtures(join(directory, 'network')), /Offline/);
  } finally {
    delete process.env.NODE_URL;
    Object.assign(process.env, env);
    await rm(directory, { recursive: true, force: true });
  }
});

test('JavaScript construction cannot inject transports around the loopback gate', () => {
  assert.throws(
    () =>
      Reflect.construct(LocalPinnedAdapters, ['https://example.invalid', 'http://127.0.0.1:1', {}]),
    /loopback/,
  );
});

test('pinned viem produces recoverable chain31337 fixture bytes and Ethereum transaction hash', async () => {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { keccak256, parseTransaction, recoverTransactionAddress } = await import('viem');
  const signer = privateKeyToAccount(`0x${'01'.repeat(32)}`);
  const bytes = await signer.signTransaction({
    type: 'legacy',
    chainId: 31337,
    nonce: 0,
    gas: 21000n,
    gasPrice: 1n,
    to: `0x${'02'.repeat(20)}`,
    value: 0n,
  });
  assert.equal(parseTransaction(bytes).chainId, 31337);
  assert.equal(
    await recoverTransactionAddress({
      serializedTransaction: bytes as import('viem').TransactionSerialized,
    }),
    signer.address,
  );
  assert.match(keccak256(bytes), /^0x[0-9a-f]{64}$/);
});

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  trackL1Receipt,
  trackAztecReceipt,
  FUTURE_REHEARSAL,
  verifyPublicNode,
} from './v8-real-adapters.js';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import { TxHash } from '@aztec-labs/aztec.js/tx';
const actor = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const A = metadata.v8.classId,
  B = metadata.v8Rehearsal.classId;
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
  reservations: {
    count: 325,
    hash: '743b1b4c3ab4762cb2d12662765406fdf91971845a5ec6137b1f7444223657fa',
    batches: 11,
  },
  edges: [
    [A, B],
    [B, A],
  ],
  configHash: 'c'.repeat(64),
};

const hash = `0x${'0a'.repeat(32)}` as const;
async function recovery(
  run: (j: MockJournal, reopen: () => Promise<MockJournal>, path: string) => Promise<void>,
  confirmed = false,
) {
  const path = await mkdtemp(join(tmpdir(), 'ans-recovery-'));
  await chmod(path, 0o700);
  let j = await MockJournal.acquire(path, binding);
  try {
    await j.append('s', 'intent');
    await j.append('s', 'hashed', hash.slice(2));
    if (confirmed) await j.append('s', 'confirmed', hash.slice(2));
    await run(
      j,
      async () => {
        await j.close();
        j = await MockJournal.acquire(path, binding);
        return j;
      },
      path,
    );
  } finally {
    await j.close();
    await rm(path, { recursive: true, force: true });
  }
}
const l1Receipt = () => ({
  transactionHash: hash,
  blockHash: hash,
  blockNumber: 1n,
  status: 'success',
});
const l1Client = (receipt = l1Receipt(), canonical = true) =>
  ({
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ hash: canonical ? hash : 'wrong', timestamp: 42n }),
  }) as unknown as Parameters<typeof trackL1Receipt>[0];
const aztecReceipt = (success = true, txHash = hash) => ({
  txHash: TxHash.fromString(txHash),
  hasExecutionSucceeded: () => success,
  blockNumber: 1,
  blockHash: { toString: () => hash },
  status: success ? 'proven' : 'dropped',
  executionResult: 'success',
});
const aztecNode = (receipt = aztecReceipt(), canonical = true) =>
  ({
    getTxReceipt: async () => receipt,
    getBlock: async () => ({
      hash: { equals: () => canonical },
      header: { globalVariables: { timestamp: 42n } },
    }),
  }) as unknown as Parameters<typeof trackAztecReceipt>[0];
for (const confirmed of [false, true]) {
  for (const kind of ['hash', 'canonical', 'status'] as const) {
    if (!confirmed && kind === 'status') continue;
    test(`L1 ${kind} integrity halts durably, confirmed=${confirmed}`, async () =>
      recovery(async (j, reopen) => {
        const receipt = l1Receipt();
        if (kind === 'hash') receipt.transactionHash = `0x${'0b'.repeat(32)}` as typeof hash;
        if (kind === 'status') receipt.status = 'reverted';
        await assert.rejects(trackL1Receipt(l1Client(receipt, kind !== 'canonical'), j, 's', hash));
        assert.equal(j.latest()?.phase, 'halted');
        assert.match(j.latest()!.outcome!, /integrity/);
        assert.equal((await reopen()).latest()?.phase, 'halted');
      }, confirmed));
  }
  for (const kind of ['hash', 'canonical', 'status', 'readback'] as const) {
    test(`Aztec ${kind} drift and exact hash on resume, confirmed=${confirmed}`, async () =>
      recovery(async (j, reopen) => {
        j = await reopen();
        const receipt = aztecReceipt(
          kind !== 'status',
          kind === 'hash' ? (`0x${'0b'.repeat(32)}` as typeof hash) : hash,
        );
        const action = trackAztecReceipt(
          aztecNode(receipt, kind !== 'canonical'),
          j,
          's',
          hash,
          async () => {
            if (kind === 'readback') throw new Error('readback drift');
          },
        );
        if (kind === 'status' && !confirmed) {
          await action;
          assert.equal(j.latest()?.phase, 'tracking');
        } else {
          await assert.rejects(action);
          assert.equal(j.latest()?.phase, 'halted');
          assert.match(j.latest()!.outcome!, /integrity|confirmed-readback-drift/);
        }
        assert.equal(j.trackAttempts('s'), 1);
      }, confirmed));
  }
}
test('twenty durable receipt reservations survive exceptions, pending results, confirmation and crash reopen', async () =>
  recovery(async (j, reopen) => {
    let calls = 0;
    for (let i = 0; i < 20; i++) {
      if (i === 4) {
        // crash after fsync reservation and before RPC; slot remains spent
        await j.append('s', 'tracking', hash.slice(2), 'receipt-requested', true);
      } else if (i % 2) {
        await assert.rejects(
          trackAztecReceipt(
            {
              getTxReceipt: async () => {
                calls++;
                throw new Error('RPC');
              },
            } as never,
            j,
            's',
            hash,
            async () => {},
          ),
          /RPC/,
        );
      } else {
        calls++;
        await trackL1Receipt(l1Client({ ...l1Receipt(), status: 'reverted' }), j, 's', hash);
      }
      j = await reopen();
      assert.equal(j.trackAttempts('s'), i + 1);
    }
    await assert.rejects(trackL1Receipt(l1Client(), j, 's', hash), /limit/);
    assert.equal(calls, 19);
    assert.equal(j.trackAttempts('s'), 20);
  }));
test('confirmed observations also consume exactly one durable slot per call', async () =>
  recovery(async (j, reopen) => {
    for (let i = 0; i < 20; i++) {
      await trackL1Receipt(l1Client(), j, 's', hash);
      j = await reopen();
      assert.equal(j.trackAttempts('s'), i + 1);
    }
    await assert.rejects(trackL1Receipt(l1Client(), j, 's', hash), /limit/);
  }, true));
test('L1 RPC unavailability stays tracking without swallowing integrity checks', async () =>
  recovery(async (j) => {
    assert.equal(
      await trackL1Receipt(
        {
          getTransactionReceipt: async () => {
            throw new Error('RPC');
          },
        } as never,
        j,
        's',
        hash,
      ),
      undefined,
    );
    assert.equal(j.latest()?.outcome, 'receipt-unavailable');
    assert.equal(j.trackAttempts('s'), 1);
  }));
test('invalid transition does not poison journal; real filesystem failure remains failclosed', async () =>
  recovery(async (j, _reopen, path) => {
    await assert.rejects(j.append('s', 'intent'), /invalid/);
    await j.append('s', 'tracking', hash.slice(2), undefined, false);
    await mkdir(join(path, '000003.json'));
    await assert.rejects(j.append('s', 'tracking', hash.slice(2)), /EEXIST/);
    await assert.rejects(j.append('s', 'tracking', hash.slice(2)), /fsync failure/);
  }));
test('public L1 reads reject wrong chain before data calls', async () => {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const data = JSON.parse(body);
    methods.push(data.method);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result: '0x7a69' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const adapter = new RealL1Adapter(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    const address = `0x${'01'.repeat(20)}` as const;
    for (const read of [
      () => adapter.chainId(),
      () => adapter.code(address),
      () => adapter.balance(address),
      () => adapter.estimate({ account: address, to: address, data: '0x' }),
      () => adapter.nonce(address),
      () => adapter.gasPrice(),
      () => adapter.receipt(hash),
    ])
      await assert.rejects(read(), /chain mismatch/);
    assert(methods.every((m) => m === 'eth_chainId'));
    assert.equal(methods.length, 7);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('public node binds every canonical network field and retains null future targets/budget', () => {
  const info = {
    l1ChainId: FUTURE_REHEARSAL.chainId,
    rollupVersion: FUTURE_REHEARSAL.rollupVersion,
    nodeVersion: '6.0.0',
    realProofs: true,
    l1ContractAddresses: { rollupAddress: FUTURE_REHEARSAL.rollup },
  };
  verifyPublicNode(info as never);
  for (const patch of [
    { l1ChainId: 31337 },
    { rollupVersion: 1 },
    { nodeVersion: '6.1.0' },
    { realProofs: false },
    { l1ContractAddresses: { rollupAddress: 'wrong' } },
  ])
    assert.throws(() => verifyPublicNode({ ...info, ...patch } as never));
  for (const field of ['registry', 'registrar', 'resolver', 'budget'] as const)
    assert.equal(FUTURE_REHEARSAL[field], null);
});

test('public Aztec reads verify identity before any returned chain data is used', async () => {
  const adapter = new RealAztecAdapter('https://example.invalid');
  // Stub only the read-only transport; this adapter has no signer or wallet interface.
  const node = Reflect.get(adapter, 'node') as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  let dataCalls = 0;
  node.getNodeInfo = async () => ({ l1ChainId: 31337 });
  for (const method of ['getContract', 'getContractClass', 'getCurrentMinFees', 'getTxReceipt'])
    node[method] = async () => {
      dataCalls++;
      assert.fail('data requested before canonical identity');
    };
  for (const read of [
    () => adapter.info(),
    () => adapter.contract({} as never),
    () => adapter.contractClass({} as never),
    () => adapter.fees(),
    () => adapter.receipt(hash),
  ])
    await assert.rejects(read());
  assert.equal(dataCalls, 0);
});

test('receipt reservation fsync failure prevents RPC and poisons further writes', async (t) =>
  recovery(async (j, _reopen, path) => {
    const { open } = await import('node:fs/promises');
    const probe = await open(join(path, 'sync-probe'), 'w', 0o600);
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    await rm(join(path, 'sync-probe'));
    const mocked = t.mock.method(prototype, 'sync', async () => {
      throw new Error('injected fsync failure');
    });
    let calls = 0;
    try {
      await assert.rejects(
        trackL1Receipt(
          {
            getTransactionReceipt: async () => {
              calls++;
              assert.fail('RPC after failed fsync');
            },
          } as never,
          j,
          's',
          hash,
        ),
        /injected fsync/,
      );
      await assert.rejects(j.append('s', 'tracking', hash.slice(2)), /journal fsync failure/);
      assert.equal(calls, 0);
    } finally {
      mocked.mock.restore();
    }
  }));
