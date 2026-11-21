import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDeploymentConfig } from './deployment-config.mjs';
import { assertMainnetReady } from './mainnet-readiness.mjs';
import { deployNetlify, requireNetlifySite, separateFrontend, siteHosting } from './netlify.mjs';

export function deployMainnet({
  exec = execFileSync,
  root = new URL('../', import.meta.url),
  env = process.env,
} = {}) {
  assertMainnetReady(root);
  assertDeploymentConfig(root);
  const cwd = fileURLToPath(root);
  if (exec('git', ['status', '--porcelain'], { encoding: 'utf8', cwd }).trim())
    throw new Error('Commit source changes before deploying a versioned release.');
  exec('node', ['scripts/deployment-config.mjs'], { stdio: 'inherit', cwd });
  if (!env.CLOUDFLARE_ACCOUNT_ID)
    console.warn(
      'CLOUDFLARE_ACCOUNT_ID is not set; wrangler will use the account of the current login.',
    );
  const frontend = separateFrontend(siteHosting('mainnet', root));
  if (frontend) requireNetlifySite(env);
  exec('node', ['scripts/build-site.mjs', '--network', 'mainnet'], { stdio: 'inherit', cwd });
  const health = readFileSync(new URL('web/dist/health.txt', root), 'utf8').trim();
  const match = /^fog:([a-zA-Z0-9.-]{1,64})$/.exec(health);
  if (!match) throw new Error(`Invalid release id ${health}`);
  const release = match[1];
  // The separately hosted site goes first: if its upload fails, both Workers keep the previous release.
  // The site Worker keeps serving the same build on its own address, so browser data saved there stays reachable.
  if (frontend) deployNetlify({ exec, cwd, env, release, production: true });
  exec(
    'wrangler',
    ['deploy', '--config', 'ops/wrangler-monitor-mainnet.jsonc', '--var', `RELEASE:${release}`],
    { stdio: 'inherit', cwd },
  );
  exec(
    'wrangler',
    ['deploy', '--config', 'ops/wrangler-mainnet.jsonc', '--var', `RELEASE:${release}`],
    { stdio: 'inherit', cwd },
  );
  return release;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  deployMainnet();
