import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../src/i18n.ts';
test('resolver recovery guidance renders in English', () => {
  const guidance = 'Use "Use default resolver" first, then set your address and primary name again.';
  assert.equal(translate(guidance), guidance);
  assert.equal(translate('Go to resolver controls'), 'Go to resolver controls');
});
