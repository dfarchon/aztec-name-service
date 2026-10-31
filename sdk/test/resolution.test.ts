import assert from "node:assert/strict";
import { test } from "node:test";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, BlockNumber } from "@aztec-labs/aztec.js/fields";
import { MAX_LOGS_PER_TAG } from "@aztec-labs/stdlib/interfaces/api-limit";
import {
  listOwnedNames,
  normalizeName,
  nodeOf,
  resolveAddress,
  resolvePrimary,
  resolvePrimaryMany,
  Resolver,
  AnsError,
  type RegistryReader,
  type Snapshot,
} from "../src/index.js";

const owner = AztecAddress.fromBigIntUnsafe(1n);
const other = AztecAddress.fromBigIntUnsafe(2n);
const label = normalizeName("alice");
const node = await nodeOf(label);
const snapshot: Snapshot = {
  blockNumber: 10,
  blockHash: "block-10",
  timestamp: 100n,
  finality: "proposed",
};
function fixture() {
  const name = { generation: 1, revision: 0, expiresAt: 1000n, owner };
  const forward = { present: true, addr: owner, bindingVersion: 3 };
  const primary = { present: true, node, generation: 1, bindingVersion: 3 };
  const reader = {
    registry: other,
    deployment: { chainId: 31337n, rollupVersion: 1n },
    snapshot: async () => snapshot,
    isCanonical: async () => true,
    getName: async () => name,
    getAddress: async () => forward,
    getPrimary: async () => primary,
    getPublishedLabel: async () => ({
      present: true,
      packedLabel: label.packed,
      labelLen: label.len,
    }),
  } as unknown as RegistryReader;
  return { reader, name, forward, primary };
}

test("reverse resolution checks generation, expiry, target and binding version", async () => {
  const f = fixture();
  assert.equal((await resolvePrimary(f.reader, owner)).status, "verified");
  f.primary.bindingVersion = 1;
  assert.equal(
    ((await resolvePrimary(f.reader, owner)) as { reason: string }).reason,
    "binding_version_changed",
  );
  f.primary.bindingVersion = 3;
  f.forward.addr = other;
  assert.equal(
    ((await resolvePrimary(f.reader, owner)) as { reason: string }).reason,
    "forward_mismatch",
  );
  f.forward.addr = owner;
  f.name.expiresAt = 100n;
  assert.equal(
    ((await resolvePrimary(f.reader, owner)) as { reason: string }).reason,
    "expired",
  );
  assert.equal((await resolveAddress(f.reader, "alice")).status, "inactive");
  f.name.expiresAt = 1000n;
  f.name.generation = 2;
  assert.equal(
    ((await resolvePrimary(f.reader, owner)) as { reason: string }).reason,
    "generation_changed",
  );
});

test("forward resolution reuses an explicit snapshot without reading a newer block", async () => {
  const { reader } = fixture();
  reader.snapshot = async () => { throw new Error("must use pinned snapshot"); };
  const result = await resolveAddress(reader, "alice", { snapshot });
  assert.equal(result.status, "resolved");
  assert.equal(result.snapshot, snapshot);
});

test("batch resolution rejects invalid concurrency and skips RPC for an empty batch", async () => {
  const { reader } = fixture();
  for (const concurrency of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(resolvePrimaryMany(reader, [owner], { concurrency }),
      (e: AnsError) => e.code === "invalid_argument");
  }
  reader.snapshot = async () => { throw new Error("unnecessary RPC"); };
  assert.equal((await resolvePrimaryMany(reader, [])).size, 0);
});

test("resolver refuses cached names when canonicality cannot be checked and retries immediately", async () => {
  const { reader, primary } = fixture();
  const resolver = new Resolver(reader, { reorgCheckMs: 0 });
  assert.equal((await resolver.primary(owner)).status, "verified");
  reader.isCanonical = async () => { throw new Error("fetch failed"); };
  await assert.rejects(resolver.primary(owner), (e: AnsError) => e.code === "network");
  primary.present = false;
  reader.isCanonical = async () => true;
  assert.equal((await resolver.primary(owner)).status, "none");
});

test("resolver invalidates a reorged snapshot and deduplicates concurrent reads", async () => {
  const { reader, primary } = fixture();
  let reads = 0;
  reader.getPrimary = async () => { reads++; return primary; };
  const resolver = new Resolver(reader, { reorgCheckMs: 0 });
  await Promise.all([resolver.primary(owner), resolver.primary(owner)]);
  assert.equal(reads, 1);
  primary.present = false;
  reader.isCanonical = async () => false;
  assert.equal((await resolver.primary(owner)).status, "none");
  assert.equal(reads, 2);
});

