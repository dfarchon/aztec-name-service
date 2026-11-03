import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { articles, articleToMarkdown } from '../web/src/docs-content.ts';

const output = process.argv[2] ?? 'web/dist',
  release = process.argv[3] ?? 'local';
const documents = [];
const directory = join(output, 'downloads/docs/en');
mkdirSync(directory, { recursive: true });
for (const article of articles) {
  const markdown = articleToMarkdown(article);
  writeFileSync(join(directory, `${article.id}.md`), markdown);
  documents.push({
    id: article.id,
    locale: 'en',
    title: article.title,
    url: `/downloads/docs/en/${article.id}.md`,
  });
}
writeFileSync(
  join(output, 'downloads/docs/manifest.json'),
  JSON.stringify({ sourceRelease: release, documents }, null, 2) + '\n',
);
writeFileSync(
  join(output, 'llms-full.txt'),
  articles.map((article) => articleToMarkdown(article)).join('\n---\n\n'),
);
console.log(`Exported ${documents.length} Markdown documents from the English content source`);
