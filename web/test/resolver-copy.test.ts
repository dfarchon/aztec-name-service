import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../src/i18n.ts';
test('resolver recovery guidance has English defaults and Chinese entries', () => {
  const guidance = 'Use "Use default resolver" first, then set your address and primary name again.';
  assert.equal(translate(guidance), guidance);
  assert.equal(translate(guidance, {}, 'zh'), '请先点击“使用默认解析器”，然后重新设置地址和主名称。');
  assert.equal(translate('Go to resolver controls', {}, 'zh'), '前往解析器设置');
  assert.equal(translate('Go to resolver controls'), 'Go to resolver controls');
});
