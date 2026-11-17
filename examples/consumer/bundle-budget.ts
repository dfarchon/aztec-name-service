import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

const MAX_STATIC_ASSET_BYTES = 25 * 1024 * 1024;

/** Budget the full static entry graph, including shared chunks. Wallet execution loads on demand. */
export function initialBundleBudget(): Plugin {
  return {
    name: 'initial-bundle-budget',
    config(userConfig) {
      if (userConfig.build?.rollupOptions?.output) return;
      return {
        build: {
          rollupOptions: {
            output: {
              manualChunks(id) {
                const clean = id.replace(/\\/g, '/').split('?')[0];
                if (clean.endsWith('-metadata.json')) return;
                const match = clean.match(/\/sdk\/(?:src|dist)\/artifacts\/([^/]+)\.json$/);
                if (match) return `artifact-${match[1]}`;
              },
            },
          },
        },
      };
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const initial = new Set<string>();
        const visit = (name: string) => {
          if (initial.has(name)) return;
          const chunk = bundle[name];
          if (chunk?.type !== 'chunk') return;
          initial.add(name);
          chunk.imports.forEach(visit);
        };
        for (const chunk of Object.values(bundle))
          if (chunk.type === 'chunk' && chunk.isEntry) visit(chunk.fileName);
        const executionArtifactChunks = Object.values(bundle)
          .filter(
            (chunk) =>
              chunk.type === 'chunk' &&
              Object.keys(chunk.modules).some(
                (id) =>
                  /\/sdk\/(?:src|dist)\/artifacts\//.test(id) && !id.endsWith('-metadata.json'),
              ),
          )
          .map((chunk) => chunk.fileName);
        let rawBytes = 0,
          gzipBytes = 0;
        for (const name of initial) {
          const chunk = bundle[name];
          if (chunk.type !== 'chunk') continue;
          if (executionArtifactChunks.includes(name))
            this.error(
              'ANS execution artifacts must load only after a wallet action or a write page is opened',
            );
          rawBytes += Buffer.byteLength(chunk.code);
          gzipBytes += gzipSync(chunk.code).byteLength;
        }
        if (gzipBytes > 400_000)
          this.error(`Initial JavaScript exceeds the 400 kB gzip budget: ${gzipBytes} bytes`);
        for (const item of Object.values(bundle)) {
          const bytes =
            item.type === 'chunk'
              ? Buffer.byteLength(item.code)
              : typeof item.source === 'string'
                ? Buffer.byteLength(item.source)
                : item.source.byteLength;
          if (bytes > MAX_STATIC_ASSET_BYTES)
            this.error(
              `Bundle output ${item.fileName} exceeds the 25 MiB static asset limit: ${bytes} bytes`,
            );
        }
        this.emitFile({
          type: 'asset',
          fileName: 'bundle-budget.json',
          source:
            JSON.stringify(
              {
                rawBytes,
                gzipBytes,
                maxGzipBytes: 400_000,
                maxAssetBytes: MAX_STATIC_ASSET_BYTES,
                chunks: [...initial],
                executionArtifactsDeferred: true,
                executionArtifactChunks,
              },
              null,
              2,
            ) + '\n',
        });
      },
    },
  };
}
