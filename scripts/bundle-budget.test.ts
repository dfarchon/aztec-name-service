import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build, type Plugin } from 'vite';
import { initialBundleBudget } from '../examples/consumer/bundle-budget.js';

async function bundle(entry: string, artifact: string, payload = '') {
  const root = mkdtempSync(join(tmpdir(), 'ans-bundle-budget-'));
  writeFileSync(join(root, 'entry.js'), entry);
  const source: Plugin = {
    name: 'budget-test-source',
    resolveId(id) {
      if (id === 'artifact') return artifact;
      if (id === 'payload') return '/budget/shared-payload.js';
    },
    load(id) {
      if (id === artifact)
        return id.endsWith('.json')
          ? '{"artifact":"metadata"}'
          : 'export const artifact = "execution";';
      if (id === '/budget/shared-payload.js')
        return `export const payload = ${JSON.stringify(payload)};`;
    },
  };
  try {
    return await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [source, initialBundleBudget()],
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: join(root, 'entry.js'),
          output: {
            manualChunks: (id) =>
              id === '/budget/shared-payload.js' ? 'shared-payload' : undefined,
          },
        },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('build rejects eager execution artifacts in workspace and installed SDKs', async () => {
  for (const path of [
    '/sdk/src/artifacts/Registry.js',
    '/node_modules/@ans/sdk/dist/artifacts/Registry.js',
  ])
    await assert.rejects(
      bundle('import {artifact} from "artifact"; window.execution = artifact;', path),
      /execution artifacts must load only/,
    );
});

test('build allows lazy execution artifacts and eager metadata', async () => {
  const result = await bundle(
    'window.loadExecution = () => import("artifact");',
    '/node_modules/@ans/sdk/dist/artifacts/Registry.js',
  );
  assert.ok('output' in result);
  const metadata = result.output.find(
    (item) => item.type === 'asset' && item.fileName === 'bundle-budget.json',
  );
  assert.ok(metadata?.type === 'asset');
  const budget = JSON.parse(String(metadata.source));
  assert.equal(budget.executionArtifactChunks.length, 1);
  assert.equal(budget.chunks.includes(budget.executionArtifactChunks[0]), false);
  await bundle(
    'import {artifact} from "artifact"; window.metadata = artifact;',
    '/node_modules/@ans/sdk/dist/artifacts/Registry-metadata.json',
  );
});

test('initial budget includes large static shared chunks', async () => {
  await assert.rejects(
    bundle(
      'import {payload} from "payload"; window.payload = payload;',
      '/unused/artifact.js',
      randomBytes(600_000).toString('base64'),
    ),
    /Initial JavaScript exceeds the 400 kB gzip budget/,
  );
});
