import assert from 'node:assert/strict';
import test from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { DomainSeparator, UPDATED_CLASS_IDS_SLOT } from '@aztec-labs/constants';
import metadata from '../src/artifacts/modular-metadata.json' with { type: 'json' };
import { hashWithSeparator } from '../src/core/hash.js';
import { readCoreUpgrade, assertUpgradeInclusionMargin } from '../src/client/core-upgrade.js';
import type { Snapshot } from '../src/core/types.js';
import { AnsContext } from '../src/wallet/context.js';
import type { RegistryReader } from '../src/client/reader.js';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import { runTxOutcome } from '../src/transactions/tx.js';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';
const A = BigInt(metadata.v8.classId), B = BigInt(metadata.v8Rehearsal.classId);
const registry = AztecAddress.fromBigIntUnsafe(1234n);
const snap: Snapshot = { blockNumber: 7, blockHash: 'hash-N', timestamp: 1000000n, finality: 'proposed' };
async function fixture() {
  const values = new Map<string, bigint>();
  const slots = metadata.v8.storage;
  const write = (address: string, slot: bigint, fields: bigint[]) => fields.forEach((value, i) => values.set(`${address}:${slot + BigInt(i)}`, value));
  const app = (name: keyof typeof slots, fields: bigint[]) => write(String(registry), BigInt(slots[name]), fields);
  const map = (slot: bigint, key: bigint) => hashWithSeparator([slot, key], BigInt(DomainSeparator.PUBLIC_STORAGE_MAP_SLOT));
  const release = async (id: bigint, seq: bigint, status = 1n) => write(String(registry), await map(BigInt(slots.releases), id), [status, 0x414e535f434f5245n, seq, 1n]);
  const edge = async (from: bigint, to: bigint, kind: bigint, status = 1n) => write(String(registry), await map(BigInt(slots.edges), await hashWithSeparator([from, to], 0x414e5308n)), [status, kind, 1n]);
  const protocolSlot = await map(BigInt(UPDATED_CLASS_IDS_SLOT), registry.toBigInt());
  const protocol = (fields: bigint[]) => write(String(AztecAddress.fromBigIntUnsafe(2n)), protocolSlot, fields);
  let current = metadata.v8.classId, original = metadata.v8.classId, hash = snap.blockHash, reorg = false;
  let headers = 0;
  const pinned: number[] = [];
  const node = {
    getBlockData: async (number: number) => { pinned.push(number); headers++; return { blockHash: reorg && headers > 1 ? 'changed-N' : hash, header: { globalVariables: { timestamp: snap.timestamp, blockNumber: number } } }; },
    getContract: async (_address: AztecAddress, number: number) => { pinned.push(number); return { currentContractClassId: current, originalContractClassId: original }; },
    getPublicStorageAt: async (number: number, address: AztecAddress, slot: Fr) => { pinned.push(number); return new Fr(values.get(`${address}:${slot.toBigInt()}`) ?? 0n); },
  } as unknown as AztecNode;
  app('core_class', [A]); app('upgrade_nonce', [0n]); protocol([0n, 0n, 0n]);
  await release(A, 1n); await release(B, 2n); await edge(A, B, 1n); await edge(B, A, 2n);
  return { node, app, protocol, release, edge, pinned, current: (id: string) => current = id, original: (id: string) => original = id, reorg: () => reorg = true };
}
const read = async (f: Awaited<ReturnType<typeof fixture>>, profile: { allowRehearsalSuccessor?: boolean } = { allowRehearsalSuccessor: true }) => readCoreUpgrade(f.node, registry, snap, profile);
const pending = (f: Awaited<ReturnType<typeof fixture>>) => { f.app('upgrade_nonce', [1n]); f.app('pending', [1n, 1n, A, B, 0n, snap.timestamp, snap.timestamp + 86400n]); };
const scheduled = (f: Awaited<ReturnType<typeof fixture>>, t = snap.timestamp + 1800n) => { f.app('upgrade_nonce', [1n]); f.app('scheduled', [1n, 1n, A, B, 0n, t]); f.protocol([t, 0n, B]); };
test('V8 all decision reads use block N; head advancement does not require unchanged latest', async () => { const f = await fixture(); const state = await read(f); assert.equal(state.currentClass, metadata.v8.classId); assert(f.pinned.every(number => number === 7)); });
test('V8 constructor-bound initial state works with production-only profile', async () => { const f = await fixture(); assert.equal((await read(f, {})).coreClass, A); });
test('V8 app proposal requires exact reviewed edge and live on-chain approval', async () => { const f = await fixture(); pending(f); assert((await read(f)).pending.active); await f.edge(A, B, 1n, 2n); await assert.rejects(read(f), /approval mismatch/); });
test('V8 proposal cannot silently opt into rehearsal successor', async () => { const f = await fixture(); pending(f); await assert.rejects(read(f, {}), /unknown directed/); });
test('V8 registered but unknown target fails closed', async () => { const f = await fixture(); pending(f); f.app('pending', [1n, 1n, A, 999n, 0n, snap.timestamp, snap.timestamp + 86400n]); await assert.rejects(read(f), /unknown directed/); });
test('V8 protocol schedule and application timestamp must match', async () => { const f = await fixture(); scheduled(f); f.protocol([snap.timestamp + 1900n, 0n, B]); await assert.rejects(read(f), /schedule differs/); });
test('V8 current is computed at snapshot, never from next-block prediction', async () => { const f = await fixture(); scheduled(f); f.current(metadata.v8Rehearsal.classId); await assert.rejects(read(f), /runtime class mismatch/); });
test('V8 active at exact T matches protocol and original root remains A', async () => { const f = await fixture(); scheduled(f, snap.timestamp); f.current(metadata.v8Rehearsal.classId); const state = await read(f); assert.equal(state.currentClass, metadata.v8Rehearsal.classId); assert.equal(state.originalClass, metadata.v8.classId); });
test('V8 rejects an unrelated original root even with a known current class', async () => { const f = await fixture(); f.original(metadata.v7.classId); await assert.rejects(read(f), /unknown V8 root/); });
test('V8 rejects unknown current class', async () => { const f = await fixture(); f.current(String(new Fr(999n))); await assert.rejects(read(f), /unknown V8 root/); });
test('V8 untracked future protocol target is rejected', async () => { const f = await fixture(); f.protocol([snap.timestamp + 1800n, 0n, B]); await assert.rejects(read(f), /untracked protocol target/); });
test('V8 protocol cancellation no-op at current B is accepted', async () => { const f = await fixture(); f.current(metadata.v8Rehearsal.classId); f.app('core_class', [B]); f.protocol([snap.timestamp + 1800n, B, B]); assert.equal((await read(f)).currentClass, metadata.v8Rehearsal.classId); });
test('V8 rejects changed canonical hash of N', async () => { const f = await fixture(); f.reorg(); await assert.rejects(read(f), /no longer canonical/); });
test('V8 fails closed on fixed protocol delay mismatch', async () => { const f = await fixture(); f.protocol([(1n << 64n) | (600n << 72n), 0n, 0n]); await assert.rejects(read(f), /protocol delay differs/); });
test('V8 requires proving/inclusion margin before activation', async () => { const f = await fixture(); scheduled(f, snap.timestamp + 900n); const state = await read(f); assert.throws(() => assertUpgradeInclusionMargin(state), /too close/); assert.throws(() => assertUpgradeInclusionMargin(state, 1n), /at least 900/); });

