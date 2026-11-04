// Keep each supported deployment's artifact and generated wrapper together.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath } from '../../scripts/check-brillig-baseline.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../src/artifacts');
const contracts = [
  ['name_registry', 'NameRegistry'], ['name_registry_v3', 'NameRegistryV3'],
  ['name_registrar', 'NameRegistrar'], ['name_resolver', 'NameResolver'],
  ['registry_upgrade_test', 'RegistryUpgradeTest'], ['name_registry_v4', 'NameRegistryV4'],
  ['name_registry_v5', 'NameRegistryV5'],
  ['name_registry_v6', 'NameRegistryV6'],
  ['name_registry_v7', 'NameRegistryV7'],
  ['name_registrar_tiered', 'NameRegistrarTiered'],
  ['name_registrar_launch', 'NameRegistrarLaunch'],
];
// A failed bb postprocess can leave `transpiled: true` before it writes verification keys.
// Validate every input before touching any checked-in artifact or wrapper.
for (const [pkg, name] of contracts) {
  const src = join(here, '../../contracts/target', `${pkg}-${name}.json`);
  if (!existsSync(src)) throw new Error(`missing ${src}; run npm run build:contracts first`);
  const artifact = JSON.parse(readFileSync(src, 'utf8'));
  const missingKeys = artifact.functions.filter(fn =>
    fn.custom_attributes?.includes('abi_private') && !fn.verification_key);
  if (!artifact.transpiled || missingKeys.length)
    throw new Error(`incomplete ${src}: postprocessing/verification keys missing; finish npm run build:contracts before generation`);
}
for (const [pkg, name] of contracts) {
  const file = `${pkg}-${name}.json`;
  const src = join(here, '../../contracts/target', file);
  if (!existsSync(src)) throw new Error(`missing ${src}; run npm run build:contracts first`);
  // Debug file maps carry the compiler machine's absolute paths; keep only repository/dependency-relative paths.
  // Class IDs do not depend on these fields.
  const artifact = JSON.parse(readFileSync(src, 'utf8'));
  for (const entry of Object.values(artifact.file_map ?? {})) entry.path = normalizePath(entry.path);
  writeFileSync(join(outDir, file), JSON.stringify(artifact, null, 2) + '\n');
  execFileSync(process.execPath, [join(here, '../../scripts/aztec.mjs'), 'codegen', join(outDir, file), '-o', outDir, '-f'], { stdio: 'inherit' });
  const wrapper = join(outDir, `${name}.ts`);
  writeFileSync(wrapper, readFileSync(wrapper, 'utf8').replace(/[ \t]+$/gm, ''));
}
await import('./read-metadata.mjs');
