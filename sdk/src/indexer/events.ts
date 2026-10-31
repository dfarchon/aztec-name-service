import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { type EventCursor, getPublicEvents } from "@aztec-labs/aztec.js/events";
import { BlockNumber } from "@aztec-labs/aztec.js/fields";
import { NameRegistryContract } from "../artifacts/NameRegistry.js";
import { NameRegistryV3Contract } from "../artifacts/NameRegistryV3.js";
import { NameRegistryV4Contract } from "../artifacts/NameRegistryV4.js";
import type { RegistryReader } from "../client/reader.js";
import { nodeFromPacked } from "../core/hash.js";
import { unpackLabel } from "../core/label.js";
import { nameStatus, type NameStatus } from "../core/lifecycle.js";
import { AnsError } from "../core/errors.js";

export type RegistryEventName = keyof typeof NameRegistryContract.events;
export async function fetchEvents<T>(
  reader: RegistryReader,
  event: RegistryEventName,
  range: { fromBlock?: number; toBlock?: number; after?: EventCursor } = {},
) {
  const schema = reader.modular ? NameRegistryV3Contract.events[`${event}V3` as keyof typeof NameRegistryV3Contract.events] : NameRegistryContract.events[event];
  return getPublicEvents<T>(reader.node, schema, {
    contractAddress: reader.registry,
    fromBlock:
      range.fromBlock === undefined ? undefined : BlockNumber(range.fromBlock),
    toBlock:
      range.toBlock === undefined ? undefined : BlockNumber(range.toBlock),
    afterEvent: range.after,
  });
}
export type OwnedName = {
  name: string;
  node: bigint;
  generation: number;
  expiresAt: bigint;
  status: NameStatus;
};
type RegistrationEvent = {
  node: bigint;
  owner: AztecAddress;
  packed_label: bigint;
  label_len: bigint;
};

/** Public log discovery, followed by current ownership verification at one pinned block.
 * Network errors abort the page; they must never masquerade as an empty or complete list.
 * Cursors are bound to account, deployment and snapshot, so continuing cannot mix owners or reorged state.
 */
export type NamesCursor = {
  account: string;
  registry: string;
  chainId: string;
  rollupVersion: string;
  block: number;
  hash: string;
  after: EventCursor;
};
export async function listOwnedNames(
  reader: RegistryReader,
  owner: AztecAddress,
  opts: { cursor?: NamesCursor; maxPages?: number } = {},
) {
  const c = opts.cursor;
  if (
    c &&
    (c.account !== owner.toString() ||
      c.registry !== reader.registry.toString() ||
      c.chainId !== String(reader.deployment.chainId) ||
      c.rollupVersion !== String(reader.deployment.rollupVersion))
  ) {
    throw new AnsError(
      "wrong_deployment",
      "name cursor belongs to another account or deployment",
    );
  }
  const latest = await reader.snapshot();
  const snap = c
    ? { ...latest, blockNumber: c.block, blockHash: c.hash }
    : latest;
  if (c) {
    const block = await reader.node.getBlockData(BlockNumber(c.block));
    if (!block || block.blockHash.toString() !== c.hash)
      throw new AnsError("conflict", "chain changed; restart name discovery");
    snap.timestamp = BigInt(block.header.globalVariables.timestamp);
  }
  const candidates = new Map<bigint, string>();
  let after = c?.after;
  let pages = 0;
  do {
    const page = await fetchEvents<RegistrationEvent>(
      reader,
      "NameRegistered",
      { toBlock: snap.blockNumber + 1, after },
    );
    for (const { event } of page.events) {
      if (!event.owner.equals(owner)) continue;
      const label = unpackLabel(
        BigInt(event.packed_label),
        Number(event.label_len),
      );
      const node = reader.extended ? BigInt(event.node) : await nodeFromPacked(label.packed, label.len);
      if (node !== BigInt(event.node))
        throw new AnsError(
          "corrupt_data",
          "registration label does not match node",
        );
      candidates.set(node, reader.extended ? await reader.getPublishedName(node, snap) : label.label);
    }
    after = page.nextCursor;
  } while (after && ++pages < (opts.maxPages ?? 4));
  const names: OwnedName[] = [];
  for (const [node, name] of candidates) {
    const rec = await reader.getName(node, snap);
    const status = nameStatus(rec, snap.timestamp);
    if (
      rec.owner.equals(owner) &&
      (status === "active" || status === "grace")
    ) {
      names.push({
        name,
        node,
        generation: rec.generation,
        expiresAt: rec.expiresAt,
        status,
      });
    }
  }
  if (!(await reader.isCanonical(snap)))
    throw new AnsError("conflict", "chain changed; restart name discovery");
  return {
    names,
    status: after ? ("partial" as const) : ("complete" as const),
    cursor: after
      ? {
          account: owner.toString(),
          registry: reader.registry.toString(),
          chainId: String(reader.deployment.chainId),
          rollupVersion: String(reader.deployment.rollupVersion),
          block: snap.blockNumber,
          hash: snap.blockHash,
          after,
        }
      : undefined,
    snapshot: snap,
  };
}

