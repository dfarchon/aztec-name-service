import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, symlink, stat, rm, rename, readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  assertKeyFile,
  assertBridgeStateDirectory,
  bridgeMain,
  checkpointTransport,
  createBridgeCheckpoint,
  parseBridgeArgs,
  openKeyFile,
  saveBridgeCheckpoint,
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
test('explicit L1 key can fund a separate testnet user state but must stay private', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ans-bridge-external-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userDir = join(dir, 'user'), ownerDir = join(dir, 'owner');
  await mkdir(userDir, { mode: 0o700 }); await mkdir(ownerDir, { mode: 0o700 });
  const key = join(ownerDir, 'dummy.json');
  await writeFile(key, '{}', { mode: 0o600 });
  const c = parseBridgeArgs(['--network', 'testnet-v6', '--state-dir', userDir,
    '--recipient', `0x${'1'.repeat(64)}`, '--l1-key-file', key,
    '--l1-rpc-url', 'https://l1.invalid', '--amount', '1', '--dry-run']);
  assert.equal(c.recipient, `0x${'1'.repeat(64)}`);
  assert.equal(c.keyPath, key); assert(c.explicitKey);
  await assertKeyFile(userDir, key, c.explicitKey);
  await assert.rejects(assertKeyFile(userDir, key), /inside state directory/);
  await chmod(ownerDir, 0o755);
  await assert.rejects(assertKeyFile(userDir, key, true), /0700/);
  await chmod(ownerDir, 0o700); await chmod(key, 0o644);
  await assert.rejects(assertKeyFile(userDir, key, true), /0600/);
  await chmod(key, 0o600); await symlink(key, join(ownerDir, 'link'));
  await assert.rejects(assertKeyFile(userDir, join(ownerDir, 'link'), true), /regular/);
});
test('external key rejects mutable/symlink ancestors and reads only its validated descriptor after replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ans-key-ancestors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ancestor = join(root, 'ancestor'), parent = join(ancestor, 'private');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const key = join(parent, 'synthetic-key.txt');
  await writeFile(key, 'synthetic-original', { mode: 0o600 });
  for (const mode of [0o777, 0o770]) {
    await chmod(ancestor, mode);
    await assert.rejects(openKeyFile(root, key, true), /secure owned ancestors/);
  }
  await chmod(ancestor, 0o700);
  await symlink(ancestor, join(root, 'alias'));
  await assert.rejects(openKeyFile(root, join(root, 'alias/private/synthetic-key.txt'), true), /ancestors/);
  const file = await openKeyFile(root, key, true);
  try {
    await rename(key, join(parent, 'moved.txt'));
    await writeFile(join(parent, 'replacement.txt'), 'synthetic-replacement', { mode: 0o600 });
    await symlink(join(parent, 'replacement.txt'), key);
    assert.equal(await file.readFile('utf8'), 'synthetic-original');
    await assert.rejects(openKeyFile(root, key, true), /regular 0600/);
  } finally { await file.close(); }
});
test('explicit recipient requires private bridge state before key access or network calls', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ans-bridge-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assertBridgeStateDirectory(root, true);
  for (const mode of [0o755, 0o777]) {
    await chmod(root, mode);
    await assert.rejects(bridgeMain(['--network', 'local', '--state-dir', root,
      '--recipient', `0x${'1'.repeat(64)}`, '--l1-key-file', join(root, 'absent'),
      '--l1-rpc-url', 'http://127.0.0.1:1', '--amount', '1', '--dry-run']), /0700|ancestors/);
  }
});
test('bridge atomic save ignores planted temporary symlinks and replaces final symlinks without following', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ans-bridge-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'public-sentinel.txt'), path = join(root, 'synthetic-checkpoint.json');
  await writeFile(target, 'unchanged');
  await symlink(target, `${path}.tmp`);
  await symlink(target, path);
  await Promise.all([saveBridgeCheckpoint(path, { synthetic: 1 }), saveBridgeCheckpoint(path, { synthetic: 2 })]);
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
  assert((await lstat(`${path}.tmp`)).isSymbolicLink());
  assert(!(await lstat(path)).isSymbolicLink());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert([1, 2].includes(JSON.parse(await readFile(path, 'utf8')).synthetic));
  assert.deepEqual((await readdir(root)).sort(), ['public-sentinel.txt', 'synthetic-checkpoint.json', 'synthetic-checkpoint.json.tmp']);
});
test('explicit recipient exception refuses both deployer markers by existence only, including dangling symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ans-bridge-markers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const marker of ['keys.json', 'state.json']) {
    const path = join(root, marker);
    // An unreadable directory and a dangling link both count; neither can be parsed as a file.
    await mkdir(path, { mode: 0o000 });
    await assert.rejects(assertBridgeStateDirectory(root, true), /deployer markers/);
    await rm(path, { recursive: true });
    await symlink(join(root, 'nonexistent'), path);
    await assert.rejects(bridgeMain(['--network', 'local', '--state-dir', root,
      '--recipient', `0x${'1'.repeat(64)}`, '--l1-key-file', join(root, 'absent'),
      '--l1-rpc-url', 'http://127.0.0.1:1', '--amount', '1', '--dry-run']), /deployer markers/);
    await rm(path);
  }
  await assertBridgeStateDirectory(root, true);
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
