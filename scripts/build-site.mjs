import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { packageConsumer as packageConsumerDefault } from './package-consumer.mjs';
import { validateAztecPricing } from './aztec-pricing.mjs';
import { assertDeploymentConfig, assertV6ManifestFile } from './deployment-config.mjs';
import { assertMainnetReady } from './mainnet-readiness.mjs';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { contentSecurityPolicy } from './testnet-security.mjs';
import { siteHosting } from './netlify.mjs';
export function buildSite(
  argv = process.argv.slice(2),
  { exec = execFileSync, root = new URL('../', import.meta.url), packageConsumer = packageConsumerDefault } = {},
) {
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !['--network', '--manifest', '--out'].includes(argv[i]) ||
      !argv[i + 1] ||
      options.has(argv[i])
    )
      throw new Error('Expected --network testnet-v6|mainnet [--manifest path --out dir]');
    options.set(argv[i], argv[i + 1]);
  }
  const network = options.get('--network');
  if (!['testnet-v6', 'mainnet'].includes(network))
    throw new Error('Expected --network testnet-v6|mainnet');
  if (network === 'mainnet') assertMainnetReady(root);
  assertDeploymentConfig(root);
  const customManifest = options.get('--manifest');
  const within = (base, target) => {
    const r = relative(base, target);
    return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('../'));
  };
  const repo = fileURLToPath(root);
  const physical = (path) => {
    try {
      return realpathSync(path);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return resolve(physical(dirname(path)), basename(path));
    }
  };
  const manifest = customManifest
    ? physical(resolve(customManifest))
    : resolve(repo, `deployments/${network}.json`);
  const out = options.get('--out')
    ? physical(resolve(options.get('--out')))
    : resolve(repo, 'web/dist');
  if (
    customManifest &&
    (within(resolve(repo, 'deployments'), manifest) ||
      !options.has('--out') ||
      within(out, manifest) ||
      within(resolve(repo, 'web/dist'), out) ||
      within(out, resolve(repo, 'web/dist')))
  )
    throw new Error('Preview requires manifest outside deployments and separate --out');
  if (!customManifest && options.has('--out'))
    throw new Error('--out requires an external --manifest');
  const deployment = assertV6ManifestFile(manifest, {
    expectNetwork: network,
    canonical: !customManifest,
  });

  // Registrar, resolver, fee token, tier prices and priceVersion are discovered by RegistryReader from chain state.
  validateAztecPricing(JSON.parse(readFileSync('deployments/aztec-pricing.json', 'utf8')));
  const head = exec('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = exec('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  const release = `${head}${dirty ? '-dirty' : ''}`;
  const walletUrls = process.env.FOG_PUBLIC_WALLET_URLS ?? '';
  const hosting = customManifest ? { siteOrigin: '', apiOrigin: '' } : siteHosting(network, root);
  const CSP = contentSecurityPolicy(walletUrls);
  const env = {
    ...process.env,
    VITE_NODE_URL: deployment.nodeUrl,
    VITE_REGISTRY: deployment.registry,
    VITE_NETWORK: network,
    VITE_FEE_PAYMENT: deployment.feePayment ?? 'sponsored',
    VITE_CHAIN_ID: deployment.chainId,
    VITE_ROLLUP_VERSION: deployment.rollupVersion,
    VITE_PROVER_ENABLED: 'true',
    VITE_DEVELOPMENT_WALLET: 'false',
    VITE_WEB_WALLET_URLS: walletUrls,
    VITE_RELEASE: release,
    VITE_TELEMETRY: 'true',
    // The canonical site may be hosted apart from the API Worker. Previews of external manifests call their own /api/*.
    VITE_API_ORIGIN: hosting.apiOrigin,
    VITE_SITE_ORIGIN: hosting.siteOrigin,
  };
  delete env.VITE_SPONSORED_FPC;
  delete env.VITE_ALLOW_V8_REHEARSAL_SUCCESSOR;
  if ((deployment.feePayment ?? 'sponsored') === 'sponsored')
    env.VITE_SPONSORED_FPC = deployment.sponsoredFpc;
  if (customManifest) {
    exec('npm', ['run', 'build:sdk'], { env, stdio: 'inherit' });
    exec('npm', ['run', 'build', '-w', '@fog/web', '--', '--outDir', out], {
      env,
      stdio: 'inherit',
    });
  } else exec('npm', ['run', 'build'], { env, stdio: 'inherit' });
  // The Markdown export reads VITE_NETWORK so it describes the same network as the site.
  exec('node', ['--import', 'tsx', 'scripts/export-docs.mjs', out, release], { env, stdio: 'inherit' });
  packageConsumer(`${out}/downloads/sdk`, release, deployment);
  writeFileSync(`${out}/health.txt`, `fog:${release}\n`);
  // Wallet key material lives in this origin's storage, so script sources are restricted to the site itself.
  // WebAssembly (proving, encrypted SQLite) needs 'wasm-unsafe-eval'; RPC and wallet endpoints are any HTTPS/WSS origin.
  writeFileSync(
    `${out}/_headers`,
    `/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: ${CSP}\n  X-Fog-Release: ${release}\n/health.txt\n  Cache-Control: no-store\n/downloads/sdk/fog-*\n  Cache-Control: public, max-age=31536000, immutable\n/downloads/sdk/manifest.json\n  Cache-Control: no-store\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/index.html\n  Cache-Control: no-cache\n`,
  );
  // Netlify and Cloudflare static assets both answer typed or shared app paths (/docs/pricing) with the app page, which
  // shows the matching hash route. Redirect rules cannot target a URL fragment, hence the rewrite. The target is `/`:
  // Cloudflare answers a rewrite to /index.html with a redirect to `/`, which would drop the path. Exact paths come
  // before placeholder paths so the plain rules are matched first.
  const appRoutes = JSON.parse(
    readFileSync(new URL('../web/src/app-routes.json', import.meta.url), 'utf8'),
  );
  writeFileSync(
    `${out}/_redirects`,
    [
      '/favicon.ico /favicon.svg 302',
      ...appRoutes.map((route) => `/${route} / 200`),
      ...appRoutes.map((route) => `/${route}/:page / 200`),
    ].join('\n') + '\n',
  );
  console.log(`Built ${network === 'testnet-v6' ? 'testnet' : network} release ${release}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  buildSite();
