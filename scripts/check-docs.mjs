import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolverTrustExample } from '../web/src/docs-examples.ts';
import { articles, articleToMarkdown, sectionsFor, summaries } from '../web/src/docs-content.ts';

const contentText = (value, label) => {
  assert.ok(typeof value === 'string' && value.trim(), label);
  assert.ok(!/\p{Script=Han}/u.test(value), `Non-English content: ${label}`);
  assert.ok(
    !/governance|timelock|schedule_module|schedule_upgrade/i.test(value),
    `Obsolete configuration rule: ${label}`,
  );
};
const ids = new Set();
let snippets = 0;
const destination = process.argv[2];
for (const article of articles) {
  assert.ok(!ids.has(article.id), `Duplicate article: ${article.id}`);
  ids.add(article.id);
  contentText(article.title, article.id);
  assert.ok(summaries[article.id], `Missing article summary: ${article.id}`);
  contentText(summaries[article.id], `${article.id}/summary`);
  assert.ok(
    articleToMarkdown(article).startsWith(`# ${article.title}\n`),
    `Markdown export failed: ${article.id}/en`,
  );
  const sectionIds = new Set();
  for (const section of sectionsFor(article)) {
    assert.ok(!sectionIds.has(section.id), `Duplicate section: ${article.id}/${section.id}`);
    sectionIds.add(section.id);
    contentText(section.title, section.id);
    for (const block of section.blocks) {
      if ('text' in block) contentText(block.text, section.id);
      if ('title' in block) contentText(block.title, section.id);
      if (block.type === 'table') {
        block.headers.forEach((value) => contentText(value, section.id));
        for (const row of block.rows) {
          assert.equal(row.length, block.headers.length, section.id);
          row.forEach((value) => contentText(value, section.id));
        }
      }
      if (block.type === 'steps' || block.type === 'list') {
        block.items.forEach((value) => contentText(value, section.id));
      }
      if (block.type === 'links') {
        for (const link of block.items) {
          contentText(link.title, section.id);
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
assert.ok(
  codeBlocks('README.md').some((block) => block.trim() === resolverTrustExample.trim()),
  'README resolver example must match documentation source',
);
assert.deepEqual(
  codeBlocks('examples/consumer/README.md'),
  codeBlocks('examples/consumer/README.zh-CN.md'),
);
console.log(
  `Checked ${articles.length} English articles and matching README examples; ${snippets} TypeScript snippets${destination ? ' staged for consumer compilation' : ''}`,
);
