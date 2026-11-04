import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RegistrationCheck, RegistrationPlan } from '@ans/sdk';
import { canDiscardUncertain, parseTxHash } from '../src/registration-recovery.ts';

const plan = { quoteExpiry: 1000n } as RegistrationPlan;
const check = (timestamp: bigint, state = 'quote_expired', finality = 'checkpointed') =>
  ({ state, snapshot: { timestamp, finality } }) as RegistrationCheck;

test('transaction hash parsing normalizes valid hashes and trims whitespace', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  assert.equal(parseTxHash(hash), hash);
  assert.equal(parseTxHash(`  0x${'AB'.repeat(32)} \n`), hash);
});

test('transaction hash parsing rejects missing prefix, wrong lengths and non-hex', () => {
  for (const input of ['ab'.repeat(32), `0x${'a'.repeat(63)}`, `0x${'a'.repeat(65)}`, `0x${'g'.repeat(64)}`, ''])
    assert.equal(parseTxHash(input), undefined);
});

test('uncertain removal needs an unconsumed checkpoint strictly after quote expiry and no reveal hash', () => {
  assert.equal(canDiscardUncertain(plan, undefined), false);
  assert.equal(canDiscardUncertain(plan, check(1001n, 'registered')), false);
  assert.equal(canDiscardUncertain(plan, check(999n)), false);
  assert.equal(canDiscardUncertain(plan, check(1000n)), false);
  assert.equal(canDiscardUncertain(plan, check(1001n)), true);
  assert.equal(canDiscardUncertain(plan, check(1001n, 'quote_expired', 'proposed')), false);
  assert.equal(canDiscardUncertain({ ...plan, registerTx: `0x${'a'.repeat(64)}` }, check(1001n)), false);
});
