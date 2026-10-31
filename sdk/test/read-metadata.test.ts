import assert from 'node:assert/strict';
import test from 'node:test';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { NameRegistryContract } from '../src/artifacts/NameRegistry.js';
import metadata from '../src/artifacts/read-metadata.json' with { type: 'json' };

test('the lightweight reader pins the exact generated class and storage layout', async () => {
  assert.equal(metadata.classId, (await getContractClassFromArtifact(NameRegistryContract.artifact)).id.toString());
  assert.deepEqual(metadata.storage, Object.fromEntries(Object.entries(NameRegistryContract.storage).map(([k, v]) => [k, v.slot.toString()])));
});


test('lightweight reader rejects a wrong class before exposing storage', async () => {
  const { RegistryReader } = await import('../src/client/reader.js');
  const { AztecAddress } = await import('@aztec-labs/aztec.js/addresses');
  const { Fr } = await import('@aztec-labs/aztec.js/fields');
  let storageReads = 0;
  const node = {
    getNodeInfo: async () => ({ l1ChainId: 11155111, rollupVersion: 1821665230 }),
    getContract: async () => ({ currentContractClassId: Fr.ZERO }),
    getPublicStorageAt: async () => { storageReads++; return Fr.ZERO; },
  } as any;
  await assert.rejects(RegistryReader.connect(node, AztecAddress.fromBigIntUnsafe(1n)), (e: any) => e.code === 'wrong_deployment');
  assert.equal(storageReads, 0);
});


test('token precision and sponsor balance layout match the installed 6.0.0 artifacts', async () => {
  const { TokenContract } = await import('@aztec-labs/noir-contracts.js/Token');
  const { SponsoredFPCContractArtifact } = await import('@aztec-labs/noir-contracts.js/SponsoredFPC');
  const { FeeJuiceArtifact } = await import('@aztec-labs/protocol-contracts/fee-juice');
  const { AztecAddress } = await import('@aztec-labs/aztec.js/addresses');
  const { deriveStorageSlotInMap } = await import('@aztec-labs/stdlib/hash');
  const { default: publicMetadata } = await import('../../web/src/public-metadata.json', { with: { type: 'json' } });
  assert.equal(publicMetadata.tokenClassId, (await getContractClassFromArtifact(TokenContract.artifact)).id.toString());
  assert.equal(publicMetadata.tokenDecimalsSlot, TokenContract.storage.decimals.slot.toString());
  assert.equal(publicMetadata.tokenSymbolSlot, TokenContract.storage.symbol.slot.toString());
  assert.equal(publicMetadata.fpcClassId, (await getContractClassFromArtifact(SponsoredFPCContractArtifact)).id.toString());
  assert.equal(publicMetadata.fpcBalanceSlot, (await deriveStorageSlotInMap(FeeJuiceArtifact.storageLayout.balances.slot, AztecAddress.fromStringUnsafe(publicMetadata.fpcAddress).toField())).toString());
});
