import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renewalWindowHint } from '../src/i18n.ts';
test('renewal horizon copy uses chain seconds and has matching English/Chinese values', () => {
  assert.equal(renewalWindowHint(31536000n), 'Renewal opens 1 year before expiry');
  assert.equal(renewalWindowHint(31536000n, 'zh'), '到期前 1 年内可续期');
  assert.equal(renewalWindowHint(63072000n), 'Renewal opens 2 years before expiry');
  assert.equal(renewalWindowHint(86400n), 'Renewal opens 1 day before expiry');
  assert.equal(renewalWindowHint(60n), 'Renewal opens 60 seconds before expiry');
  assert.equal(renewalWindowHint(0n), '');
});
