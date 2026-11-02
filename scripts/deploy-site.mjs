import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertMainnetReady } from './mainnet-readiness.mjs';
export function deploySite(
  argv = process.argv.slice(2),
  { exec = execFileSync, root = new URL('../', import.meta.url) } = {},
) {
  if (argv.length !== 2 || argv[0] !== '--network' || !['testnet-v6', 'mainnet'].includes(argv[1]))
    throw new Error('Expected --network testnet-v6|mainnet');
  if (argv[1] === 'mainnet') {
    assertMainnetReady(root);
    throw new Error('Mainnet blocked: publication procedure undecided');
  }
  exec('node', ['scripts/deploy-testnet.mjs'], { stdio: 'inherit' });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  deploySite();
