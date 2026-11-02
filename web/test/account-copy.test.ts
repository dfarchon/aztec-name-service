import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zhCN } from '../src/locales/zh-CN.ts';

test('account choice and switching prompts have Chinese translations', () => {
  for (const key of [
    'Choose a wallet account',
    'Choose a wallet account to continue.',
    'Choose account',
    'Switching wallet account…',
  ]) {
    assert.ok(zhCN[key], key);
    assert.notEqual(zhCN[key], key);
    assert.deepEqual(zhCN[key].match(/\{\w+\}/g), key.match(/\{\w+\}/g));
  }
});
