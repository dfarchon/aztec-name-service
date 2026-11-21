import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertDeploymentConfig } from './deployment-config.mjs';
import { deployNetlify, requireNetlifySite, separateFrontend, siteHosting } from './netlify.mjs';
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Commit source changes before deploying a versioned release.');
// Network identity and addresses come from wrangler.jsonc but must agree with the deployment manifest.
assertDeploymentConfig();
// The Cloudflare account is selected outside the repository (CLOUDFLARE_ACCOUNT_ID or the logged-in wrangler account).
if (!process.env.CLOUDFLARE_ACCOUNT_ID) console.warn('CLOUDFLARE_ACCOUNT_ID is not set; wrangler will use the account of the current login.');
const frontend = separateFrontend(siteHosting('testnet-v6'));
if (frontend) requireNetlifySite(process.env);
execFileSync('node', ['scripts/build-testnet.mjs'], { stdio: 'inherit' });
const release = readFileSync('web/dist/health.txt', 'utf8').trim().replace(/^fog:/, '');
if (!/^[a-zA-Z0-9.-]{1,64}$/.test(release)) throw new Error(`Invalid release id ${release}`);
// The separately hosted site goes first: if its upload fails, both Workers keep the previous release.
if (frontend) deployNetlify({ exec: execFileSync, env: process.env, release, production: true });
// RELEASE is intentionally absent from wrangler vars; the Workers refuse to report status without it.
// The site Worker keeps serving the same build on its own address, so browser data saved there stays reachable.
execFileSync('wrangler', ['deploy', '--config', 'ops/wrangler-monitor.jsonc', '--var', `RELEASE:${release}`], { stdio: 'inherit' });
execFileSync('wrangler', ['deploy', '--config', 'ops/wrangler.jsonc', '--var', `RELEASE:${release}`], { stdio: 'inherit' });
