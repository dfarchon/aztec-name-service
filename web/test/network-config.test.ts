import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNetworkConfig, parseRpcConfig, identityMismatch } from '../src/network-config.ts';
import { V6_TESTNET, V6_MAINNET } from '../../scripts/deployment-config.mjs';

const publicEnv = (network: 'testnet-v6' | 'mainnet' = 'testnet-v6') => {
  const profile = network === 'mainnet' ? V6_MAINNET : V6_TESTNET;
  return { VITE_NETWORK: network, VITE_NODE_URL: 'https://rpc.example.invalid',
    VITE_CHAIN_ID: profile.chainId, VITE_ROLLUP_VERSION: profile.rollupVersion };
};
test('local defaults to one immutable endpoint and expected chain 31337, without a rollup pin', () => {
  const rpc = parseRpcConfig({}, 'local');
  assert.deepEqual(rpc, { endpoints: ['http://localhost:8080'], expectedChainId: '31337', expectedRollupVersion: undefined });
  assert(Object.isFrozen(rpc.endpoints));
  assert.equal(parseRpcConfig({ VITE_NODE_URL: 'http://127.0.0.1:8082', VITE_ROLLUP_VERSION: '0' }, 'local').expectedRollupVersion, '0');
});
for (const network of ['testnet-v6', 'mainnet'] as const) {
  test(`${network} pins match the selected deployment profile`, () => {
    const env = publicEnv(network);
    const rpc = parseRpcConfig(env, network);
    assert.deepEqual(rpc.endpoints, [env.VITE_NODE_URL]);
    assert.equal(rpc.expectedChainId, env.VITE_CHAIN_ID);
    assert.equal(rpc.expectedRollupVersion, env.VITE_ROLLUP_VERSION);
    for (const field of ['VITE_NODE_URL', 'VITE_CHAIN_ID', 'VITE_ROLLUP_VERSION'])
      assert.throws(() => parseRpcConfig({ ...env, [field]: undefined }, network));
    for (const wrong of [{ VITE_CHAIN_ID: '31337' }, { VITE_CHAIN_ID: network === 'mainnet' ? '11155111' : '1' },
      { VITE_ROLLUP_VERSION: '1' }]) assert.throws(() => parseRpcConfig({ ...env, ...wrong }, network));
  });
  test(`${network} allows HTTP only for explicit DEV loopback fixtures`, () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const env = { ...publicEnv(network), VITE_NODE_URL: `http://${host}:5291` };
      assert.throws(() => parseRpcConfig(env, network));
      assert.throws(() => parseRpcConfig({ ...env, DEV: false }, network));
      assert.doesNotThrow(() => parseRpcConfig({ ...env, DEV: true }, network));
      assert.throws(() => parseRpcConfig({ ...env, DEV: true, VITE_NETWORK: undefined }, network));
    }
    for (const host of ['rpc.example.invalid', 'localhost.example.invalid', '127.0.0.1.example.invalid'])
      assert.throws(() => parseRpcConfig({ ...publicEnv(network), DEV: true, VITE_NODE_URL: `http://${host}` }, network));
  });
}
test('DEV never infers public identity from supplied public pins', () => {
  const env = { ...publicEnv(), VITE_NETWORK: undefined, DEV: true };
  assert.equal(parseNetworkConfig(env).network, 'local');
  assert.throws(() => parseRpcConfig(env, 'local'));
  assert.throws(() => parseRpcConfig({ VITE_CHAIN_ID: '1' }, 'local'));
});
test('reject malformed identity pins and endpoint lists, credentials, fragments and other schemes', () => {
  for (const pin of ['-1', '01', '1.0', '0x1', 'NaN', ' 1', '1 '])
    assert.throws(() => parseRpcConfig({ ...publicEnv(), VITE_CHAIN_ID: pin }, 'testnet-v6'));
  for (const url of ['', 'https://a,https://b', '["https://a"]', 'https://a https://b',
    'ftp://rpc.example.invalid', 'https://user:pass@rpc.example.invalid', 'https://rpc.example.invalid/#fragment', 'not-a-url'])
    assert.throws(() => parseRpcConfig({ ...publicEnv(), VITE_NODE_URL: url }, 'testnet-v6'));
});
test('identity checks expected and previous chain and rollup, including zero pins', () => {
  const current = { chainId: 31337n, rollupVersion: 1n };
  assert.equal(identityMismatch({}, undefined, current), false);
  assert.equal(identityMismatch({ chainId: '31337', rollupVersion: '1' }, current, current), false);
  for (const expected of [{ chainId: '1' }, { rollupVersion: '2' }, { rollupVersion: '0' }])
    assert.equal(identityMismatch(expected, undefined, current), true);
  for (const previous of [{ ...current, chainId: 1n }, { ...current, rollupVersion: 2n }])
    assert.equal(identityMismatch({}, previous, current), true);
});
