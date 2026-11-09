import { chainAddressKey, validateChainAddress } from "../core/records.js";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";

import { AnsError, toAnsError } from "../core/errors.js";
import { nodeOf } from "../core/hash.js";
import {
  type Label,
  normalizeName,
  type NormalizeOptions,
  unpackLabel,
} from "../core/label.js";
import {
  isRegistrable,
  nameStatus,
  type NameStatus,
} from "../core/lifecycle.js";
import type { NameRecord, Snapshot } from "../core/types.js";
import type { RegistryReader } from "./reader.js";

export type NameInfo = {
  label: Label;
  node: bigint;
  record: NameRecord;
  status: NameStatus;
  /** Generation a new registration must name as `expected_generation`. */
  nextExpectedGeneration: number;
  snapshot: Snapshot;
};

export type NameQueryOptions = NormalizeOptions & {
  /** Reuse one block for availability, forward resolution and management reads. */
  snapshot?: Snapshot;
};

export async function getName(
  reader: RegistryReader,
  name: string | Label,
  opts?: NameQueryOptions,
): Promise<NameInfo> {
  const snapshot = opts?.snapshot ?? (await reader.snapshot());
  const label = typeof name === "string" ? normalizeName(name, { ...opts, allowSubnames: reader.extended }) : name;
  const node = await nodeOf(label);
  const record = await reader.getName(node, snapshot);
  return {
    label,
    node,
    record,
    status: nameStatus(record, snapshot.timestamp),
    nextExpectedGeneration: record.generation,
    snapshot,
  };
}

/** Availability at the snapshot only; it reserves nothing. */
export async function getAvailability(
  reader: RegistryReader,
  name: string | Label,
  opts?: NameQueryOptions,
) {
  const info = await getName(reader, name, opts);
  const legacy = reader.modular && info.record.generation === 0 ? await reader.getLegacyName(info.node, info.snapshot) : undefined;
  const migration = legacy && ["active", "grace"].includes(nameStatus(legacy, info.snapshot.timestamp)) ? legacy : undefined;
  return { ...info, available: !info.label.parent && isRegistrable(info.status) && !migration, migration };
}

export type AddressResolution =
  | { status: "untrusted_resolver"; resolver: AztecAddress; node: bigint; nameStatus: NameStatus; snapshot: Snapshot }
  | {
      status: "resolved";
      address: AztecAddress;
      node: bigint;
      generation: number;
      bindingVersion: number;
      expiresAt: bigint;
      snapshot: Snapshot;
    }
  | {
      status: "unset" | "inactive" | "unregistered";
      node: bigint;
      nameStatus: NameStatus;
      snapshot: Snapshot;
    };

/** Forward resolution in exactly the default record; never falls back to the owner or a previous generation. */
export async function resolveAddress(
  reader: RegistryReader,
  name: string | Label,
  opts?: NameQueryOptions,
): Promise<AddressResolution> {
  const { node, record, status, snapshot } = await getName(reader, name, opts);
  if (status === "unregistered")
    return { status: "unregistered", node, nameStatus: status, snapshot };
  if (status !== "active")
    return { status: "inactive", node, nameStatus: status, snapshot };
  const rec = await reader.getAddress(node, record.generation, snapshot);
  if (!rec.present)
    return { status: "unset", node, nameStatus: status, snapshot };
  if (reader.modular) {
    const resolver = await reader.inspectResolver(node, record.generation, snapshot);
    if (!resolver.verified) return { status: "untrusted_resolver", resolver: resolver.address, node, nameStatus: status, snapshot };
  }
  return {
    status: "resolved",
    address: rec.addr,
    node,
    generation: record.generation,
    bindingVersion: rec.bindingVersion,
    expiresAt: record.expiresAt,
    snapshot,
  };
}

export type PrimaryResolution =
  | {
      status: "verified";
      name: string;
      node: bigint;
      generation: number;
      bindingVersion: number;
      expiresAt: bigint;
      snapshot: Snapshot;
    }
  | { status: "none"; snapshot: Snapshot }
  | {
      status: "stale";
      reason:
        | "untrusted_resolver"
        | "expired"
        | "generation_changed"
        | "forward_mismatch"
        | "binding_version_changed";
      snapshot: Snapshot;
    }
  /** Missing or corrupt public label: refuse to display an unverifiable name. */
  | { status: "label_unavailable"; node: bigint; snapshot: Snapshot };

