import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { aztecPriceForYears, createAztecPricingPlan, validateAztecPricing } from './aztec-pricing.mjs';
const policy = JSON.parse(readFileSync(new URL('../deployments/aztec-pricing.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(policy);

test('AZTEC prices use 18-decimal base units for one to five years', () => {
  assert.equal(aztecPriceForYears(policy, 1), 10n ** 18n);
  assert.equal(aztecPriceForYears(policy, 5), 5n * 10n ** 18n);
  for (const years of [0, 6, 1.5, NaN]) assert.throws(() => aztecPriceForYears(policy, years));
});
test('shorter names cost more: 128 / 32 / 1 AZTEC per year by length', () => {
  assert.equal(aztecPriceForYears(policy, 1, 3), 128n * 10n ** 18n);
  assert.equal(aztecPriceForYears(policy, 2, 4), 64n * 10n ** 18n);
  assert.equal(aztecPriceForYears(policy, 1, 5), 10n ** 18n);
  assert.equal(aztecPriceForYears(policy, 1, 31), 10n ** 18n);
  for (const length of [2, 32, 3.5]) assert.throws(() => aztecPriceForYears(policy, 1, length));
  const inverted = copy(); inverted.lengthPrices['4'] = inverted.lengthPrices['3'] + '0'; assert.throws(() => validateAztecPricing(inverted));
  const belowBase = copy(); belowBase.lengthPrices['4'] = '1'; assert.throws(() => validateAztecPricing(belowBase));
  const missing = copy(); delete missing.lengthPrices; assert.throws(() => validateAztecPricing(missing));
  assert.deepEqual(createAztecPricingPlan(policy, { registry: 'r', treasury: 't', annualPrice: '1', priceVersion: 2 }).replacementRegistrar.lengthPrices, policy.lengthPrices);
});
test('official asset identity cannot be replaced by a ticker or test-token metadata', () => {
  const decimals = copy(); decimals.decimals = 6; assert.throws(() => validateAztecPricing(decimals));
  const address = copy(); address.referenceAsset.address = '0x' + '1'.repeat(40); assert.throws(() => validateAztecPricing(address));
  const chain = copy(); chain.referenceAsset.chainId = '11155111'; assert.throws(() => validateAztecPricing(chain));
  const amount = copy(); amount.annualPrice = Number(10n ** 18n); assert.throws(() => validateAztecPricing(amount));
  const overflow = copy(); overflow.annualPrice = String(2n ** 96n + 1n); assert.throws(() => validateAztecPricing(overflow));
});
test('Fee Juice, a padded L1 address and a same-symbol L2 token cannot activate settlement', () => {
  for (const token of ['0x' + '0'.repeat(63) + '3', '0x' + '0'.repeat(24) + policy.referenceAsset.address.slice(2), '0x' + '1'.repeat(64)]) {
    const unverified = copy(); unverified.settlement = { status: 'active', l2Token: token };
    assert.throws(() => validateAztecPricing(unverified));
  }
});
test('preparation preserves current fees and emits a blocked replacement without deployable token args', () => {
  const active = { registry: 'registry', registrar: 'registrar', feeToken: 'ANSF', treasury: 'treasury', annualPrice: '1000000', priceVersion: 1 };
  const report = createAztecPricingPlan(policy, active);
  assert.equal(report.readyForDeployment, false);
  assert.equal(report.replacementRegistrar.feeToken, null);
  assert.equal(report.replacementRegistrar.annualPrice, String(10n ** 18n));
  assert.equal(report.replacementRegistrar.priceVersion, 2);
  assert.equal(report.currentOnChain.annualPrice, '1000000');
  assert.equal(report.broadcastTransactions, 0);
});
