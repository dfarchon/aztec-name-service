import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { check, format, resolveConfig } from 'prettier';

// Keep generated artifacts and unrelated source outside this migration.
const files = [
  '.prettierrc.json',
  'scripts/format-integration.mjs',
  'scripts/check-docs.mjs',
  'scripts/check-consumer.mjs',
  'scripts/bundle-budget.test.ts',
  'scripts/export-docs.mjs',
  'scripts/deployment-config.mjs',
  'scripts/deployment-config.test.mjs',
  'scripts/testnet-security.mjs',
  'scripts/testnet-security.test.mjs',
  'web/scripts/security-smoke.mjs',
  'sdk/test/v6-artifact.test.ts',
  'web/src/docs-content.ts',
  'web/src/docs-examples.ts',
  'web/src/SdkDownloads.tsx',
  ...readdirSync('examples/consumer', { recursive: true })
    .filter((path) => /\.(ts|html|md)$/.test(path))
    .map((path) => `examples/consumer/${path}`),
];
const write = process.argv.includes('--write');
let failed = false;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const options = { ...(await resolveConfig(file)), filepath: file };
  if (write) writeFileSync(file, await format(source, options));
  else if (!(await check(source, options))) {
    console.error(`Formatting required: ${file}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else
  console.log(
    `${write ? 'Formatted' : 'Checked formatting for'} ${files.length} integration files`,
  );
