import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FunctionSelector } from '@aztec-labs/stdlib/abi';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { NameRegistryV6Contract } from '../src/artifacts/NameRegistryV6.js';
import { NameRegistryV7Contract } from '../src/artifacts/NameRegistryV7.js';
import metadata from '../src/artifacts/modular-metadata.json' with { type: 'json' };
import pinned from './fixtures/classids-6.0.0.json' with { type: 'json' };
// @ts-expect-error Build helper remains outside SDK output.
import { validateV7Layout } from '../scripts/validate-layout.mjs';

test('V7 class and append-only layout are pinned while every V6 slot remains unchanged', async () => {
  assert.equal((await getContractClassFromArtifact(NameRegistryV7Contract.artifact)).id.toString(), pinned.classIds.v7);
  assert.equal(metadata.v7.classId, pinned.classIds.v7);
  await validateV7Layout(metadata.v7.storage);
  for (const [key, slot] of Object.entries(metadata.v6.storage)) assert.equal(metadata.v7.storage[key as keyof typeof metadata.v7.storage], slot, key);
  await assert.rejects(validateV7Layout({ ...metadata.v7.storage, record_revisions: '0x99' }), /slot changed/);
  await assert.rejects(validateV7Layout({ ...metadata.v7.storage, names: '0x99' }), /slot changed/);
  await assert.rejects(validateV7Layout({ ...metadata.v7.storage, extra: '0x23' }), /append only/);
});

test('V7 preserves every selector used by the frozen launch registrar and resolver', async () => {
  for (const name of ['commit', 'register_from_registrar', 'renew_from_registrar', 'address_from_resolver', 'get_name', 'get_administrator']) {
    const selector = async (artifact: typeof NameRegistryV6Contract.artifact) => {
      const fn = [...artifact.functions, ...artifact.nonDispatchPublicFunctions].find(fn => fn.name === name);
      assert(fn, name);
      return (await FunctionSelector.fromNameAndParameters(fn.name, fn.parameters)).toString();
    };
    assert.equal(await selector(NameRegistryV7Contract.artifact), await selector(NameRegistryV6Contract.artifact), name);
  }
});
