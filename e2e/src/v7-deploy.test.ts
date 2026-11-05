import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, makePolicy, confirmation, configHash, buildManifest, ZERO } from './deploy-v6-plan.js';
import { v6Artifacts } from './deploy-v6.js';
import { createRequire } from 'node:module';
const { v6ManifestProblems } = createRequire(import.meta.url)('../../scripts/deployment-config.mjs');
const base = ['--network', 'local', '--registrar', 'launch', '--token', 'none', '--price-version', '1'];
const mainnet = ['--network', 'mainnet', '--node-url', 'https://rpc.invalid', '--registrar', 'launch', '--token', 'none', '--price-version', '1', '--min-fee-juice', '1', '--state-dir', '/tmp/ans-v7-preview', '--manifest-out', '/tmp/ans-v7-manifest.json', '--dry-run'];
const pricing = { decimals: 18, annualPrice: '1', lengthPrices: { '3': '128', '4': '32' } };
test('registry version defaults preserve testnet V6 and require mainnet V7 with the exact renewal horizon', () => {
  assert.equal(parseArgs(base).registryVersion, 6);
  assert.equal(parseArgs([...base, '--registry-version', '7']).registryVersion, 7);
  for (const value of ['5', '8', '6.0', '07']) assert.throws(() => parseArgs([...base, '--registry-version', value]), /registry-version/);
  assert.equal(parseArgs(mainnet).registryVersion, 7); assert.equal(parseArgs(mainnet).maxRenewAhead, '31536000');
  assert.throws(() => parseArgs([...mainnet, '--registry-version', '6']), /Mainnet requires/);
  assert.throws(() => parseArgs([...mainnet, '--max-renew-ahead', '0']), /31536000/);
  assert.throws(() => parseArgs(['--network', 'testnet-v6', ...base.slice(2), '--registry-version', '7', '--dry-run']), /Testnet requires/);
});
test('V7 changes the registry artifact, confirmation and checkpoint policy without changing module classes', async () => {
  const six = parseArgs(base), seven = parseArgs([...base, '--registry-version', '7']);
  const a = await v6Artifacts('none', 'launch', 6), b = await v6Artifacts('none', 'launch', 7);
  assert.notEqual(a.classIds.registry, b.classIds.registry);
  for (const key of ['token', 'resolver', 'registrar']) assert.equal(a.classIds[key], b.classIds[key]);
  assert.equal(b.artifacts.registry.name, 'NameRegistryV7');
  assert.notEqual(confirmation(six), confirmation(seven)); assert.match(confirmation(seven), /registryVersion=7/);
  assert.notEqual(configHash(makePolicy(six, pricing, ZERO)), configHash(makePolicy(seven, pricing, ZERO)));
});
test('V7 local manifests bind protocol, class and optional registryVersion consistently', async () => {
  const c = parseArgs([...base, '--registry-version', '7']), p = makePolicy(c, pricing, ZERO);
  const { classIds } = await v6Artifacts('none', 'launch', 7);
  const one = `0x${'0'.repeat(63)}1`, hash = `0x${'1'.repeat(64)}`;
  const manifest = buildManifest(c, p, { chainId: '31337', rollupVersion: '1', rollup: `0x${'1'.repeat(40)}` }, { registry: one, resolver: one, registrar: one, token: ZERO, owner: one, sponsoredFpc: one }, classIds, Object.fromEntries(['deploy-registry', 'deploy-resolver', 'deploy-registrar', 'bootstrap'].map(step => [step, hash])), new Date().toISOString());
  assert.equal(manifest.protocol, 7); assert.equal(manifest.registryVersion, 7);
  assert.deepEqual(v6ManifestProblems(manifest), []);
  assert(v6ManifestProblems({ ...manifest, protocol: 6 }).length > 0);
});
