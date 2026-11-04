import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { validateAztecPricing } from './aztec-pricing.mjs';

/** Reject local additions and special files before copying any starter files. */
export function consumerFiles(dir = 'examples/consumer', { exec = execFileSync } = {}) {
  const root = exec('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const tracked = new Set(exec('git', ['ls-files', '-z', '--full-name', '--', resolve(dir)], {
    encoding: 'utf8',
  }).split('\0').filter(Boolean).map(path => relative(resolve(dir), resolve(root, path))));
  if (!lstatSync(dir).isDirectory()) throw new Error('Consumer directory must be a regular directory, not a symlink');
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error(`Consumer entry must be a regular file or directory, not a symlink: ${path}`);
    if (!stat.isFile()) continue;
    const name = relative(resolve(dir), resolve(path));
    if (!tracked.delete(name)) throw new Error(`Consumer file is untracked or ignored: ${name}`);
    files.push(name);
  }
  if (tracked.size) throw new Error(`Tracked consumer files are missing: ${[...tracked].join(', ')}`);
  return files.sort();
}

/** Call after building the SDK with a validated deployment. Produces static downloads without publication. */
export function packageConsumer(output, release, deployment) {
  if (!deployment) throw new Error('Consumer packaging requires a validated deployment');
  const files = consumerFiles();
  output = resolve(output);
  mkdirSync(output, { recursive: true });
  const sdk = JSON.parse(readFileSync('sdk/package.json', 'utf8'));
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
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
    mkdirSync(starter, { recursive: true });
    for (const file of files) {
      const target = join(starter, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join('examples/consumer', file), target);
    }
    copyFileSync(join(output, sdkName), join(starter, 'ans-sdk.tgz'));
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
