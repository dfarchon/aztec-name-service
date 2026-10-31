import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStateToolchain, assertTestnet } from './testnet-network.js';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { newWallet } from './common.js';

const endpoint = 'https://v5.testnet.rpc.aztec-labs.com';
const info = { nodeVersion: '5.0.0', l1ChainId: 11155111, rollupVersion: 1821665230, realProofs: true,
    l1ContractAddresses: { rollupAddress: '0xd73a91bdcf6891c7642f3e460036e1ef2cc23178' } };
test('migration refuses legacy and mismatched wallet checkpoints before opening wallets', () => {
  assert.doesNotThrow(() => assertStateToolchain({ toolchainVersion: '5.2.1' }));
  for (const state of [{}, { toolchainVersion: '5.0.1' }, { toolchainVersion: '5.2.0' }])
    assert.throws(() => assertStateToolchain(state), /keep legacy state/);
});
test('testnet accepts only pinned identity with real proofs', () => {
  assert.doesNotThrow(() => assertTestnet(endpoint, info));
  assert.doesNotThrow(() => assertTestnet(endpoint, { ...info, nodeVersion: '5.2.1' }));
});
test('testnet refuses mainnet, local nodes and lookalike hosts', () => {
  for (const url of ['https://aztec-mainnet.drpc.org', 'http://localhost:8080', `${endpoint}.example.com`, endpoint.replace('https:', 'http:'), 'https://user:pass@v5.testnet.rpc.aztec-labs.com'])
    assert.throws(() => assertTestnet(url, info));
});
test('testnet refuses changed chain, rollup, version and mock proofs', () => {
  for (const change of [ { l1ChainId: 1 }, { rollupVersion: 1 }, { nodeVersion: '5.2.0' }, { realProofs: false },
    { l1ContractAddresses: { rollupAddress: '0x0000000000000000000000000000000000000000' } } ])
    assert.throws(() => assertTestnet(endpoint, { ...info, ...change }));
});
test('local E2E cannot create a proof-disabled wallet on a public node', async () => {
  const node = { getNodeInfo: async () => ({ realProofs: true }) } as unknown as AztecNode;
  await assert.rejects(newWallet(node), /local-only/);
});
