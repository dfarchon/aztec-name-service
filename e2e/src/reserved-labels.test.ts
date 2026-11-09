import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadReservedList, canonicalReservedLabels, reservedListHash, reservedBatches } from './launch-policy.js';
const list = JSON.parse(readFileSync(new URL('../../deployments/reserved-labels.json', import.meta.url), 'utf8'));
const baselineV2 = JSON.parse(readFileSync(new URL('./fixtures/reserved-labels-v2.json', import.meta.url), 'utf8'));
const baseline = JSON.parse(readFileSync(new URL('./fixtures/reserved-labels-v1.json', import.meta.url), 'utf8'));
const object = (categories: unknown, minLength = 7) => ({ schema: 'ans-reserved-labels/1', minLength, categories });
test('reserved content policy v2 pins 276 legal labels and its canonical hash independently of category order', () => {
  const list = baselineV2;
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
  const list = baselineV2;
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
  const list = baselineV2;
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

test('v3 retains exact v2 categories and adds 49 canonical source-mapped corporate identities', () => {
  const labels = loadReservedList(list);
  const previous = loadReservedList(baselineV2);
  assert.equal(list.minLength, 7);
  assert.equal(labels.length, 325);
  assert.equal(new Set(labels).size, 325);
  assert.equal(reservedListHash(list), '743b1b4c3ab4762cb2d12662765406fdf91971845a5ec6137b1f7444223657fa');
  for (const [category, values] of Object.entries(baselineV2.categories)) {
    assert.deepEqual(list.categories[category], values, category);
  }
  const expected = {
    corporate: ['apple-support', 'apple-official', 'apple-wallet', 'apple-pay', 'google-support', 'google-official', 'google-wallet', 'youtube', 'youtube-support', 'android-support', 'microsoft', 'microsoft-support', 'microsoft-windows', 'windows-support', 'amazon-support', 'amazon-official', 'amazon-web-services', 'prime-video', 'meta-support', 'meta-official', 'nvidia-support', 'nvidia-official', 'samsung', 'samsung-support', 'sony-support', 'playstation', 'playstation-support'],
    ai: ['openai-support', 'openai-official', 'chatgpt', 'chatgpt-support', 'anthropic', 'anthropic-support', 'claude-support'],
    payments: ['paypal-support', 'paypal-official', 'stripe-support', 'stripe-official', 'visa-support', 'visa-official'],
    consumer: ['nike-official', 'coca-cola', 'coca-cola-official', 'starbucks', 'starbucks-official', 'mcdonalds', 'mcdonalds-official', 'walmart', 'walmart-support'],
  };
  assert.deepEqual(Object.keys(list.categories), [...Object.keys(baselineV2.categories), ...Object.keys(expected)]);
  for (const [category, values] of Object.entries(expected)) assert.deepEqual(list.categories[category], values);
  const added = labels.filter(label => !previous.includes(label));
  assert.equal(added.length, 49);
  assert.deepEqual(loadReservedList(object(expected)), added);
  assert.equal(reservedListHash(object(Object.fromEntries(Object.entries(list.categories).reverse()))), reservedListHash(list));
  for (const excluded of ['apple', 'google', 'amazon', 'meta', 'nvidia', 'sony', 'openai', 'claude', 'paypal', 'stripe', 'visa', 'nike', 'aws', 'windows', 'android', 'mastercard']) assert(!added.includes(excluded), excluded);
});
test('full v3 deployment plans eleven batches with 27 final zero slots', async () => {
  const { deploymentTransactionSteps } = await import('./deploy-v6-plan.js');
  const labels = loadReservedList(list);
  const steps = deploymentTransactionSteps({ registrar: 'launch', token: 'none', reservedLabels: labels });
  assert.deepEqual(steps.filter(step => step.startsWith('seed-reserved-')), Array.from({ length: 11 }, (_, i) => `seed-reserved-${i}`));
  const nodes = labels.map((_, i) => BigInt(i + 1));
  const batches = reservedBatches(nodes);
  assert.equal(batches.length, 11);
  assert(batches.every(batch => batch.length === 32));
  assert.deepEqual(batches.flat().filter(node => node !== 0n), nodes);
  assert.equal(batches[10].filter(node => node === 0n).length, 27);
  const template = JSON.parse(readFileSync(new URL('../../deployments/mainnet.template.json', import.meta.url), 'utf8'));
  assert.equal(template.minPublicLength, 7);
});
