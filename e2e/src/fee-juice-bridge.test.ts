import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, symlink, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  assertKeyFile,
  checkpointTransport,
  createBridgeCheckpoint,
  parseBridgeArgs,
  pendingReceipt,
} from './fee-juice-bridge.js';
const args = [
  '--network',
  'local',
  '--state-dir',
  '/tmp/ans-bridge-unit',
  '--l1-rpc-url',
  'http://127.0.0.1:8545',
  '--amount',
  '1',
];
test('bridge rejects mainnet, credentials, queries, fragments and non-loopback local L1', () => {
  assert.throws(() => parseBridgeArgs(['--network', 'mainnet']), /mainnet refused/);
  for (const url of [
    'http://user:password@localhost:8545',
    'http://localhost:8545/?key=private',
    'http://localhost:8545/#key',
    'https://public.invalid',
  ])
    assert.throws(() => parseBridgeArgs([...args.slice(0, 5), url, ...args.slice(6)]));
  assert.throws(() => parseBridgeArgs([...args, '--amount', '2']), /duplicate/);
});
test('bridge rejects loose key permissions, symlinks and outside-directory keys', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ans-bridge-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = join(dir, 'dummy.json');
  await writeFile(key, '{}', { mode: 0o600 });
  await assertKeyFile(dir, key);
  await chmod(key, 0o644);
  await assert.rejects(assertKeyFile(dir, key), /0600/);
  await chmod(key, 0o600);
  const link = join(dir, 'link');
  await symlink(key, link);
  await assert.rejects(assertKeyFile(dir, link), /regular/);
  await mkdir(join(dir, 'other'));
  await assert.rejects(assertKeyFile(join(dir, 'other'), key), /inside state directory/);
});
test('bridge persists private claim before first fake send and checkpoints hash before forwarding', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ans-bridge-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bridge.json');
  const state = await createBridgeCheckpoint(path, {
    network: 'local',
    recipient: 'public-recipient',
    amount: '1',
    l1Address: 'public-L1',
    l1ChainId: '31337',
    portal: 'public-portal',
    rpcHost: '127.0.0.1:8545',
    transactions: {},
    done: [],
  });
  const order: string[] = [];
  const send = checkpointTransport(
    async () => {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      order.push('forward');
      return 'public-hash';
    },
    async (hash) => {
      assert.match(hash, /^0x[0-9a-f]{64}$/);
      order.push('checkpoint');
    },
  );
  const output = await send({ method: 'eth_sendRawTransaction', params: ['0x0102'] });
  assert.deepEqual(order, ['checkpoint', 'forward']);
  assert(!String(output).includes(state.claimSecret));
  await assert.rejects(createBridgeCheckpoint(path, state), /EEXIST/);
});
test('pending or reverted L1 hash cannot trigger a resend', async () => {
  const hash = `0x${'1'.repeat(64)}` as const;
  await assert.rejects(
    pendingReceipt(hash, async () => undefined),
    /pending.*no resend/,
  );
  await assert.rejects(
    pendingReceipt(hash, async () => ({ status: 'reverted' })),
    /manual review/,
  );
  assert.equal((await pendingReceipt(hash, async () => ({ status: 'success' }))).status, 'success');
});
test('offline L1 init stdout contains only public address and refuses overwrite', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ans-bridge-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cmd = [
    '--import',
    'tsx',
    new URL('./fee-juice-bridge.ts', import.meta.url).pathname,
    '--init-l1-key',
    '--network',
    'local',
    '--state-dir',
    dir,
  ];
  const run = spawnSync(process.execPath, cmd, { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^0x[0-9a-fA-F]{40}\n$/);
  assert.equal(run.stderr, '');
  assert.equal((await stat(join(dir, 'l1-key.json'))).mode & 0o777, 0o600);
  const twice = spawnSync(process.execPath, cmd, { encoding: 'utf8' });
  assert.equal(twice.status, 1);
  assert.equal(twice.stdout, '');
  assert.doesNotMatch(twice.stderr, /privateKey|claimSecret|0x[0-9a-f]{64}/);
});
