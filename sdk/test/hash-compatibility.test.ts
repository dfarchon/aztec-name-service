import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainSeparator } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import { hashWithSeparator } from '../src/core/hash.js';
import { DOMAIN } from '../src/core/constants.js';

test('lightweight hashing matches pinned Aztec across domains and sponge boundaries', async () => {
  const domains = [...Object.values(DOMAIN), BigInt(DomainSeparator.PUBLIC_STORAGE_MAP_SLOT)];
  for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 16, 31, 32, 64]) {
    for (const separator of domains) {
      for (const edge of [false, true]) {
        const input = Array.from({ length }, (_, i) => edge ? Fr.MODULUS - 1n : BigInt(i + 1) ** 17n);
        const expected = await poseidon2Hash([new Fr(separator), ...input.map(v => new Fr(v))]);
        assert.equal(await hashWithSeparator(input, separator), expected.toBigInt(), `${length}:${separator}:${edge}`);
      }
    }
  }
});

test('map slots match the pinned Aztec storage derivation', async () => {
  for (let i = 0; i < 32; i++) {
    const slot = new Fr(BigInt(i + 1));
    const key = new Fr(i === 0 ? Fr.MODULUS - 1n : BigInt(i) ** 23n);
    assert.equal(
      await hashWithSeparator([slot.toBigInt(), key.toBigInt()], BigInt(DomainSeparator.PUBLIC_STORAGE_MAP_SLOT)),
      (await deriveStorageSlotInMap(slot, key)).toBigInt(),
    );
  }
});

test('lightweight hashing preserves field range rejection', async () => {
  await assert.rejects(hashWithSeparator([Fr.MODULUS], DOMAIN.LABEL_V1));
  await assert.rejects(hashWithSeparator([-1n], DOMAIN.LABEL_V1));
  await assert.rejects(hashWithSeparator([], Fr.MODULUS));
  assert.equal(await hashWithSeparator([true, false, 1], DOMAIN.LABEL_V1), await hashWithSeparator([1n, 0n, 1n], DOMAIN.LABEL_V1));
});
