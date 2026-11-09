import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import { RegistryReader } from '../src/client/reader.js';
import { resolveAddress, resolvePrimary } from '../src/client/resolve.js';
import { nodeOf, recordKey } from '../src/core/hash.js';
import { normalizeName } from '../src/core/label.js';
import { AnsContext } from '../src/wallet/context.js';
import { NameRegistryV7Contract } from '../src/artifacts/NameRegistryV7.js';
import { setAddress } from '../src/transactions/holder.js';
import { acceptTransfer, setTextRecord } from '../src/transactions/extensions.js';
import { setPrimary } from '../src/transactions/primary.js';
import { setResolver, setAdministrator } from '../src/transactions/modules.js';
import metadata from '../src/artifacts/modular-metadata.json' with { type: 'json' };

const addr = (n: number) => AztecAddress.fromBigIntUnsafe(BigInt(n));
const snapshot = { blockNumber: 10, blockHash: 'block-10', timestamp: 100n, finality: 'checkpointed' as const };
async function fixture(version: 6 | 7 = 7) {
  const registry = addr(1), defaultResolver = addr(3), owner = addr(5), recipient = addr(7);
  const label = normalizeName('seventh'), node = await nodeOf(label), scope = await recordKey(node, 1);
  const layout = metadata[version === 7 ? 'v7' : 'v6'];
  const classes = new Map([[registry.toString(), layout.classId], [defaultResolver.toString(), metadata.resolver.classId]]);
  const state = new Map<string, bigint>();
  const write = (address: AztecAddress, slot: string | bigint, values: bigint[]) => values.forEach((value, i) => state.set(`${address}:${BigInt(slot) + BigInt(i)}`, value));
  const map = async (slot: string, key: bigint, value: bigint) => write(registry, (await deriveStorageSlotInMap(Fr.fromString(slot), new Fr(key))).toBigInt(), [value]);
  write(registry, layout.storage.modules, [2n, 3n, 1n]);
  write(defaultResolver, metadata.resolver.storage.registry, [1n]);
  await map(layout.storage.resolvers, scope, 3n);
  if (version === 7) await map(metadata.v7.storage.record_revisions, scope, 23n);
  const rpc = {
    getNodeInfo: async () => ({ l1ChainId: 31337, rollupVersion: 1 }),
    getContract: async (address: AztecAddress) => {
      const id = classes.get(address.toString());
      return id ? { currentContractClassId: Fr.fromString(id) } : undefined;
    },
    getBlockData: async () => ({ blockHash: snapshot.blockHash, header: { globalVariables: { blockNumber: 10, timestamp: 100 } } }),
    getPublicStorageAt: async (_block: unknown, address: AztecAddress, slot: Fr) => new Fr(state.get(`${address}:${slot.toBigInt()}`) ?? 0n),
    getTxReceipt: async () => ({ status: TxStatus.CHECKPOINTED, blockNumber: 10, hasExecutionReverted: () => false }),
  } as any;
  const reader = await RegistryReader.connect(rpc, registry);
  reader.getName = async () => ({ generation: 1, revision: 7, expiresAt: 9999n, owner });
  reader.getPublishedLabel = async () => ({ present: true, packedLabel: label.packed, labelLen: label.len });
  reader.getAddress = async () => ({ present: true, addr: recipient, bindingVersion: 1 });
  reader.getPrimary = async () => ({ present: true, node, generation: 1, bindingVersion: 1 });
  reader.getTransfer = async () => ({ recipient, expiresAt: 1000n });
  const bind = (value: bigint) => map(layout.storage.resolvers, scope, value);
  const calls: { method: string; args: unknown[] }[] = [];
  const contract = { methods: Object.fromEntries(['set_address', 'set_text', 'accept_transfer', 'set_resolver', 'set_primary'].map(method => [method, (...args: unknown[]) => ({ send: async () => { calls.push({ method, args }); return { txHash: TxHash.random() }; } })])) };
  const ctx = { reader, account: owner, signer: {}, queue: { run: async (fn: () => unknown) => fn() }, ensureRegistered: async () => {}, extendedContract: () => contract, contract: () => contract, addressContract: async () => contract } as unknown as AnsContext;
  return { reader, registry, defaultResolver, owner, recipient, node, scope, classes, rpc, write, bind, calls, ctx };
}

