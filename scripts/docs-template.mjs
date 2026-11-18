import assert from 'node:assert/strict';

/** Keep launch instructions consistent with the public template. */
export function assertTemplateAdmin(text, template, label, requireAddress = true) {
  if (!template.admin) return;
  if (requireAddress)
    assert.ok(
      text.includes(template.admin),
      `${label}: must state template admin ${template.admin}`,
    );
  const claims =
    /(?:admin(?:istrator)?(?:\s+and\s+treasury)?|admin\/treasury|treasury)[^\n.;]{0,70}\bnull\b|\bnull\b[^\n.;]{0,50}(?:admin|treasury)/i;
  assert.ok(!claims.test(text), `${label}: must not claim admin/treasury is null`);
}
