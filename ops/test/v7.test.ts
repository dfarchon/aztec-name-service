import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectModules, modularClass } from '../src/modular.js';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
test('V7 monitor recognizes the new registry and still enforces frozen module classes and binding', async () => {
  const hex = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
  assert.equal(modularClass(metadata.v7.classId), true);
  let foreign = false;
  const rpc = async (method: string, params: unknown[]) => {
    if (method === 'getContract') return { currentContractClassId: params[0] === hex(2n) ? metadata.registrarLaunch.classId : metadata.resolver.classId };
    assert.equal(method, 'getPublicStorageAt'); assert.equal(params[0], 10);
    const address = params[1], slot = BigInt(params[2] as string);
    if (address === hex(1n)) {
      const base = BigInt(metadata.v7.storage.modules);
      if (slot >= base && slot < base + 3n) return hex([2n, 3n, 1n][Number(slot - base)]);
      if (slot === BigInt(metadata.v7.storage.administrator)) return hex(7n);
    }
    return hex(foreign && address === hex(3n) ? 9n : 1n);
  };
  const result = await inspectModules(rpc as any, hex(1n), metadata.v7.classId, 10);
  assert(result.checks.every(check => check.ok)); assert.equal(result.modules.administrator, hex(7n));
  foreign = true;
  assert.equal((await inspectModules(rpc as any, hex(1n), metadata.v7.classId, 10)).checks.find(check => check.name === 'resolver')?.ok, false);
});