for (const version of [6, 7] as const) {
  test(`V${version} inspectResolver distinguishes zero, unknown class, other registry and a verified non-default`, async () => {
    const f = await fixture(version);
    assert.deepEqual(await f.reader.inspectResolver(f.node, 1, snapshot), { address: f.defaultResolver, verified: true, isDefault: true });
    await f.bind(0n);
    assert.equal((await f.reader.inspectResolver(f.node, 1, snapshot)).reason, 'zero');
    await f.bind(6n);
    assert.equal((await f.reader.inspectResolver(f.node, 1, snapshot)).reason, 'unknown_class');
    await assert.rejects(f.reader.getResolver(f.node, 1, snapshot), (e: any) => e.code === 'wrong_deployment');
    f.classes.set(addr(6).toString(), metadata.resolver.classId);
    f.write(addr(6), metadata.resolver.storage.registry, [9n]);
    assert.equal((await f.reader.inspectResolver(f.node, 1, snapshot)).reason, 'other_registry');
    f.write(addr(6), metadata.resolver.storage.registry, [1n]);
    const inspection = await f.reader.inspectResolver(f.node, 1, snapshot);
    assert.equal(inspection.verified, true); assert.equal(inspection.isDefault, false);
  });
  test(`V${version} unverified resolver cannot produce a resolved address or verified primary`, async () => {
    const f = await fixture(version);
    await f.bind(6n);
    const forward = await resolveAddress(f.reader, 'seventh', { snapshot });
    assert.equal(forward.status, 'untrusted_resolver');
    if (forward.status === 'untrusted_resolver') assert(forward.resolver.equals(addr(6)));
    assert.deepEqual(await resolvePrimary(f.reader, f.recipient, snapshot), { status: 'stale', reason: 'untrusted_resolver', snapshot });
    const getAddress = f.reader.getAddress;
    f.reader.getAddress = async () => ({ present: false, addr: AztecAddress.ZERO, bindingVersion: 0 });
    assert.equal((await resolvePrimary(f.reader, f.recipient, snapshot) as { reason: string }).reason, 'untrusted_resolver');
    f.reader.getAddress = getAddress;
    await f.bind(3n);
    assert.equal((await resolveAddress(f.reader, 'seventh', { snapshot })).status, 'resolved');
    assert.equal((await resolvePrimary(f.reader, f.recipient, snapshot)).status, 'verified');
    f.rpc.getContract = async () => { throw new Error('fetch failed'); };
    await assert.rejects(f.reader.inspectResolver(f.node, 1, snapshot), (e: any) => e.code === 'network');
    await assert.rejects(resolveAddress(f.reader, 'seventh', { snapshot }), (e: any) => e.code === 'network');
    await assert.rejects(resolvePrimary(f.reader, f.recipient, snapshot), (e: any) => e.code === 'network');
  });
  test(`V${version} address and text writes select the correct revision domain`, async () => {
    const f = await fixture(version);
    assert.equal(await f.reader.getRecordRevision(f.node, 1, snapshot), version === 7 ? 23 : 7);
    await setAddress(f.ctx, { name: 'seventh', address: f.recipient });
    await setTextRecord(f.ctx, { name: 'seventh', key: 'description', value: 'test' });
    assert.deepEqual(f.calls.map(call => [call.method, call.args[2]]), [['set_address', version === 7 ? 23 : 7], ['set_text', version === 7 ? 23 : 7]]);
  });
}

