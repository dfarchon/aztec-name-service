import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { articles, articleToMarkdown } from '../web/src/docs-content.ts';

const output = process.argv[2] ?? 'web/dist',
  release = process.argv[3] ?? 'local';
const documents = [];
for (const [lang, locale] of ['en', 'zh-CN'].entries()) {
  const directory = join(output, 'downloads/docs', locale);
  mkdirSync(directory, { recursive: true });
  for (const article of articles) {
    const markdown = articleToMarkdown(article, lang);
    writeFileSync(join(directory, `${article.id}.md`), markdown);
    documents.push({
      id: article.id,
      locale,
      title: article.title[lang],
      url: `/downloads/docs/${locale}/${article.id}.md`,
    });
  }
}
writeFileSync(
  join(output, 'downloads/docs/manifest.json'),
  JSON.stringify({ sourceRelease: release, documents }, null, 2) + '\n',
);
writeFileSync(
  join(output, 'llms-full.txt'),
  articles.map((article) => articleToMarkdown(article, 0)).join('\n---\n\n'),
);
console.log(`Exported ${documents.length} Markdown documents from the bilingual content source`);