test('V8 rejects unknown protocol predecessor even after a known target is active', async () => { const f = await fixture(); f.protocol([snap.timestamp - 1n, 999n, A]); await assert.rejects(read(f), /unknown protocol class history/); });

test('class verification cannot be disabled to bypass V8 profile guards', async () => { const { RegistryReader } = await import('../src/client/reader.js'); let reads = 0; await assert.rejects(RegistryReader.connect({ getNodeInfo: async () => { reads++; } } as unknown as AztecNode, registry, { verifyClass: false }), /cannot be disabled/); assert.equal(reads, 0); });


test('SDK admin rejects unknown directed targets and mislabeled exact releases before wallet send', async () => {
  const { administerCoreUpgrade } = await import('../src/transactions/core-upgrade.js');
  let sends = 0;
  const ctx = {
    account: registry, wallet: { sendTx: async () => { sends++; throw new Error('must not send'); } },
    signer: {}, queue: { run: (call: () => Promise<unknown>) => call() }, ensureRegistered: async () => {},
    reader: { registry, modular: true, upgradeProfile: { allowRehearsalSuccessor: true }, getCoreUpgradeState: async () => ({ nonce: 0n, currentClass: metadata.v8.classId }) },
  } as any;
  await assert.rejects(administerCoreUpgrade(ctx, { kind: 'propose', expectedNonce: 0n, from: A, to: 999n }), /directed edge has no reviewed artifacts/);
  await assert.rejects(administerCoreUpgrade(ctx, { kind: 'approve_edge_pair', expectedNonce: 0n, older: B, newer: A }), /reviewed release order/);
  await assert.rejects(administerCoreUpgrade(ctx, { kind: 'approve_release', expectedNonce: 0n, classId: B, family: 0x414e535f434f5245n, releaseSeq: 99 }), /releaseSeq differs/);
  assert.equal(sends, 0);
});

test('reused V8 context refuses registration and send at 900s without an unknown-broadcast marker', async () => {
  const f = await fixture();
  let margin = 901n, registrations = 0, sends = 0, marker = false, inQueue = false;
  const reader = {
    registry, modular: true, classId: metadata.v8.classId,
    deployment: { chainId: 31337n, rollupVersion: 1n },
    assertCurrentClass: async () => { assert(inQueue); return metadata.v8.classId; },
    getCoreUpgradeState: async () => { scheduled(f, snap.timestamp + margin); return read(f); },
    isCanonical: async () => true, snapshot: async () => snap,
    getModules: async () => ({ registrar: registry, resolver: registry }),
    assertModule: async () => 'registrar',
    node: { getContract: async () => ({ currentContractClassId: Fr.fromString(metadata.v8.classId) }),
      getTxReceipt: async () => ({ status: TxStatus.CHECKPOINTED, hasExecutionReverted: () => false }) },
  } as unknown as RegistryReader;
  const wallet = {
    getChainInfo: async () => { assert(inQueue); return { chainId: new Fr(31337n), version: new Fr(1n) }; },
    registerContract: async () => { assert(inQueue); registrations++; },
  } as unknown as Wallet;
  const ctx = new AnsContext(reader, { wallet, account: registry });
  const interaction = { send: async () => { assert(inQueue); sends++; return { txHash: TxHash.random() }; }, simulate: async () => { margin = 900n; } } as any;
  const run = ctx.queue.run.bind(ctx.queue);
  ctx.queue.run = task => run(async () => { inQueue = true; try { return await task(); } finally { inQueue = false; } });
  const send = (preflight = false) => runTxOutcome(ctx, interaction, { preflight, beforeBroadcast: async () => { marker = true; } });
  await send(); assert.equal(sends, 1); assert(registrations > 0);
  marker = false; registrations = 0; margin = 900n;
  await assert.rejects(send(), /too close/);
  assert.equal(registrations, 0); assert.equal(sends, 1); assert.equal(marker, false);
  margin = 901n;
  await assert.rejects(send(true), /too close/);
  assert(registrations > 0); assert.equal(sends, 1); assert.equal(marker, false);
});
