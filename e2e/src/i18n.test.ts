import assert from 'node:assert/strict';
import test from 'node:test';
import { activityLabel, dateLocale, getLocale, setLocale, subscribeLocale, translate } from '../../web/src/i18n.js';
import { date, duration, errorMessage } from '../../web/src/format.js';
import { leaseText } from '../../web/src/usability.js';

test('English is the default and unknown technical details retain their original value', () => {
  assert.equal(getLocale(), 'en');
  assert.equal(translate('Connect wallet'), 'Connect wallet');
  assert.equal(translate('RPC error 0xabc'), 'RPC error 0xabc');
});

test('locale changes translate errors, dates and lease durations without translating user values', () => {
  try {
    setLocale('zh-CN');
    assert.equal(translate('Connect wallet'), '连接钱包');
    assert.equal(translate('Submit registration {name}', { name: 'Search' }), '提交注册 Search');
    assert.equal(activityLabel('Submit registration alice'), '提交注册 alice');
    assert.equal(translate(errorMessage(new Error('Cannot save registration progress. Free up browser storage and retry.'))), '无法保存注册进度；请释放浏览器存储空间后重试');
    assert.equal(dateLocale(), 'zh-CN');
    assert.equal(date(1000000000n), new Date(1000000000000).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }));
    assert.equal(duration(61n), '2 分钟');
    assert.equal(leaseText(86401n, 1000), '剩余 1 天');
    assert.equal(translate('RPC error 0xabc'), 'RPC error 0xabc');
  } finally { setLocale('en'); }
  assert.equal(leaseText(86401n, 1000), '1 day left');
});

test('blocked storage does not prevent switching and unsubscribed listeners are removed', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('Storage blocked'); } });
  let renders = 0;
  const unsubscribe = subscribeLocale(() => renders++);
  try {
    setLocale('zh-CN');
    assert.equal(getLocale(), 'zh-CN');
    assert.equal(renders, 1);
    unsubscribe();
    setLocale('en');
    assert.equal(renders, 1);
  } finally {
    unsubscribe();
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    setLocale('en');
  }
});
