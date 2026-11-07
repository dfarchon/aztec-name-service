import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadReservedList, canonicalReservedLabels, reservedListHash, reservedBatches } from './launch-policy.js';
const list = JSON.parse(readFileSync(new URL('../../deployments/reserved-labels.json', import.meta.url), 'utf8'));
const baseline = JSON.parse(readFileSync(new URL('./fixtures/reserved-labels-v1.json', import.meta.url), 'utf8'));
const object = (categories: unknown, minLength = 7) => ({ schema: 'ans-reserved-labels/1', minLength, categories });
test('reserved content policy v2 pins 276 legal labels and its canonical hash independently of category order', () => {
  const labels = loadReservedList(list);
  assert.equal(labels.length, 276);
  assert.equal(list.schema, 'ans-reserved-labels/1');
  assert.deepEqual(Object.fromEntries(Object.entries(list.categories).map(([category, values]) => [category, (values as string[]).length])), { aztec: 72, ans: 24, system: 57, ecosystem: 103, noir: 20 });
  assert(labels.every(label => label.length >= 7 && label.length <= 31));
  assert.equal(reservedListHash(list), 'b6d4e77d1cdc119abfec4f0060fd7235463e8ed7d85ce5e8b3e07c8bea42b147');
  assert.deepEqual(labels, canonicalReservedLabels(labels));
  assert.equal(reservedListHash(object(Object.fromEntries(Object.entries(list.categories).reverse()))), reservedListHash(list));
  assert.equal(reservedListHash([]), '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
});
test('content policy v2 retains every original v1 label in its original category', () => {
  const oldLabels = loadReservedList(baseline);
  assert.equal(oldLabels.length, 195);
  assert.equal(reservedListHash(baseline), 'd3b5a6f138526e410311b4577f41bdcab0d24186405f4c51841f2906551028aa');
  const labels = new Set(loadReservedList(list));
  for (const [category, values] of Object.entries(baseline.categories)) {
    for (const label of values as string[]) {
      assert(labels.has(label), label);
      assert(list.categories[category].includes(label), `${category}/${label}`);
    }
  }
  assert.equal([...labels].filter(label => !oldLabels.includes(label)).length, 81);
});
test('full content policy v2 plans nine seed transactions and pads only the last batch', async () => {
  const { deploymentTransactionSteps } = await import('./deploy-v6-plan.js');
  const labels = loadReservedList(list);
  const steps = deploymentTransactionSteps({ registrar: 'launch', token: 'none', reservedLabels: labels });
  assert.deepEqual(steps.filter(step => step.startsWith('seed-reserved-')), Array.from({ length: 9 }, (_, i) => `seed-reserved-${i}`));
  const nodes = labels.map((_, i) => BigInt(i + 1));
  const batches = reservedBatches(nodes);
  assert.equal(batches.length, 9);
  assert(batches.every(batch => batch.length === 32));
  assert.deepEqual(batches.flat().filter(node => node !== 0n), nodes);
  assert.equal(batches[8].filter(node => node === 0n).length, 12);
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

test('canonical reserved policy matches the mainnet template pin', () => {
  const template = JSON.parse(readFileSync(new URL('../../deployments/mainnet.template.json', import.meta.url), 'utf8'));
  assert.equal(template.reservedListHash, reservedListHash(list));
});
test('lowercase noir category accepts all new S3 labels and preserves category boundaries', () => {
  assert.equal(loadReservedList(object({ noir: list.categories.noir })).length, 20);
  assert(list.categories.noir.every((label: string) => !list.categories.aztec.includes(label)));
  assert(list.categories.ecosystem.includes('darkforest'));
  assert(list.categories.ecosystem.includes('dark-forest'));
  assert(list.categories.aztec.includes('dark-forest-aztec'));
  assert(!loadReservedList(list).includes('nyx-money'));
  assert(!loadReservedList(list).includes('train-bridge'));
});
