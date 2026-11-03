import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/i18n.ts';

test('account choice and switching prompts remain readable in English', () => {
  for (const key of [
    'Choose a wallet account',
    'Choose a wallet account to continue.',
    'Choose account',
    'Switching wallet account…',
  ]) {
    assert.equal(translate(key), key);
  }
});
