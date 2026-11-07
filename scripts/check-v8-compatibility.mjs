import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadContractArtifact } from '@aztec-labs/stdlib/abi';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { checkLayout } from '../sdk/scripts/validate-layout.mjs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const canonical = text => text.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
const packages = ['name_registry_v8', 'name_registry_v8_rehearsal'];
const artifacts = packages.map((pkg, index) => JSON.parse(read(`contracts/target/${pkg}-${index ? 'NameRegistryV8Rehearsal' : 'NameRegistryV8'}.json`)));
const prefix = JSON.parse(read('contracts/name_registry_v7/storage-layout.json'));
const common = read('contracts/ans_common/src/types.nr');
for (const [index, pkg] of packages.entries()) {
  const source = read(`contracts/${pkg}/src/main.nr`);
  const types = read(`contracts/${pkg}/src/types.nr`);
  const governance = read(`contracts/${pkg}/src/upgrade_types.nr`) + read(`contracts/${pkg}/src/governance_storage.nr`);
  const artifact = loadContractArtifact(artifacts[index]);
  const storage = Object.fromEntries(Object.entries(artifact.storageLayout).map(([key, value]) => [key, value.slot.toString()]));
  const declarations = source.match(/struct Storage<Context> \{([\s\S]*?)\n    }/)[1];
  checkLayout(prefix, storage, declarations, common + types, 'V8/V7');
  const baseline = JSON.parse(read(`contracts/name_registry_v8/storage-layout.json`));
  checkLayout(baseline, storage, declarations, common + types + governance, pkg);
  assert.deepEqual(storage, baseline.storage, 'successor must have exactly the same layout');
  // Aztec 6 has no artifact.notes property (even Token lacks it). Check actual ABI exports,
  // and combine that bounded artifact assertion with frozen public-only storage/source checks.
  assert.deepEqual(Object.keys(artifact.outputs.structs).sort(), ['events', 'functions'], 'unexpected exported ABI category; review note/type metadata');
  assert.deepEqual(Object.keys(artifact.outputs.globals).sort(), ['storage'], 'unexpected exported globals; review note/type metadata');
  assert(!artifact.functions.some(fn => /note_hash|note_metadata|note_type/.test(fn.name)), 'core exposes no note-related artifact methods');
  assert(!/#\[note\]|note::|emit_note|create_note/.test(source + types + governance), 'core source declares no notes or note operations');
  assert(!/PrivateMutable|PrivateImmutable|PrivateSet|PrivateMap|Owned|Note\b/.test(declarations), 'core has no private storage');
  assert.equal((source.match(/\.update\(/g) ?? []).length, 2, 'only execute and strict cancel update protocol');
  assert(!/\.set_update_delay\(/.test(source));
  assert(source.includes('now + APP_UPGRADE_DELAY'));
  assert(source.includes('now + REQUIRED_PROTOCOL_DELAY'));
}
function functions(source) {
  const clean = source.replace(/\/\/[^\n]*/g, '');
  const found = new Map();
  for (const match of clean.matchAll(/\bfn\s+([a-zA-Z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const start = match.index, brace = clean.indexOf('{', start); let depth = 1, end = brace + 1;
    for (; depth && end < clean.length; end++) { if (clean[end] === '{') depth++; if (clean[end] === '}') depth--; }
    found.set(match[1], canonical(clean.slice(start, end)));
  }
  return found;
}
const originalBusiness = functions(read('contracts/name_registry_v7/src/main.nr'));
const a = read('contracts/name_registry_v8/src/main.nr');
const v8Business = functions(a);
for (const [name, source] of originalBusiness) if (!['constructor', 'nominate_administrator', 'accept_administrator', 'implementation_version'].includes(name)) assert.equal(v8Business.get(name), source, `frozen V7 business function changed: ${name}`);
const b = read('contracts/name_registry_v8_rehearsal/src/main.nr');
assert.equal(a, b.replaceAll('NameRegistryV8Rehearsal', 'NameRegistryV8').replace('RELEASE_SEQ: u32 = 2', 'RELEASE_SEQ: u32 = 1').replace('implementation_version() -> u32 { 8001 }', 'implementation_version() -> u32 { 8 }'), 'only harmless release identifiers may differ');
for (const file of ['types.nr', 'upgrade_types.nr', 'governance_storage.nr']) assert.equal(read(`contracts/name_registry_v8/src/${file}`), read(`contracts/name_registry_v8_rehearsal/src/${file}`));
const pinned = JSON.parse(read('sdk/src/artifacts/modular-metadata.json'));
for (const [key, file] of Object.entries({ registry:'name_registry_v3-NameRegistryV3', extended:'name_registry_v4-NameRegistryV4', current:'name_registry_v5-NameRegistryV5', v6:'name_registry_v6-NameRegistryV6', v7:'name_registry_v7-NameRegistryV7', registrar:'name_registrar-NameRegistrar', registrarTiered:'name_registrar_tiered-NameRegistrarTiered', registrarLaunch:'name_registrar_launch-NameRegistrarLaunch', resolver:'name_resolver-NameResolver', upgradeTest:'registry_upgrade_test-RegistryUpgradeTest' })) {
  const artifact = loadContractArtifact(JSON.parse(read(`contracts/target/${file}.json`)));
  assert.equal((await getContractClassFromArtifact(artifact)).id.toString(), pinned[key].classId, `${key} class ID unchanged`);
}
console.log('V8/V7 prefix, exact V8/successor fields/encodings, no core notes, two protocol update sites and 10 prior modular class IDs checked');
