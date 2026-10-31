import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { getContractClassFromArtifact, getContractInstanceFromInstantiationParams } from '@aztec-labs/stdlib/contract';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { SPONSORED_FPC_SALT } from '@aztec-labs/constants';
import { loadContractArtifact } from '@aztec-labs/stdlib/abi';
import { TokenContract } from '@aztec-labs/noir-contracts.js/Token';
import { SponsoredFPCContractArtifact } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import { FeeJuiceArtifact } from '@aztec-labs/protocol-contracts/fee-juice';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import registryJson from '../src/artifacts/name_registry-NameRegistry.json' with { type: 'json' };

const version = readFileSync(new URL('../../.aztecrc', import.meta.url), 'utf8').trim();
const stdlib = JSON.parse(readFileSync(new URL('../../package.json', import.meta.resolve('@aztec-labs/stdlib/contract')), 'utf8'));
assert.equal(version, stdlib.version, 'Pinned toolchain must match installed stdlib');
const registry = loadContractArtifact(registryJson);
const metadata = {
  version,
  classId: (await getContractClassFromArtifact(registry)).id.toString(),
  storage: Object.fromEntries(Object.entries(registry.storageLayout).map(([k, v]) => [k, v.slot.toString()])),
};
await writeFile(new URL('../src/artifacts/read-metadata.json', import.meta.url), JSON.stringify(metadata, null, 2) + '\n');
const fpc = (await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) })).address;
const publicMetadata = {
  tokenClassId: (await getContractClassFromArtifact(TokenContract.artifact)).id.toString(),
  tokenDecimalsSlot: TokenContract.storage.decimals.slot.toString(),
  tokenSymbolSlot: TokenContract.storage.symbol.slot.toString(),
  fpcAddress: fpc.toString(),
  fpcClassId: (await getContractClassFromArtifact(SponsoredFPCContractArtifact)).id.toString(),
  feeJuice: '0x' + '3'.padStart(64, '0'),
  fpcBalanceSlot: (await deriveStorageSlotInMap(FeeJuiceArtifact.storageLayout.balances.slot, fpc.toField())).toString(),
};
await writeFile(new URL('../../web/src/public-metadata.json', import.meta.url), JSON.stringify(publicMetadata, null, 2) + '\n');
console.log('Generated verified read metadata');

// Pin modular implementations, including the exact class used in the upgrade rehearsal.
const { readFile } = await import('node:fs/promises');
const modular = {};
for (const [key, file] of Object.entries({
  registry: 'name_registry_v3-NameRegistryV3.json',
  extended: 'name_registry_v4-NameRegistryV4.json',
  current: 'name_registry_v5-NameRegistryV5.json',
  v6: 'name_registry_v6-NameRegistryV6.json',
  registrar: 'name_registrar-NameRegistrar.json',
  registrarTiered: 'name_registrar_tiered-NameRegistrarTiered.json', resolver: 'name_resolver-NameResolver.json',
  upgradeTest: 'registry_upgrade_test-RegistryUpgradeTest.json',
})) {
  const artifact = loadContractArtifact(JSON.parse(await readFile(new URL(`../src/artifacts/${file}`, import.meta.url), 'utf8')));
  modular[key] = { classId: (await getContractClassFromArtifact(artifact)).id.toString(),
    storage: Object.fromEntries(Object.entries(artifact.storageLayout).map(([k,v]) => [k,v.slot.toString()])) };
}
for (const key of ['registry', 'config']) if (modular.registrarTiered.storage[key] !== modular.registrar.storage[key]) throw new Error(`Tiered registrar moved slot ${key}`);
if (JSON.stringify(modular.registry.storage) !== JSON.stringify(modular.upgradeTest.storage)) throw new Error('Upgrade rehearsal storage layout differs from V3');
const { validateV3Layout, validateV4Layout, validateV5Layout, validateV6Layout } = await import('./validate-layout.mjs');
await validateV3Layout(modular.registry.storage);
await validateV3Layout(modular.extended.storage, "name_registry_v4");
await validateV4Layout(modular.extended.storage);
await validateV5Layout(modular.current.storage);
// V6 has its own class and frozen layout; V5 identity remains separate.
const v6 = loadContractArtifact(JSON.parse(await readFile(new URL('../src/artifacts/name_registry_v6-NameRegistryV6.json', import.meta.url), 'utf8')));
await validateV6Layout(Object.fromEntries(Object.entries(v6.storageLayout).map(([key, value]) => [key, value.slot.toString()])));
console.log('Validated V3/V4/V5/V6 frozen storage layouts');
for (const [key, slot] of Object.entries(modular.registry.storage)) if (modular.extended.storage[key] !== slot) throw new Error(`V4 moved V3 slot ${key}`);
await writeFile(new URL('../src/artifacts/modular-metadata.json', import.meta.url), JSON.stringify(modular, null, 2) + '\n');
