import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTemplateAdmin } from './docs-template.mjs';
const template = { admin: '0x2419' };
test('launch docs require the template admin and reject stale bilingual null claims', () => {
  assert.doesNotThrow(() =>
    assertTemplateAdmin(
      'Admin 0x2419 offline-generated, never deployed; replace with multisig',
      template,
      'docs',
    ),
  );
  assert.throws(() => assertTemplateAdmin('Admin placeholder', template, 'docs'), /must state/);
  for (const claim of [
    'Admin and treasury remain null',
    '管理员和 treasury 暂为 null',
    'null admin/treasury',
    'null 的 admin/treasury',
  ])
    assert.throws(() => assertTemplateAdmin(`0x2419 ${claim}`, template, 'docs'), /must not claim/);
  assert.doesNotThrow(() => assertTemplateAdmin('Admin null', { admin: null }, 'docs'));
  assert.doesNotThrow(() => assertTemplateAdmin('Other documentation', template, 'other', false));
  assert.throws(
    () => assertTemplateAdmin('Admin null', template, 'other', false),
    /must not claim/,
  );
});
