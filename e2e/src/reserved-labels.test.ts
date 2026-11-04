import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadReservedList, canonicalReservedLabels, reservedListHash } from './launch-policy.js';
const list = JSON.parse(readFileSync(new URL('../../deployments/reserved-labels.json', import.meta.url), 'utf8'));
const object = (categories: unknown, minLength = 7) => ({ schema: 'ans-reserved-labels/1', minLength, categories });
test('reserved v1 file pins 195 legal labels and its canonical hash independently of category order', () => {
  const labels = loadReservedList(list);
  assert.equal(labels.length, 195); assert(labels.length >= 100 && labels.length <= 200);
  assert(labels.every(label => label.length >= 7 && label.length <= 31));
  assert.equal(reservedListHash(list), 'd3b5a6f138526e410311b4577f41bdcab0d24186405f4c51841f2906551028aa');
  assert.deepEqual(labels, canonicalReservedLabels(labels));
  assert.equal(reservedListHash(object(Object.fromEntries(Object.entries(list.categories).reverse()))), reservedListHash(list));
  assert.equal(reservedListHash([]), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
});
for (const value of [
  ['short'], ['sixsix'], ['invalid--label'], ['0x1234567'], ['-invalid'], ['invalid-'], ['Uppercase'], ['sub.name'], ['invalid_name'], ['x'.repeat(32)], [123],
  object({ first: ['reserved'], second: ['reserved'] }), object({ First: ['reserved'] }), object({ 'bad_name': ['reserved'] }), object({ first: [] }), object({}),
  object([]), object({ first: ['reserved'] }, 32), object({ first: ['reserved'] }, -1), object({ first: ['reserved'] }, 7.5),
  { ...object({ first: ['reserved'] }), schema: 'ans-reserved-labels/2' },
]) {
  test(`reserved loader rejects invalid input ${JSON.stringify(value)}`, () => assert.throws(() => loadReservedList(value)));
}
test('a lower declared minimum cannot reopen short public labels and a higher minimum is enforced', () => {
  assert.throws(() => loadReservedList(object({ first: ['short'] }, 3)));
  assert.throws(() => loadReservedList(object({ first: ['reserve'] }, 8)));
  assert.deepEqual(loadReservedList(['reserved']), ['reserved']);
});