test('V6 acceptance refuses an unverified inherited resolver unless explicitly opted in and reports it', async () => {
  const f = await fixture(6); f.ctx = { ...f.ctx, account: f.recipient } as AnsContext;
  await f.bind(6n);
  await assert.rejects(acceptTransfer(f.ctx, { name: 'seventh' }), (e: any) => e.code === 'invalid_argument');
  assert.equal(f.calls.length, 0);
  const accepted = await acceptTransfer(f.ctx, { name: 'seventh', acceptUnverifiedResolver: true });
  assert.equal(accepted.resolverReset, false); assert.equal(accepted.resolver?.verified, false);
  assert.deepEqual(f.calls[0].args, [f.node, 1, 7]);
});
test('V7 acceptance uses holder revision and reports the automatic resolver reset', async () => {
  const f = await fixture(); f.ctx = { ...f.ctx, account: f.recipient } as AnsContext;
  f.reader.inspectResolver = async () => { throw new Error('V7 must reset an inherited resolver without trusting it'); };
  const result = await acceptTransfer(f.ctx, { name: 'seventh' });
  assert.equal(result.resolverReset, true); assert.equal(result.resolver, undefined);
  assert.deepEqual(f.calls[0].args, [f.node, 1, 7]);
});
test('holder can reset an unverified resolver; only the target binding is checked', async () => {
  const f = await fixture(); await f.bind(6n);
  f.reader.inspectResolver = async () => { throw new Error('must not require a trusted inherited resolver'); };
  await setResolver(f.ctx, { name: 'seventh', resolver: f.defaultResolver });
  assert.deepEqual(f.calls[0].args, [f.node, 1, 7, f.defaultResolver]);
});
test('V7 wallet selection uses its exact artifact and refuses the legacy one-step admin API', async () => {
  const f = await fixture();
  const ctx = new AnsContext(f.reader, { wallet: {} as any, account: f.owner });
  assert.equal(ctx.contract().artifact, NameRegistryV7Contract.artifact);
  assert.equal(ctx.extendedContract().artifact, NameRegistryV7Contract.artifact);
  f.reader.getAdministrator = async () => f.owner;
  await assert.rejects(setAdministrator(ctx, f.recipient), (e: any) => e.code === 'unsupported');
});

for (const version of [6, 7] as const) {
  test(`V${version} setPrimary rejects unverified resolvers before constructing a wallet call, with explicit opt-in`, async () => {
    const f = await fixture(version);
    f.ctx = { ...f.ctx, account: f.recipient } as AnsContext;
    await f.bind(6n);
    const contract = f.ctx.contract;
    f.ctx.contract = () => { throw new Error('must reject before constructing wallet call'); };
    await assert.rejects(setPrimary(f.ctx, { name: 'seventh' }), (e: any) => e.code === 'invalid_argument');
    assert.equal(f.calls.length, 0);
    f.ctx.contract = contract;
    await setPrimary(f.ctx, { name: 'seventh', acceptUnverifiedResolver: true });
    assert.deepEqual(f.calls[0], { method: 'set_primary', args: [f.node, 1, 1] });
    assert.equal((await resolvePrimary(f.reader, f.recipient, snapshot)).status, 'stale');
    await f.bind(3n);
    await setPrimary(f.ctx, { name: 'seventh' });
    assert.equal(f.calls.length, 2);
  });
  test(`V${version} setPrimary opt-in does not bypass network, lifetime or forward checks`, async () => {
    const f = await fixture(version);
    const args = { name: 'seventh', acceptUnverifiedResolver: true };
    const inspect = f.reader.inspectResolver;
    f.reader.inspectResolver = async () => { throw new Error('resolver read unavailable'); };
    await assert.rejects(setPrimary(f.ctx, args), /resolver read unavailable/);
    f.reader.inspectResolver = inspect;
    await assert.rejects(setPrimary(f.ctx, args), (e: any) => e.code === 'forward_mismatch');
    f.reader.getName = async () => ({ generation: 1, revision: 7, expiresAt: 1n, owner: f.owner });
    await assert.rejects(setPrimary(f.ctx, args), (e: any) => e.code === 'not_active');
    assert.equal(f.calls.length, 0);
  });
}
