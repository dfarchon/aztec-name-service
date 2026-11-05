import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Fr } from '@aztec-labs/aztec.js/fields';
import {
  main,
  parseRehearsalArgs,
  type rehearsalDependencies,
} from './testnet-v7-launch-rehearsal.js';
import { V6_PROFILES } from './v6-network.js';
const p = V6_PROFILES['testnet-v6'];
function dependencies() {
  const methods: string[] = [];
  const deps = {
    createNode: () => ({
      getNodeInfo: async () => {
        methods.push('getNodeInfo');
        return {
          nodeVersion: '6.0.0',
          l1ChainId: 11155111,
          rollupVersion: 679261766,
          realProofs: true,
          l1ContractAddresses: {
            rollupAddress: p.rollup,
            feeJuicePortalAddress: p.feeJuicePortal,
            feeAssetHandlerAddress: p.feeAssetHandler,
          },
        };
      },
      getPublicStorageAt: async () => {
        methods.push('getPublicStorageAt');
        return new Fr(7);
      },
      sendTx: () => {
        throw Error('broadcast forbidden');
      },
    }),
    createL1: () => ({
      getChainId: async () => 11155111,
      getBalance: async () => 0n,
      getGasPrice: async () => 1000000000n,
    }),
  } as unknown as typeof rehearsalDependencies;
  return { deps, methods };
}
test('CLI defaults to read-only, rejects ambiguous/unknown options and requires explicit send confirmation', async () => {
  assert(parseRehearsalArgs([]).dryRun);
  for (const args of [
    ['--send', '--dry-run'],
    ['--send', '--send'],
    ['--key-file', 'bad'],
    ['--state-dir'],
  ])
    assert.throws(() => parseRehearsalArgs(args));
  const f = dependencies();
  await assert.rejects(main(['--send'], f.deps), /exact --confirm/);
  assert.deepEqual(f.methods, []);
  await assert.rejects(main(['--state-dir', '/tmp/invalid'], f.deps), /checkpoint/);
  assert.deepEqual(f.methods, []);
});
test('live dry-run only uses allowlisted public reads and leaves checkpoint directory untouched', async () => {
  const f = dependencies();
  const dir = join(homedir(), `.local/share/ans/testnet-v7-launch-rehearsal-unit-${process.pid}`);
  await assert.rejects(lstat(dir), { code: 'ENOENT' });
  const log = console.log;
  console.log = () => {};
  try {
    const result = await main(['--dry-run', '--state-dir', dir], f.deps);
    assert(result?.dryRun);
    assert(result.l1.sendMoreSepoliaEth);
    assert.equal(result.balances.length, 3);
    assert.deepEqual(f.methods, [
      'getNodeInfo',
      'getPublicStorageAt',
      'getPublicStorageAt',
      'getPublicStorageAt',
    ]);
    await assert.rejects(lstat(dir), { code: 'ENOENT' });
  } finally {
    console.log = log;
  }
});
test('dry-run rejects wrong Aztec or L1 identities before reporting balances', async () => {
  const f = dependencies();
  f.deps.createL1 = (() => ({ getChainId: async () => 1 })) as unknown as typeof f.deps.createL1;
  await assert.rejects(main([], f.deps), /Sepolia/);
  const g = dependencies(),
    node = g.deps.createNode('unused'),
    info = await node.getNodeInfo();
  g.deps.createNode = (() => ({
    getNodeInfo: async () => ({ ...info, nodeVersion: '5.2.1' }),
  })) as unknown as typeof g.deps.createNode;
  await assert.rejects(main([], g.deps), /identity mismatch/);
});

test('operator errors expose only bounded symbolic codes and discard arbitrary messages', async () => {
  const { sanitizedRehearsalErrorCode: code } = await import('./testnet-v7-launch-rehearsal.js');
  assert.equal(code({ code: 'quote_expired' }), 'quote_expired');
  assert.equal(code({ code: 'ERR_ASSERTION' }), 'ERR_ASSERTION');
  for (const value of [
    null,
    Error('credential=hidden'),
    { code: 'https://user:secret@rpc' },
    { code: 'ERR\nsecret' },
    { code: 'x'.repeat(65) },
    { code: 123 },
  ])
    assert.equal(code(value), 'REHEARSAL_FAILED');
});