export type SubnamesCursor = {
  parent: string;
  registry: string;
  chainId: string;
  rollupVersion: string;
  block: number;
  hash: string;
  after: EventCursor;
};

/** Discover direct children without reading unrelated registrations. Continuations retain the same snapshot. */
export async function listSubnames(reader: RegistryReader, parent: bigint, opts: { cursor?: SubnamesCursor; maxPages?: number } = {}) {
  if (!reader.extended) throw new AnsError('invalid_argument', 'subnames require registry V4');
  const maxPages = opts.maxPages ?? 4;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1)
    throw new AnsError('invalid_argument', 'maxPages must be a positive integer');
  const c = opts.cursor;
  if (c && (c.parent !== String(parent) || c.registry !== reader.registry.toString() ||
    c.chainId !== String(reader.deployment.chainId) || c.rollupVersion !== String(reader.deployment.rollupVersion)))
    throw new AnsError('wrong_deployment', 'subname cursor belongs to another parent or deployment');
  const latest = await reader.snapshot();
  const snapshot = c ? { ...latest, blockNumber: c.block, blockHash: c.hash } : latest;
  if (c) {
    const block = await reader.node.getBlockData(BlockNumber(c.block));
    if (!block || block.blockHash.toString() !== c.hash)
      throw new AnsError('conflict', 'chain changed; restart subname discovery');
    snapshot.timestamp = BigInt(block.header.globalVariables.timestamp);
  }
  const candidates = new Set<bigint>();
  let after = c?.after, pages = 0;
  do {
    const result = await getPublicEvents<{ parent: bigint; node: bigint }>(reader.node, NameRegistryV4Contract.events.SubnameIssued, {
      contractAddress: reader.registry,
      toBlock: BlockNumber(snapshot.blockNumber + 1),
      afterEvent: after,
    });
    for (const { event } of result.events) {
      if (BigInt(event.parent) === parent) candidates.add(BigInt(event.node));
    }
    after = result.nextCursor;
  } while (after && ++pages < maxPages);
  const names: OwnedName[] = [];
  for (const node of candidates) {
    const link = await reader.getParent(node, snapshot);
    if (link.parent !== parent) continue;
    const record = await reader.getName(node, snapshot);
    names.push({ name: await reader.getPublishedName(node, snapshot), node, generation: record.generation, expiresAt: record.expiresAt, status: nameStatus(record, snapshot.timestamp) });
  }
  if (!await reader.isCanonical(snapshot)) throw new AnsError('conflict', 'chain changed; reload subnames');
  return { names, complete: !after, snapshot, cursor: after ? {
    parent: String(parent), registry: reader.registry.toString(),
    chainId: String(reader.deployment.chainId), rollupVersion: String(reader.deployment.rollupVersion),
    block: snapshot.blockNumber, hash: snapshot.blockHash, after,
  } satisfies SubnamesCursor : undefined };
}
