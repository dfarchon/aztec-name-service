import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateAztecPricing } from './aztec-pricing.mjs';

/** Call after building the SDK. Produces static, versioned downloads, without publication. */
export function packageConsumer(output, release) {
  output = resolve(output);
  mkdirSync(output, { recursive: true });
  const sdk = JSON.parse(readFileSync('sdk/package.json', 'utf8'));
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  const deployment = JSON.parse(readFileSync('deployments/testnet-v6.json', 'utf8'));
  const pricing = validateAztecPricing(JSON.parse(readFileSync('deployments/aztec-pricing.json', 'utf8')));
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '-w', '@ans/sdk', '--ignore-scripts', '--json', '--pack-destination', output], { encoding: 'utf8' }));
  const sdkPath = join(output, pack.filename);
  const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const sdkSha = sha256(sdkPath);
  const sdkName = `ans-sdk-${sdk.version}-${sdkSha.slice(0, 12)}.tgz`;
  renameSync(sdkPath, join(output, sdkName));
  const temporary = mkdtempSync(join(tmpdir(), 'ans-consumer-'));
  try {
    const starter = join(temporary, 'ans-consumer');
    cpSync('examples/consumer', starter, { recursive: true });
    cpSync(join(output, sdkName), join(starter, 'ans-sdk.tgz'));
    writeFileSync(join(starter, 'deployment.json'), JSON.stringify(deployment, null, 2) + '\n');
    writeFileSync(join(starter, 'pricing.json'), JSON.stringify(pricing, null, 2) + '\n');
    writeFileSync(join(starter, 'package.json'), JSON.stringify({
      name: 'ans-consumer-example', private: true, type: 'module', engines: { node: '>=24.12.0' },
      scripts: { read: 'tsx read.ts', doctor: 'tsx doctor.ts', dev: 'vite --host 127.0.0.1', build: 'vite build', check: 'tsc --noEmit' },
      dependencies: { '@ans/sdk': 'file:./ans-sdk.tgz', '@aztec-labs/aztec.js': '6.0.0', '@aztec-labs/foundation': '6.0.0', '@aztec-labs/stdlib': '6.0.0', '@aztec-labs/noir-contracts.js': '6.0.0', '@aztec-labs/wallet-sdk': '6.0.0' },
      devDependencies: { tsx: '4.23.15', typescript: '5.9.3', '@types/node': '24.10.7', vite: '7.3.7', 'vite-plugin-node-polyfills': '0.25.0' },
      overrides: root.overrides,
    }, null, 2) + '\n');
    writeFileSync(join(starter, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      skipLibCheck: true, resolveJsonModule: true, esModuleInterop: true,
    }, include: ['*.ts', 'browser/*.ts'] }, null, 2) + '\n');
    const kit = join(output, `ans-consumer-${sdk.version}.zip`);
    try {
      execFileSync('zip', ['-q', '-r', kit, 'ans-consumer'], { cwd: temporary });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('The starter download needs the zip CLI; install it (e.g. apt-get install zip) and retry', { cause: error });
      throw error;
    }
    const starterSha = sha256(kit);
    const starterName = `ans-consumer-${sdk.version}-${starterSha.slice(0, 12)}.zip`;
    renameSync(kit, join(output, starterName));
    const manifest = { sdkVersion: sdk.version, sourceRelease: release, deployment, pricing,
      sdk: { url: `/downloads/sdk/${sdkName}`, sha256: sdkSha },
      starter: { url: `/downloads/sdk/${starterName}`, sha256: starterSha },
    };
    writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
