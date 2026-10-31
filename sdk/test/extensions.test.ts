import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeName, packBytes } from '../src/core/label.js';
import { nodeOf, nodeFromPacked } from '../src/core/hash.js';
import { chainAddressKey, decodeRecordKey, decodeTextValue, encodeRecordKey, encodeTextValue, validateChainAddress } from '../src/core/records.js';
import metadata from '../src/artifacts/modular-metadata.json' with { type: 'json' };
// @ts-expect-error Build helper intentionally remains outside SDK output.
import { validateV3Layout, validateV4Layout } from '../scripts/validate-layout.mjs';

test('V4 preserves frozen V3 slots, types, ordering and packed encodings', async () => {
  await validateV3Layout(metadata.extended.storage, 'name_registry_v4');
  await validateV4Layout(metadata.extended.storage);
});
test('subnames are opt-in, bounded, canonical and use parent-specific nodes', async () => {
  assert.throws(() => normalizeName('team.alice'));
  const name = normalizeName('APP.Team.ALICE', { allowSubnames: true });
  assert.equal(name.label, 'app.team.alice'); assert.equal(name.parent?.label, 'team.alice');
  assert.notEqual(await nodeOf(name), await nodeOf(normalizeName('app.other.alice', { allowSubnames: true })));
  const root = normalizeName('alice'); assert.equal(await nodeOf(root), await nodeFromPacked(root.packed, root.len));
  for (const value of ['a.b.c', 'app..alice', 'app.-team.alice', 'one.two.three.four.five.six']) assert.throws(() => normalizeName(value, { allowSubnames: true }));
});
test('public records enforce byte limits and unambiguous padded encoding', () => {
  const key = 'address:eip155:8453'; assert.equal(decodeRecordKey(encodeRecordKey(key)), key);
  assert.throws(() => encodeRecordKey('bad key')); assert.throws(() => decodeRecordKey(1n));
  const value = '界'.repeat(82) + 'ab'; const encoded = encodeTextValue(value); assert.equal(encoded.length, 248);
  const words = Array.from({ length: 8 }, (_, i) => packBytes(encoded.bytes.slice(i*31,i*31+31)));
  assert.equal(decodeTextValue(words, 248), value); assert.throws(() => encodeTextValue(value+'c'));
  assert.throws(() => decodeTextValue(words, 247)); assert.throws(() => decodeTextValue([1n<<248n,...words.slice(1)],248));
  assert.throws(() => decodeTextValue([packBytes([255,...new Array(30).fill(0)]),...new Array(7).fill(0n)],1));
  assert.equal(decodeTextValue(new Array(8).fill(0n),0),'');
});
test('chain address records validate identifiers and EVM length without moving funds', () => {
  assert.equal(chainAddressKey('eip155:1'),'address:eip155:1');
  assert.equal(validateChainAddress('eip155:8453','0x'+'ab'.repeat(20)),'0x'+'ab'.repeat(20));
  assert.throws(()=>validateChainAddress('eip155:1','0x123')); assert.throws(()=>chainAddressKey('ethereum'));
});

test('invalid public record keys fail as corrupt data, including malformed UTF-8', () => {
  assert.throws(() => decodeRecordKey(packBytes([255,...new Array<number>(30).fill(0)])), (e: unknown) => e instanceof Error && 'code' in e && e.code === 'corrupt_data');
});
