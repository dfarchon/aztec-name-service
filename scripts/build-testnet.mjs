import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { packageConsumer } from './package-consumer.mjs';
import { validateAztecPricing } from './aztec-pricing.mjs';
import { assertDeploymentConfig, assertV6ManifestFile } from './deployment-config.mjs';
import { contentSecurityPolicy } from './testnet-security.mjs';
assertDeploymentConfig();
const deployment = assertV6ManifestFile('deployments/testnet-v6.json', { expectNetwork: 'testnet-v6', canonical: true });
// Registrar, resolver, fee token, tier prices and priceVersion are discovered by RegistryReader from chain state.
validateAztecPricing(JSON.parse(readFileSync('deployments/aztec-pricing.json', 'utf8')));
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
const release = `${head}${dirty ? '-dirty' : ''}`;
const walletUrls = process.env.ANS_PUBLIC_WALLET_URLS ?? '';
const CSP = contentSecurityPolicy(walletUrls);
const env = { ...process.env, VITE_NODE_URL: deployment.nodeUrl,
  VITE_REGISTRY: deployment.registry, VITE_SPONSORED_FPC: deployment.sponsoredFpc,
  VITE_CHAIN_ID: deployment.chainId, VITE_ROLLUP_VERSION: deployment.rollupVersion, VITE_PROVER_ENABLED: 'true',
  VITE_DEVELOPMENT_WALLET: 'false', VITE_WEB_WALLET_URLS: walletUrls,
  VITE_RELEASE: release, VITE_TELEMETRY: 'true' };
execFileSync('npm', ['run', 'build'], { env, stdio: 'inherit' });
execFileSync('node', ['--import', 'tsx', 'scripts/export-docs.mjs', 'web/dist', release], { stdio: 'inherit' });
packageConsumer('web/dist/downloads/sdk', release);
writeFileSync('web/dist/health.txt', `ans:${release}\n`);
// Wallet key material lives in this origin's storage, so script sources are restricted to the site itself.
// WebAssembly (proving, encrypted SQLite) needs 'wasm-unsafe-eval'; RPC and wallet endpoints are any HTTPS/WSS origin.
writeFileSync('web/dist/_headers', `/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: ${CSP}\n  X-ANS-Release: ${release}\n/health.txt\n  Cache-Control: no-store\n/downloads/sdk/ans-*\n  Cache-Control: public, max-age=31536000, immutable\n/downloads/sdk/manifest.json\n  Cache-Control: no-store\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/index.html\n  Cache-Control: no-cache\n`);
console.log(`Built testnet release ${release}`);
