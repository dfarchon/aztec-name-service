import assert from 'node:assert/strict';
import { test } from 'node:test';

test('lookup error feedback and node status have matching Chinese placeholders', async () => {
  const { zhCN } = await import('../src/locales/zh-CN.ts');
  for (const key of [
    'Retry',
    'Node connected · periodic check',
    'The node temporarily timed out. Automatically retried {count} times. Please try again shortly.',
    'The node is temporarily unavailable. Automatically retried {count} times. Please try again shortly.',
    'Node connection status is checked separately; this lookup failed.',
  ]) {
    assert.ok(zhCN[key], key);
    assert.deepEqual(zhCN[key].match(/\{\w+\}/g), key.match(/\{\w+\}/g));
  }
});
