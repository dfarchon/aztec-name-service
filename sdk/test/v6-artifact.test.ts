import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registryProtocol, registryProtocols } from '../src/core/registry-protocol.js';
import { AnsContext } from '../src/wallet/context.js';
import type { RegistryReader } from '../src/client/reader.js';
import { NameRegistryV6Contract } from '../src/artifacts/NameRegistryV6.js';
import metadata from '../src/artifacts/modular-metadata.json' with { type: 'json' };
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
// @ts-expect-error Build helper is intentionally outside the published SDK.
import { validateV6Layout } from '../scripts/validate-layout.mjs';

test('V6 generated bindings expose the two-step administration API and preserve its frozen layout', async () => {
  const artifact = NameRegistryV6Contract.artifact;
  const contract = NameRegistryV6Contract.at(AztecAddress.fromBigIntUnsafe(1n), {} as Wallet);
  const names = new Set(Object.keys(contract.methods));
  for (const name of [
    'nominate_administrator',
    'accept_administrator',
    'get_administrator',
    'get_pending_administrator',
  ])
    assert.ok(names.has(name), name);
  assert.ok(!names.has('set_administrator'));
  const storage = Object.fromEntries(
    Object.entries(artifact.storageLayout).map(([key, value]) => [key, value.slot.toString()]),
  );
  await validateV6Layout(storage);
  await assert.rejects(
    validateV6Layout({ ...storage, pending_administrator: '0x99' }),
    /slot changed/,
  );
});

test('V6 is recognized separately from the recompiled V5 implementation', async () => {
  const v6 = (await getContractClassFromArtifact(NameRegistryV6Contract.artifact)).id.toString();
  assert.notEqual(metadata.current.classId, v6);
  assert.equal(registryProtocols.v6.classId, v6);
  assert.equal(registryProtocol(v6).version, 6);
  assert.equal(registryProtocol(v6).extended, true);
  assert.deepEqual(
    metadata.v6.storage,
    Object.fromEntries(
      Object.entries(NameRegistryV6Contract.storage).map(([key, value]) => [
        key,
        value.slot.toString(),
      ]),
    ),
  );
});

test('V6 wallet selection registers and executes the exact V6 artifact', async () => {
  const registry = AztecAddress.fromBigIntUnsafe(1n);
  const registered: unknown[] = [];
  const reader = {
    registry,
    classId: metadata.v6.classId,
    extended: true,
    modular: true,
    deployment: { chainId: 31337n, rollupVersion: 1n },
    node: { getContract: async () => ({ currentContractClassId: metadata.v6.classId }) },
    assertCurrentClass: async () => metadata.v6.classId,
    snapshot: async () => ({}),
    getModules: async () => ({ registrar: registry, resolver: registry }),
    assertModule: async () => 'registrar',
  } as unknown as RegistryReader;
  const wallet = {
    getChainInfo: async () => ({
      chainId: { toBigInt: () => 31337n },
      version: { toBigInt: () => 1n },
    }),
    registerContract: async (_instance: unknown, artifact: unknown) => {
      registered.push(artifact);
    },
  } as unknown as Wallet;
  const ctx = new AnsContext(reader, { wallet, account: registry });
  assert.equal(ctx.contract().artifact, NameRegistryV6Contract.artifact);
  assert.equal(ctx.extendedContract().artifact, NameRegistryV6Contract.artifact);
  await ctx.ensureRegistered();
  assert.equal(registered[0], NameRegistryV6Contract.artifact);
});
