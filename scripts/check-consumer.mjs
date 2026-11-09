import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageConsumer } from './package-consumer.mjs';
import { assertV6ManifestFile } from './deployment-config.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'ans-independent-consumer-'));
try {
  const output = join(temporary, 'downloads');
  const release = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const deployment = assertV6ManifestFile('deployments/testnet-v6.json', {
    expectNetwork: 'testnet-v6',
    canonical: true,
  });
  const manifest = packageConsumer(output, release, deployment);
  for (const artifact of [manifest.sdk, manifest.starter]) {
    const bytes = readFileSync(join(output, artifact.url.split('/').pop()));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  }
  execFileSync('unzip', [
    '-q',
    join(output, manifest.starter.url.split('/').pop()),
    '-d',
    temporary,
  ]);
  const cwd = join(temporary, 'ans-consumer');
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'deployment.json'), 'utf8')), deployment);
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'pricing.json'), 'utf8')), manifest.pricing);
  assert.equal(existsSync(join(cwd, 'fee-switch.json')), false);
  assert.equal('feeSwitch' in manifest, false);
  assert.equal(manifest.pricing.currency, 'AZTEC');
  assert.equal(manifest.pricing.settlement.status, 'unconfigured');
  assert.deepEqual(
    manifest.deployment,
    JSON.parse(readFileSync('deployments/testnet-v6.json', 'utf8')),
  );
  assert.ok(['ANSF', 'mAZTEC'].includes(manifest.deployment.feeSymbol));
  assert.equal(
    manifest.deployment.feeDecimals,
    manifest.deployment.feeSymbol === 'mAZTEC' ? 18 : 6,
  );
  execFileSync('npm', ['install', '--no-fund', '--no-audit'], { cwd, stdio: 'pipe' });
  // Exercise the published JavaScript in plain Node, without tsx or bundler transforms.
  execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
    import { Resolver, parseWithBigInt, stringifyWithBigInt } from '@ans/sdk/read';
    import { connectAns } from '@ans/sdk';
    import { NameRegistryV6Contract } from '@ans/sdk/contracts/v6';
    import { NameRegistryV7Contract } from '@ans/sdk/contracts/v7';
    assert.equal(typeof connectAns, 'function');
    assert.equal(NameRegistryV6Contract.artifact.name, 'NameRegistryV6');
    assert.equal(NameRegistryV7Contract.artifact.name, 'NameRegistryV7');
    assert.deepEqual(parseWithBigInt(stringifyWithBigInt({ amount: 1000000n })), { amount: 1000000n });
    let reads = 0, canonical = true;
    const reader = {
      registry: AztecAddress.fromBigIntUnsafe(2n),
      snapshot: async () => ({ blockNumber: 10, blockHash: 'block-10', timestamp: 100n, finality: 'proposed' }),
      isCanonical: async () => canonical,
      getPrimary: async () => { reads++; return { present: false }; },
    };
    const resolver = new Resolver(reader, { reorgCheckMs: 0 });
    const account = AztecAddress.fromBigIntUnsafe(1n);
    assert.equal((await resolver.primary(account)).status, 'none');
    await resolver.primary(account);
    assert.equal(reads, 1);
    canonical = false;
    await resolver.primary(account);
    assert.equal(reads, 2);
    console.log('PASS compiled SDK imports and wallet-free cache/reorg handling in plain Node');
  `,
    ],
    { cwd, stdio: 'inherit' },
  );
  // Compile the exact documentation snippets against an independently installed SDK.
  execFileSync('node', ['--import', 'tsx', 'scripts/check-docs.mjs', cwd], { stdio: 'inherit' });
  execFileSync('npm', ['run', 'check'], { cwd, stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { cwd, stdio: 'inherit' });
  if (process.env.ANS_CONSUMER_BROWSER === '1') {
    const { checkConsumerBrowser } = await import('../web/scripts/consumer-browser.mjs');
    await checkConsumerBrowser(cwd);
  }
  const audit = JSON.parse(
    execFileSync('npm', ['audit', '--audit-level=high', '--json'], {
      cwd,
      encoding: 'utf8',
    }),
  );
  assert.equal(audit.metadata.vulnerabilities.high, 0);
  assert.equal(audit.metadata.vulnerabilities.critical, 0);
  console.log(
    JSON.stringify({
      sdkVersion: manifest.sdkVersion,
      independentInstall: true,
      plainNodeRuntime: true,
      typecheck: true,
      checksums: true,
      vulnerabilities: audit.metadata.vulnerabilities,
    }),
  );
  if (process.env.ANS_CONSUMER_LIVE_READ === '1') {
    execFileSync('npm', ['run', 'doctor'], { cwd, stdio: 'inherit' });
    execFileSync('npm', ['run', 'read'], { cwd, stdio: 'inherit' });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