test("a newer canonical entry cannot hide an older entry from a discarded fork", async () => {
  const { reader } = fixture();
  let snap = snapshot;
  reader.snapshot = async () => snap;
  const resolver = new Resolver(reader, { reorgCheckMs: 0 });
  await resolver.primary(owner);
  snap = { ...snapshot, blockNumber: 12, blockHash: "block-12" };
  await resolver.primary(other);
  reader.isCanonical = async s => s.blockNumber !== 10;
  let reads = 0;
  reader.getPrimary = async () => {
    reads++;
    return { present: false, node: 0n, generation: 0, bindingVersion: 0 };
  };
  assert.equal((await resolver.primary(owner)).status, "none");
  assert.equal(reads, 1);
});

test("transport failure is never an available name or valid primary", async () => {
  const { reader } = fixture();
  reader.getName = async () => {
    throw new Error("fetch failed");
  };
  await assert.rejects(resolveAddress(reader, "alice"), /fetch failed/);
  await assert.rejects(resolvePrimary(reader, owner), /fetch failed/);
});

test("public ownership discovery decodes actual ABI, paginates and pins the snapshot", async () => {
  const { reader, name } = fixture();
  let calls = 0;
  Object.assign(reader, {
    node: {
      getPublicLogsByTags: async (q: { toBlock: number; tags: unknown[] }) => {
        assert.equal(q.toBlock, 11);
        calls++;
        const count = calls === 1 ? MAX_LOGS_PER_TAG : 1;
        return [
          Array.from({ length: count }, (_, i) => ({
            // Tag, then the NameRegistered ABI fields (including an AztecAddress).
            logData: [
              new Fr(0),
              new Fr(node),
              new Fr(1),
              new Fr(1000),
              owner.toField(),
              new Fr(label.packed),
              new Fr(label.len),
            ],
            blockNumber: BlockNumber(10),
            blockHash: "block-10",
            txIndexWithinBlock: 0,
            logIndexWithinTx: i,
          })),
        ];
      },
      getBlockData: async () => ({
        blockHash: { toString: () => "block-10" },
        header: { globalVariables: { timestamp: 100n } },
      }),
    } as unknown as RegistryReader["node"],
  });
  const first = await listOwnedNames(reader, owner, { maxPages: 1 });
  assert.equal(first.status, "partial");
  assert.equal(first.names.length, 1);
  assert.ok(first.cursor);
  assert.equal(first.cursor.rollupVersion, '1');
  await assert.rejects(listOwnedNames(reader, owner, {
    cursor: { ...first.cursor, rollupVersion: '2' },
  }), (e: AnsError) => e.code === 'wrong_deployment');
  // Pre-0.4.3 cursors lack a rollup identity; restart discovery rather than guessing.
  await assert.rejects(listOwnedNames(reader, owner, {
    cursor: { ...first.cursor, rollupVersion: undefined } as any,
  }), (e: AnsError) => e.code === 'wrong_deployment');
  const second = await listOwnedNames(reader, owner, { cursor: first.cursor });
  assert.equal(second.status, "complete");
  assert.equal(second.names[0].name, "alice");
  await assert.rejects(
    listOwnedNames(reader, other, { cursor: first.cursor }),
    /another account/,
  );
  name.owner = other;
  assert.equal((await listOwnedNames(reader, owner)).names.length, 0);
  reader.node.getBlockData = async () => undefined;
  await assert.rejects(
    listOwnedNames(reader, owner, { cursor: first.cursor }),
    /chain changed/,
  );
  reader.node.getPublicLogsByTags = async () => {
    throw new Error("offline");
  };
  await assert.rejects(listOwnedNames(reader, owner), /offline/);
});

test('nested primary lookup preserves transport and unsupported-class errors instead of hiding them as missing labels', async () => {
  const { reader } = fixture();
  Object.defineProperty(reader, 'extended', { value: true });
  for (const code of ['network', 'wrong_deployment'] as const) {
    reader.getPublishedName = async () => { throw new AnsError(code, 'lookup failed'); };
    await assert.rejects(resolvePrimary(reader, owner), (e: AnsError) => e.code === code);
  }
  reader.getPublishedName = async () => { throw new AnsError('network', 'parent RPC unavailable'); };
  await assert.rejects(resolvePrimaryMany(reader, [owner, owner]), (e: AnsError) => e.code === 'network');
  reader.getPublishedName = async () => { throw new AnsError('corrupt_data', 'label does not match'); };
  assert.equal((await resolvePrimary(reader, owner)).status, 'label_unavailable');
});
