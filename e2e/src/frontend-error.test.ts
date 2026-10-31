import assert from 'node:assert/strict';
import test from 'node:test';
import { AnsError } from '@ans/sdk';
import { errorMessage } from '../../web/src/format.js';

test('client setup failures do not imply a mined revert or expose internal field values', () => {
  const failure = errorMessage(new Error("Type 'object' with value 'sensitive-field' passed to BaseField ctor."));
  assert.ok(failure.includes('The action did not complete'));
  assert.ok(!failure.includes('network fees') && !failure.includes('sensitive-field'));
  assert.ok(errorMessage(new AnsError('reverted', 'mined revert')).includes('service fee was reverted'));
  assert.ok(errorMessage(new Error('user rejected')).includes('No service fee was charged'));
  const unavailable = errorMessage(new Error('fetch failed'));
  assert.match(unavailable, /Unable to read.*Try again/);
  assert.doesNotMatch(unavailable, /Available|charged|Transaction reverted/);
});

test('English local-storage and account-switch errors retain recovery instructions', () => {
  for (const message of [
    'Cannot save registration progress. Free up browser storage and retry.',
    'Cannot read wallet encryption settings. Allow browser storage and retry.',
    'Wallet account changed. Try the action again.',
    'Another tab is using the ANS wallet.',
  ]) assert.equal(errorMessage(new Error(message)), message);
});
