import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** Budget the full static entry graph, including shared chunks. Wallet execution loads on demand. */
export function initialBundleBudget(): Plugin {
  return {
    name: 'initial-bundle-budget',
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
        this.emitFile({
          type: 'asset',
          fileName: 'bundle-budget.json',
          source:
            JSON.stringify(
              {
                rawBytes,
                gzipBytes,
                maxGzipBytes: 400_000,
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
