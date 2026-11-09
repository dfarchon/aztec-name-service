import test from 'node:test';
import assert from 'node:assert/strict';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { DomainSeparator } from '@aztec-labs/constants';
import { hashWithSeparator } from '../../sdk/src/core/hash.js';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import { inspectCoreUpgrade } from '../src/core-upgrade.js';
test('V8 monitor uses pinned SDK raw policy and rejects unknown class, without simulation', async () => {
  const registry = AztecAddress.fromBigIntUnsafe(123n), slot = metadata.v8.storage;
  const values = new Map<string, bigint>();
  const put = (base: bigint, fields: bigint[]) => fields.forEach((value, i) => values.set(String(base + BigInt(i)), value));
  put(BigInt(slot.core_class), [BigInt(metadata.v8.classId)]);
  const release = await hashWithSeparator([BigInt(slot.releases), BigInt(metadata.v8.classId)], BigInt(DomainSeparator.PUBLIC_STORAGE_MAP_SLOT));
  put(release, [1n, 0x414e535f434f5245n, 1n, 100n]);
  let current = metadata.v8.classId;
  const calls: [string, unknown[]][] = [];
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    calls.push([method, params]);
    if (method === 'getBlockData') { assert.equal(params[0], 10); return { blockHash: 'canonical-N', header: { globalVariables: { timestamp: '1000' } } } as T; }
    if (method === 'getContract') { assert.equal(params[1], 10); return { originalContractClassId: metadata.v8.classId, currentContractClassId: current } as T; }
    if (method === 'getPublicStorageAt') { assert.equal(params[0], 10); return String(new Fr(params[1] === String(registry) ? values.get(String(BigInt(String(params[2])))) ?? 0n : 0n)) as T; }
    throw new Error(`Unexpected ${method}`);
  };
  assert.equal((await inspectCoreUpgrade(rpc, String(registry), 10)).ok, true);
  current = String(new Fr(999n));
  assert.equal((await inspectCoreUpgrade(rpc, String(registry), 10)).ok, false);
  assert(calls.every(([method]) => !method.toLowerCase().includes('simulat')));
});
test('V8 monitor transport failure is an unhealthy check', async () => {
  const result = await inspectCoreUpgrade(async () => { throw new Error('fixture transport failure'); }, String(AztecAddress.fromBigIntUnsafe(123n)), 10);
  assert.equal(result.ok, false);
});
