import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { articles, articleToMarkdown, sectionsFor, summaries } from '../web/src/docs-content.ts';

const locales = ['en', 'zh-CN'];
const localized = (value, label) => {
  assert.equal(value.length, locales.length, label);
  for (const text of value) assert.ok(typeof text === 'string' && text.trim(), label);
  for (const text of value)
    assert.ok(
      !/governance|治理|timelock|schedule_module|schedule_upgrade/i.test(text),
      `Obsolete configuration rule: ${label}`,
    );
};
const ids = new Set();
let snippets = 0;
const destination = process.argv[2];
for (const article of articles) {
  assert.ok(!ids.has(article.id), `Duplicate article: ${article.id}`);
  ids.add(article.id);
  localized(article.title, article.id);
  assert.ok(summaries[article.id], `Missing article summary: ${article.id}`);
  localized(summaries[article.id], `${article.id}/summary`);
  for (const lang of [0, 1])
    assert.ok(
      articleToMarkdown(article, lang).startsWith(`# ${article.title[lang]}\n`),
      `Markdown export failed: ${article.id}/${locales[lang]}`,
    );
  const sectionIds = new Set();
  for (const section of sectionsFor(article)) {
    assert.ok(!sectionIds.has(section.id), `Duplicate section: ${article.id}/${section.id}`);
    sectionIds.add(section.id);
    localized(section.title, section.id);
    for (const block of section.blocks) {
      if ('text' in block) localized(block.text, section.id);
      if ('title' in block) localized(block.title, section.id);
      if (block.type === 'table') {
        block.headers.forEach((value) => localized(value, section.id));
        for (const row of block.rows) {
          assert.equal(row.length, block.headers.length, section.id);
          row.forEach((value) => localized(value, section.id));
        }
      }
      if (block.type === 'steps' || block.type === 'list') {
        block.items.forEach((value) => localized(value, section.id));
      }
      if (block.type === 'links') {
        for (const link of block.items) {
          localized(link.title, section.id);
          if (link.href.startsWith('#/docs/')) {
            assert.ok(
              articles.some((target) => `#/docs/${target.id}` === link.href),
              link.href,
            );
          }
        }
      }
      if (article.group === 'developer' && block.type === 'code') {
        assert.equal(block.language, 'typescript');
        if (destination)
          writeFileSync(join(destination, `docs-example-${snippets}.ts`), block.value);
        snippets++;
      }
    }
  }
}
const codeBlocks = (path) =>
  [...readFileSync(path, 'utf8').matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
assert.deepEqual(
  codeBlocks('examples/consumer/README.md'),
  codeBlocks('examples/consumer/README.zh-CN.md'),
);
console.log(
  `Checked ${articles.length} bilingual articles and matching README examples; ${snippets} TypeScript snippets${destination ? ' staged for consumer compilation' : ''}`,
);
