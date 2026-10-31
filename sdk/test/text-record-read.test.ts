import assert from 'node:assert/strict';
import test from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import { RegistryReader } from '../src/client/reader.js';
import { resolveChainAddress } from '../src/client/resolve.js';
import { encodeRecordKey, encodeTextValue, TEXT_DOMAIN } from '../src/core/records.js';
import { hashWithSeparator, recordKey } from '../src/core/hash.js';
import { packBytes } from '../src/core/label.js';
import type { Snapshot } from '../src/core/types.js';
import metadata from '../src/artifacts/modular-metadata.json' with { type: 'json' };

const snap: Snapshot = { blockNumber: 10, blockHash: 'block-10', timestamp: 1000n, finality: 'checkpointed' };
async function fixture() {
  const registry = AztecAddress.fromBigIntUnsafe(1n), nameNode = 42n;
  const key = 'address:eip155:1', address = '0x' + 'ab'.repeat(20);
  const scope = await recordKey(nameNode, 2);
  const valueKey = await hashWithSeparator([scope, encodeRecordKey(key)], TEXT_DOMAIN);
  const slot = (await deriveStorageSlotInMap(Fr.fromString(metadata.extended.storage.text_values), new Fr(valueKey))).toBigInt();
  const encoded = encodeTextValue(address);
  const words = [...Array.from({ length: 8 }, (_, i) => packBytes(encoded.bytes.slice(i * 31, i * 31 + 31))), BigInt(encoded.length)];
  let reads = 0, offline = false;
  const reader = await RegistryReader.connect({
    getNodeInfo: async () => ({ l1ChainId: 11155111, rollupVersion: 1821665230 }),
    getContract: async () => ({ currentContractClassId: Fr.fromString(metadata.extended.classId) }),
    getPublicStorageAt: async (block: number, contract: AztecAddress, field: Fr) => {
      assert.equal(block, snap.blockNumber); assert(contract.equals(registry));
      if (offline) throw new Error('fetch failed');
      const index = Number(field.toBigInt() - slot);
      assert(index >= 0 && index < 9, 'must not enumerate profile keys or unrelated records');
      reads++; return new Fr(words[index]);
    },
  } as any, registry);
  let current = { generation: 2, revision: 1, expiresAt: 2000n, owner: registry };
  reader.getName = async (_node, snapshot) => { assert.equal(snapshot, snap); return current; };
  return { reader, nameNode, key, address, words, current, reads: () => reads, fail: () => { offline = true; } };
}

test('single-record lookup reads only nine value fields at the supplied snapshot', async () => {
  const f = await fixture();
  assert.equal(await f.reader.getTextRecord(f.nameNode, 2, f.key, snap), f.address);
  assert.equal(f.reads(), 9);
  f.words.fill(0n);
  assert.equal(await f.reader.getTextRecord(f.nameNode, 2, f.key, snap), undefined);
});

test('single-record lookup does not revive old generations or inactive descendant records', async () => {
  const f = await fixture();
  assert.equal(await f.reader.getTextRecord(f.nameNode, 1, f.key, snap), undefined);
  f.current.expiresAt = 0n; // getName applies revoked ancestor invalidation.
  assert.equal(await f.reader.getTextRecord(f.nameNode, 2, f.key, snap), undefined);
  assert.equal(f.reads(), 0);
});

test('single-record lookup propagates corrupt storage and network failure', async () => {
  const f = await fixture();
  f.words[8] = 249n;
  await assert.rejects(f.reader.getTextRecord(f.nameNode, 2, f.key, snap), (e: any) => e.code === 'corrupt_data');
  f.fail();
  await assert.rejects(f.reader.getTextRecord(f.nameNode, 2, f.key, snap), (e: any) => e.code === 'network');
});

test('chain address resolution fetches one key and does not enumerate a full profile', async () => {
  const f = await fixture();
  f.reader.snapshot = async () => snap;
  f.reader.getTextRecords = async () => { throw new Error('unnecessary profile enumeration'); };
  f.reader.getTextRecord = async (_node, generation, key, snapshot) => {
    assert.equal(generation, 2); assert.equal(key, f.key); assert.equal(snapshot, snap); return f.address;
  };
  assert.equal(await resolveChainAddress(f.reader, 'alice', 'eip155:1'), f.address);
});

test('one protocol-valid but SDK-unsupported profile entry cannot hide other records', async () => {
  const { INDEX_DOMAIN } = await import('../src/core/records.js');
  const registry = AztecAddress.fromBigIntUnsafe(1n), scope = await recordKey(42n, 2);
  const storage = new Map<bigint, bigint>();
  const write = async (map: string, key: bigint, words: bigint[]) => {
    const base = (await deriveStorageSlotInMap(Fr.fromString(map), new Fr(key))).toBigInt();
    words.forEach((word, i) => storage.set(base + BigInt(i), word));
  };
  const keys = [1n, encodeRecordKey('description'), encodeRecordKey('url')];
  await write(metadata.extended.storage.text_count, scope, [3n]);
  for (const [i, key] of keys.entries()) {
    await write(metadata.extended.storage.text_keys, await hashWithSeparator([scope, i], INDEX_DOMAIN), [key]);
    const bytes = encodeTextValue('Hello');
    const words = [...Array.from({ length: 8 }, (_, n) => packBytes(bytes.bytes.slice(n * 31, n * 31 + 31))), BigInt(bytes.length)];
    if (i === 2) words[0] = packBytes([255, ...new Array(30).fill(0)]); // Invalid UTF-8 is legal on-chain.
    await write(metadata.extended.storage.text_values, await hashWithSeparator([scope, key], TEXT_DOMAIN), words);
  }
  let offline = false;
  const reader = await RegistryReader.connect({
    getNodeInfo: async () => ({ l1ChainId: 11155111, rollupVersion: 1821665230 }),
    getContract: async () => ({ currentContractClassId: Fr.fromString(metadata.extended.classId) }),
    getPublicStorageAt: async (_block: number, _contract: AztecAddress, slot: Fr) => {
      if (offline) throw new Error('fetch failed');
      return new Fr(storage.get(slot.toBigInt()) ?? 0n);
    },
  } as any, registry);
  reader.getName = async () => ({ generation: 2, revision: 1, expiresAt: 2000n, owner: registry });
  assert.deepEqual(await reader.getTextRecords(42n, 2, snap), { description: 'Hello' });
  offline = true;
  await assert.rejects(reader.getTextRecords(42n, 2, snap), (e: any) => e.code === 'network');
});
