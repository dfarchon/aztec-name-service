import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { parseNetworkConfig, parseRpcConfig } from './src/network-config';
import { initialBundleBudget } from '../examples/consumer/bundle-budget';

const require = createRequire(import.meta.url);

/**
 * sqlite3mc resolves `sqlite3.wasm` and `sqlite3-opfs-async-proxy.js` relative to its worker chunk. Vite hashes the
 * wasm and never emits the proxy, so emit both under the names the runtime expects (same fix as the DF client).
 */
function emitSqliteRuntimeAssets(): Plugin {
  const proxy = readFileSync(require.resolve('@aztec-labs/sqlite3mc-wasm/vendor/jswasm/sqlite3-opfs-async-proxy.js'), 'utf8');
  return {
    name: 'emit-sqlite-runtime-assets',
    generateBundle(_options, bundle) {
      const wasm = Object.values(bundle).find((o) => o.type === 'asset' && /^assets\/sqlite3-.*\.wasm$/.test(o.fileName));
      if (wasm?.type === 'asset') this.emitFile({ type: 'asset', fileName: 'assets/sqlite3.wasm', source: wasm.source });
      this.emitFile({ type: 'asset', fileName: 'assets/sqlite3-opfs-async-proxy.js', source: proxy });
    },
  };
}

// The embedded PXE needs SharedArrayBuffer (bb.js threads, OPFS), hence COOP/COEP on every served page.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_'), ...process.env, DEV: command === 'serve' && mode !== 'production' };
  // Validate during the build too: malformed public config must never produce a deployable bundle.
  parseRpcConfig(env, parseNetworkConfig(env).network);
  return {
  // Parallel local/testnet previews need separate optimizer caches. Different env hashes otherwise load two Fr classes.
  cacheDir: process.env.ANS_VITE_CACHE_DIR || undefined,
  worker: { format: 'es' },
  plugins: [
    initialBundleBudget(),
    emitSqliteRuntimeAssets(),
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'util', 'stream', 'process', 'events', 'path', 'string_decoder', 'tty', 'vm'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: 'esnext' },
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
    include: [
      // Pre-optimize injected shims so the first visit does not reload halfway through wallet boot.
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
      '@aztec-labs/wallet-sdk/manager',
      '@aztec-labs/wallet-sdk/crypto',
      '@aztec-labs/aztec.js/fields',
      '@aztec-labs/aztec.js/addresses',
      '@aztec-labs/aztec.js/abi',
      '@aztec-labs/aztec.js/contracts',
      '@aztec-labs/aztec.js/wallet',
      '@aztec-labs/foundation/crypto/poseidon',
      '@aztec-labs/accounts/schnorr/lazy',
      '@aztec-labs/accounts/schnorr/stub/lazy',
      '@aztec-labs/standard-contracts/multi-call-entrypoint/lazy',
      'msgpackr/index-no-eval',
      'pino',
      // Avoid an optimizer reload while the first development-wallet unlock opens encrypted stores.
      'util',
      'tty',
    ],
    exclude: ['@aztec-labs/bb.js', '@aztec-labs/noir-acvm_js', '@aztec-labs/noir-noirc_abi', '@aztec-labs/kv-store/sqlite-opfs'],
  },
};
});
