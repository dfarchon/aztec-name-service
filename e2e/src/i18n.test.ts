import assert from 'node:assert/strict';
import test from 'node:test';
import { activityLabel, dateLocale, translate } from '../../web/src/i18n.js';
import { date, duration, errorMessage } from '../../web/src/format.js';
import { leaseText } from '../../web/src/usability.js';

test('English is the default and unknown technical details retain their original value', () => {
  assert.equal(dateLocale(), 'en-US');
  assert.equal(translate('Connect wallet'), 'Connect wallet');
  assert.equal(translate('RPC error 0xabc'), 'RPC error 0xabc');
});

test('English errors, dates and lease durations preserve user values', () => {
  assert.equal(translate('Connect wallet'), 'Connect wallet');
  assert.equal(translate('Submit registration {name}', { name: 'Search' }), 'Submit registration Search');
  assert.equal(activityLabel('Submit registration alice'), 'Submit registration alice');
  assert.equal(translate(errorMessage(new Error('Cannot save registration progress. Free up browser storage and retry.'))), 'Cannot save registration progress. Free up browser storage and retry.');
  assert.equal(dateLocale(), 'en-US');
  assert.equal(date(1000000000n), new Date(1000000000000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }));
  assert.equal(duration(61n), '2 min');
  assert.equal(leaseText(86401n, 1000), '1 day left');
  assert.equal(translate('RPC error 0xabc'), 'RPC error 0xabc');
});

test('blocked storage does not prevent English formatting', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Storage blocked'); } });
  try {
    assert.equal(translate('Connect wallet'), 'Connect wallet');
    assert.equal(dateLocale(), 'en-US');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
