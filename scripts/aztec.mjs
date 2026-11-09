import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Use the repository's exact compiler without changing the user's global Aztec version.
const version = '6.0.0';
const pinned = readFileSync(new URL('../.aztecrc', import.meta.url), 'utf8').trim();
if (pinned !== version) throw new Error(`.aztecrc pins ${pinned}, but scripts/aztec.mjs requires ${version}`);
const root = process.env.ANS_AZTEC_TOOLCHAIN_DIR ?? join(homedir(), '.aztec', 'versions', version);
try {
  const pkg = JSON.parse(readFileSync(join(root, 'node_modules/@aztec-labs/aztec/package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error(`found ${pkg.version}`);
} catch (error) {
  throw new Error(`ANS requires Aztec ${version} at ${root}; install it with aztec-up install ${version}. ${error.message}`);
}
// AZTEC_VERSIONED keeps the wrapper from re-selecting a toolchain through aztec-up.
const env = { ...process.env, AZTEC_VERSIONED: '1' };
if (process.argv[2] === 'test') {
  // The 6.0.0 shell launcher starts TXE without a host argument. Scope the policy to tests.
  const preload = fileURLToPath(new URL('./txe-loopback.cjs', import.meta.url));
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`.trim();
}
const result = spawnSync(join(root, 'bin/aztec'), process.argv.slice(2), {
  stdio: 'inherit',
  env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
