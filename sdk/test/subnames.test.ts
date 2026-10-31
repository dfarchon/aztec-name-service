import assert from 'node:assert/strict';
import test from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BlockNumber, Fr } from '@aztec-labs/aztec.js/fields';
import { MAX_LOGS_PER_TAG } from '@aztec-labs/stdlib/interfaces/api-limit';
import type { RegistryReader } from '../src/client/reader.js';
import type { Snapshot } from '../src/core/types.js';
import { AnsError } from '../src/core/errors.js';
import { listSubnames } from '../src/indexer/events.js';

const owner = AztecAddress.fromBigIntUnsafe(1n);
const registry = AztecAddress.fromBigIntUnsafe(2n);
const parent = 100n;
const snapshot: Snapshot = { blockNumber: 10, blockHash: 'block-10', timestamp: 100n, finality: 'proposed' };
function log(parentNode: bigint, node: bigint, index: number) {
  return {
    // SubnameIssued's actual ABI: parent, node, generation, owner. The first field is the log tag.
    logData: [Fr.ZERO, new Fr(parentNode), new Fr(node), new Fr(1), owner.toField()],
    blockNumber: BlockNumber(10), blockHash: 'block-10', txIndexWithinBlock: 0, logIndexWithinTx: index,
  };
}
function fixture() {
  let latest = snapshot;
  const calls: { kind: string; node: bigint; snapshot: Snapshot }[] = [];
  const reader = {
    extended: true, registry, deployment: { chainId: 31337n, rollupVersion: 1n },
    snapshot: async () => latest,
    isCanonical: async () => true,
    getParent: async (node: bigint, snap: Snapshot) => { calls.push({ kind: 'parent', node, snapshot: snap }); return { parent }; },
    getName: async (node: bigint, snap: Snapshot) => { calls.push({ kind: 'name', node, snapshot: snap }); return { generation: 2, revision: 0, expiresAt: 1000n, owner }; },
    getPublishedName: async (node: bigint, snap: Snapshot) => { calls.push({ kind: 'label', node, snapshot: snap }); return `child-${node}.alice`; },
    node: {
      getPublicLogsByTags: async (_query: unknown) => [[log(parent, 101n, 0)]],
      getBlockData: async (_block: unknown) => ({ blockHash: { toString: () => snapshot.blockHash }, header: { globalVariables: { timestamp: snapshot.timestamp } } }),
    },
  } as unknown as RegistryReader;
  return { reader, calls, advance: () => { latest = { ...snapshot, blockNumber: 20, blockHash: 'block-20', timestamp: 2000n }; } };
}

test('subname discovery filters unrelated parents before storage reads and deduplicates issue/revoke events', async () => {
  const { reader, calls } = fixture();
  reader.node.getPublicLogsByTags = async () => [[log(999n, 900n, 0), log(parent, 101n, 1), log(parent, 101n, 2)]] as any;
  const page = await listSubnames(reader, parent);
  assert.equal(page.complete, true);
  assert.deepEqual(page.names.map(n => n.name), ['child-101.alice']);
  assert.equal(page.names[0].generation, 2); // A transferred or reissued child uses current state, not event state.
  assert.deepEqual(calls.map(c => c.node), [101n, 101n, 101n]);
  assert.ok(calls.every(c => c.snapshot === page.snapshot));
});

test('subname continuations pin event range, liveness and storage to the original block', async () => {
  const f = fixture();
  let queries = 0;
  f.reader.node.getPublicLogsByTags = async (query: any) => {
    assert.equal(query.toBlock, 11);
    queries++;
    return [queries === 1 ? Array.from({ length: MAX_LOGS_PER_TAG }, (_, i) => log(i === 0 ? parent : 999n, BigInt(i + 101), i)) : [log(parent, 102n, 0)]] as any;
  };
  const first = await listSubnames(f.reader, parent, { maxPages: 1 });
  assert.equal(first.complete, false);
  assert.ok(first.cursor);
  f.advance();
  const second = await listSubnames(f.reader, parent, { cursor: first.cursor });
  assert.equal(second.complete, true);
  assert.equal(second.snapshot.blockNumber, 10);
  assert.equal(second.snapshot.timestamp, 100n);
  assert.equal(second.names[0].status, 'active');
  assert.ok(f.calls.every(c => c.snapshot.blockNumber === 10 && c.snapshot.timestamp === 100n));
});

test('subname cursors reject another parent, registry, chain or rollup and pruned snapshots', async () => {
  const { reader } = fixture();
  reader.node.getPublicLogsByTags = async () => [Array.from({ length: MAX_LOGS_PER_TAG }, (_, i) => log(parent, 101n, i))] as any;
  const { cursor } = await listSubnames(reader, parent, { maxPages: 1 });
  assert.ok(cursor);
  for (const changed of [{ parent: '101' }, { registry: owner.toString() }, { chainId: '1' }, { rollupVersion: '2' }]) {
    await assert.rejects(listSubnames(reader, parent, { cursor: { ...cursor, ...changed } }), (e: AnsError) => e.code === 'wrong_deployment');
  }
  reader.node.getBlockData = async () => undefined;
  await assert.rejects(listSubnames(reader, parent, { cursor }), (e: AnsError) => e.code === 'conflict');
});

test('subname discovery verifies parent links and propagates transport/reorg failures', async () => {
  const { reader } = fixture();
  reader.getParent = async () => ({ parent: 999n, parentGeneration: 1, depth: 1 });
  assert.equal((await listSubnames(reader, parent)).names.length, 0);
  reader.isCanonical = async () => false;
  await assert.rejects(listSubnames(reader, parent), (e: AnsError) => e.code === 'conflict');
  reader.node.getPublicLogsByTags = async () => { throw new AnsError('network', 'offline'); };
  await assert.rejects(listSubnames(reader, parent), (e: AnsError) => e.code === 'network');
});

test('subname discovery rejects invalid page budgets before requesting events', async () => {
  const { reader } = fixture();
  reader.node.getPublicLogsByTags = async () => { throw new Error('unnecessary RPC'); };
  for (const maxPages of [0, -1, 1.5, NaN, Infinity])
    await assert.rejects(listSubnames(reader, parent, { maxPages }), (e: AnsError) => e.code === 'invalid_argument');
});
