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

test('default output splits deferred contract artifact JSONs and rejects >25 MiB assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-bundle-split-'));
  writeFileSync(
    join(root, 'entry.js'),
    'window.loadWallet = () => import("wallet-context"); window.meta = "ok";',
  );
  const source: Plugin = {
    name: 'split-test-source',
    resolveId(id) {
      if (id === 'wallet-context') return '/sdk/dist/wallet/context.js';
      if (id === 'artifact-v7')
        return '/node_modules/@ans/sdk/dist/artifacts/name_registry_v7.json';
      if (id === 'artifact-v8')
        return '/node_modules/@ans/sdk/dist/artifacts/name_registry_v8.json';
    },
    load(id) {
      if (id === '/sdk/dist/wallet/context.js')
        return 'import v7 from "artifact-v7"; import v8 from "artifact-v8"; export const both = [v7, v8];';
      if (id === '/node_modules/@ans/sdk/dist/artifacts/name_registry_v7.json')
        return '{"name":"v7"}';
      if (id === '/node_modules/@ans/sdk/dist/artifacts/name_registry_v8.json')
        return '{"name":"v8"}';
    },
  };
  try {
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [source, initialBundleBudget()],
      build: { write: false, minify: false, rollupOptions: { input: join(root, 'entry.js') } },
    });
    assert.ok('output' in result);
    const metadata = result.output.find(
      (item) => item.type === 'asset' && item.fileName === 'bundle-budget.json',
    );
    assert.ok(metadata?.type === 'asset');
    const budget = JSON.parse(String(metadata.source));
    assert.ok(
      budget.executionArtifactChunks.some((name: string) =>
        name.includes('artifact-name_registry_v7'),
      ),
    );
    assert.ok(
      budget.executionArtifactChunks.some((name: string) =>
        name.includes('artifact-name_registry_v8'),
      ),
    );
    for (const chunk of budget.executionArtifactChunks)
      assert.equal(budget.chunks.includes(chunk), false);

    const oversized: Plugin = {
      name: 'oversized-asset',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'assets/huge.js',
          source: Buffer.alloc(25 * 1024 * 1024 + 1, 0x61),
        });
      },
    };
    await assert.rejects(
      build({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [source, oversized, initialBundleBudget()],
        build: { write: false, minify: false, rollupOptions: { input: join(root, 'entry.js') } },
      }),
      /exceeds the 25 MiB static asset limit/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
