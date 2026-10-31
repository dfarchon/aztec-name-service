import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertDeploymentConfig } from './deployment-config.mjs';
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Commit source changes before deploying a versioned release.');
// Network identity and addresses come from wrangler.jsonc but must agree with the deployment manifest.
assertDeploymentConfig();
// The Cloudflare account is selected outside the repository (CLOUDFLARE_ACCOUNT_ID or the logged-in wrangler account).
if (!process.env.CLOUDFLARE_ACCOUNT_ID) console.warn('CLOUDFLARE_ACCOUNT_ID is not set; wrangler will use the account of the current login.');
execFileSync('node', ['scripts/build-testnet.mjs'], { stdio: 'inherit' });
const release = readFileSync('web/dist/health.txt', 'utf8').trim().replace(/^ans:/, '');
if (!/^[a-zA-Z0-9.-]{1,64}$/.test(release)) throw new Error(`Invalid release id ${release}`);
// RELEASE is intentionally absent from wrangler vars; the Workers refuse to report status without it.
execFileSync('wrangler', ['deploy', '--config', 'ops/wrangler-monitor.jsonc', '--var', `RELEASE:${release}`], { stdio: 'inherit' });
execFileSync('wrangler', ['deploy', '--config', 'ops/wrangler.jsonc', '--var', `RELEASE:${release}`], { stdio: 'inherit' });
