import assert from 'node:assert/strict';
import { test } from 'node:test';

import { translate, dateLocale } from '../src/i18n.ts';

test('lookup feedback interpolates retry counts and preserves unknown placeholders', () => {
  for (const key of [
    'Retry',
    'Node connected · periodic check',
    'The node temporarily timed out. Automatically retried {count} times. Please try again shortly.',
    'The node is temporarily unavailable. Automatically retried {count} times. Please try again shortly.',
    'Node connection status is checked separately; this lookup failed.',
  ]) {
    assert.equal(translate(key, { count: 3 }), key.replace('{count}', '3'));
    assert.equal(translate(key), key);
  }
  assert.equal(translate(undefined), '');
  assert.equal(translate('{name}: {count} {unknown}', { name: '$&', count: 0 }), '$&: 0 {unknown}');
  assert.equal(dateLocale(), 'en-US');
});

test('English initialization and interpolation work when preference storage is blocked', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage blocked'); },
  });
  try {
    const moduleUrl = new URL('../src/i18n.ts', import.meta.url);
    moduleUrl.searchParams.set('storage', 'blocked');
    const english = await import(moduleUrl.href);
    assert.equal(english.dateLocale(), 'en-US');
    assert.equal(english.translate('Connect wallet'), 'Connect wallet');
    assert.equal(english.activityLabel('Submit registration alice'), 'Submit registration alice');
    assert.equal(english.translate('RPC error 0xabc'), 'RPC error 0xabc');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
