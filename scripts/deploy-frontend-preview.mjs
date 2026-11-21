import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deployNetlify, requireNetlifySite } from './netlify.mjs';

/**
 * Build the canonical site for one network and upload it as a Netlify draft deploy: a separate URL for checking
 * headers, path rewrites and API access before a switch. The live site and both Workers are unchanged.
 * Telemetry from the draft URL is rejected by the API, since only SITE_URL may post it.
 */
export function deployFrontendPreview(
  argv = process.argv.slice(2),
  { exec = execFileSync, root = new URL('../', import.meta.url), env = process.env } = {},
) {
  if (argv.length !== 2 || argv[0] !== '--network' || !['testnet-v6', 'mainnet'].includes(argv[1]))
    throw new Error('Expected --network testnet-v6|mainnet');
  requireNetlifySite(env);
  const cwd = fileURLToPath(root);
  exec('node', ['scripts/build-site.mjs', '--network', argv[1]], { stdio: 'inherit', cwd });
  const health = readFileSync(new URL('web/dist/health.txt', root), 'utf8').trim();
  const match = /^fog:([a-zA-Z0-9.-]{1,64})$/.exec(health);
  if (!match) throw new Error(`Invalid release id ${health}`);
  deployNetlify({ exec, cwd, env, release: match[1], production: false });
  return match[1];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  deployFrontendPreview();
