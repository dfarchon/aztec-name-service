import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';

const SITE_CONFIGS = { 'testnet-v6': 'ops/wrangler.jsonc', mainnet: 'ops/wrangler-mainnet.jsonc' };

/**
 * Where a network's site and API live, from its site Worker config: SITE_URL is the canonical site and API_ORIGIN the
 * Worker serving /api/*. The static site may be hosted on Netlify while the API Worker, monitor, D1 and rate limits
 * stay on Cloudflare. `scripts/deployment-config.mjs` validates both values.
 */
export function siteHosting(network, root = new URL('../', import.meta.url)) {
  const path = SITE_CONFIGS[network];
  if (!path) throw new Error(`No site Worker config for ${network}`);
  const vars = parse(readFileSync(new URL(path, root), 'utf8'))?.vars ?? {};
  let siteOrigin = '';
  try {
    siteOrigin = new URL(vars.SITE_URL).origin;
  } catch {
    siteOrigin = '';
  }
  return { siteOrigin, apiOrigin: typeof vars.API_ORIGIN === 'string' ? vars.API_ORIGIN : '' };
}

/** The site is hosted apart from the API Worker, so a release also publishes the static build to Netlify. */
export function separateFrontend(hosting) {
  return Boolean(
    hosting?.siteOrigin && hosting?.apiOrigin && hosting.siteOrigin !== hosting.apiOrigin,
  );
}

/** The Netlify project is selected outside the repository, like the Cloudflare account. */
export function requireNetlifySite(env) {
  const site = env.NETLIFY_SITE_ID;
  if (!site || !/^[A-Za-z0-9-]{1,64}$/.test(site))
    throw new Error(
      'NETLIFY_SITE_ID must name the Netlify project for the static site (authenticate with NETLIFY_AUTH_TOKEN or netlify login).',
    );
  return site;
}

/**
 * Upload the already built web/dist without a Netlify build: the release is built and verified locally.
 * `production: false` creates a draft deploy on its own URL and leaves the live site unchanged.
 */
export function deployNetlify({ exec, cwd, env, release, production }) {
  const site = requireNetlifySite(env);
  return exec(
    'netlify',
    [
      'deploy',
      '--no-build',
      '--dir',
      'web/dist',
      '--site',
      site,
      '--message',
      `fog:${release}`,
      ...(production ? ['--prod'] : []),
    ],
    { stdio: 'inherit', cwd },
  );
}