/**
 * Reverse resolution with the full check: primary → current name record (active, same generation) → forward record
 * points back with the same binding version → published label hashes to the node.
 */
export async function resolvePrimary(
  reader: RegistryReader,
  address: AztecAddress,
  snap?: Snapshot,
): Promise<PrimaryResolution> {
  const snapshot = snap ?? (await reader.snapshot());
  const primary = await reader.getPrimary(address, snapshot);
  if (!primary.present) return { status: "none", snapshot };

  const [record, forward, published] = await Promise.all([
    reader.getName(primary.node, snapshot),
    reader.getAddress(primary.node, primary.generation, snapshot),
    reader.getPublishedLabel(primary.node, snapshot),
  ]);
  if (record.generation !== primary.generation)
    return { status: "stale", reason: "generation_changed", snapshot };
  if (nameStatus(record, snapshot.timestamp) !== "active")
    return { status: "stale", reason: "expired", snapshot };
  if (reader.modular && !(await reader.inspectResolver(primary.node, primary.generation, snapshot)).verified)
    return { status: "stale", reason: "untrusted_resolver", snapshot };
  if (!forward.present || !forward.addr.equals(address)) {
    return { status: "stale", reason: "forward_mismatch", snapshot };
  }
  if (forward.bindingVersion !== primary.bindingVersion) {
    return { status: "stale", reason: "binding_version_changed", snapshot };
  }
  if (!published.present)
    return { status: "label_unavailable", node: primary.node, snapshot };

  let label: Label;
  try {
    label = reader.extended ? normalizeName(await reader.getPublishedName(primary.node, snapshot), { allowSubnames: true }) : unpackLabel(published.packedLabel, published.labelLen);
  } catch (e) {
    const error = toAnsError(e);
    if (error.code !== "corrupt_data" && error.code !== "invalid_argument") throw error;
    return { status: "label_unavailable", node: primary.node, snapshot };
  }
  if ((await nodeOf(label)) !== primary.node) {
    return { status: "label_unavailable", node: primary.node, snapshot };
  }
  return {
    status: "verified",
    name: label.label,
    node: primary.node,
    generation: primary.generation,
    bindingVersion: primary.bindingVersion,
    expiresAt: record.expiresAt,
    snapshot,
  };
}

export type BatchEntry =
  | PrimaryResolution
  | { status: "error"; error: AnsError };

/**
 * Resolves many addresses against one snapshot. Duplicates are resolved once; a failure of one address is reported
 * per entry, while a failure to reach the node at all throws.
 */
export async function resolvePrimaryMany(
  reader: RegistryReader,
  addresses: AztecAddress[],
  opts: { concurrency?: number; snapshot?: Snapshot } = {},
): Promise<Map<string, BatchEntry>> {
  const concurrency = opts.concurrency ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new AnsError("invalid_argument", "concurrency must be a positive integer");
  if (addresses.length === 0) return new Map();
  const snapshot = opts.snapshot ?? (await reader.snapshot());
  const unique = [...new Map(addresses.map((a) => [a.toString(), a])).values()];
  const out = new Map<string, BatchEntry>();
  const queue = [...unique];
  let networkFailures = 0;
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        out.set(a.toString(), await resolvePrimary(reader, a, snapshot));
      } catch (e) {
        const error = toAnsError(e);
        if (error.code === "network") networkFailures++;
        out.set(a.toString(), { status: "error", error });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, unique.length) },
      worker,
    ),
  );
  if (unique.length > 0 && networkFailures === unique.length) {
    throw new AnsError("network", "node unreachable for every address");
  }
  return out;
}

export async function resolveChainAddress(reader: RegistryReader, name: string, chain: string) {
  const key = chainAddressKey(chain), info = await getName(reader, name);
  if (info.status !== 'active') return undefined;
  const address = await reader.getTextRecord(info.node, info.record.generation, key, info.snapshot);
  if (!address) return undefined;
  return validateChainAddress(chain, address);
}
