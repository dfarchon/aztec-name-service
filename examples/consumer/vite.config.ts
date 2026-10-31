import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { initialBundleBudget } from './bundle-budget.js';
export default defineConfig({
  root: 'browser',
  plugins: [
    initialBundleBudget(),
    nodePolyfills({
      include: [
        'buffer',
        'crypto',
        'util',
        'stream',
        'process',
        'events',
        'path',
        'string_decoder',
        'tty',
        'vm',
      ],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
