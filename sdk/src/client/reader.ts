import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BlockNumber, Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { DomainSeparator } from '@aztec-labs/constants';

import { isV8Class, readCoreUpgrade, type UpgradeProfile } from './core-upgrade.js';
import modular from '../artifacts/modular-metadata.json' with { type: 'json' };
import { PACKED_LEN } from '../core/constants.js';
import { registryProtocol, registryProtocols } from '../core/registry-protocol.js';
import { FogError, toFogError } from '../core/errors.js';
import { nodeOf, hashWithSeparator, primaryKey, recordKey } from '../core/hash.js';
import {
  unpackAddressMeta,
  unpackCommit,
  unpackNameMeta,
  unpackPrimaryMeta,
  unpackPublishedMeta,
} from '../core/packing.js';
import type {
  AddressRecord,
  CommitRecord,
  Deployment,
  Finality,
  NameRecord,
  LaunchEligibility,
  PrimaryRecord,
  PublishedLabel,
  RegistryConfig,
  Snapshot,
} from '../core/types.js';

import { normalizeName, unpackLabel } from '../core/label.js';
import {
  decodeRecordKey,
  decodeTextValue,
  encodeRecordKey,
  TEXT_DOMAIN,
  INDEX_DOMAIN,
} from '../core/records.js';

/**
 * Wallet-free public reads straight from node storage. Every read takes a snapshot so one resolution never mixes
 * blocks. Layouts follow the packed `types.nr` structs; concurrent reads are batched by the node client.
 */
export type ResolverInspection = {
  address: AztecAddress;
  verified: boolean;
  isDefault: boolean;
  reason?: 'zero' | 'unknown_class' | 'other_registry';
};

/** Storage at one block hash never changes, so per-snapshot reads are shared until a few newer snapshots arrive. */
const SNAPSHOT_MEMO_LIMIT = 4;

export class RegistryReader {
  private configCache?: RegistryConfig;
  private snapshotMemo = new Map<string, Map<string, Promise<unknown>>>();
  readonly modular: boolean;
  get extended() {
    return registryProtocol(this.currentClass).extended;
  }
  get slots() {
    return registryProtocol(this.currentClass).slots;
  }
  private currentClass: string;
  get classId() {
    return this.currentClass;
  }

  private constructor(
    readonly node: AztecNode,
    readonly deployment: Deployment,
    classId = registryProtocols.legacy.classId,
    readonly upgradeProfile: UpgradeProfile = {},
  ) {
    this.modular = registryProtocol(classId).modular;
    this.currentClass = classId;
  }

  /**
   * Pins the deployment: reads chain id and rollup version from the node and checks that the
   * contract at `registry` runs exactly the class this SDK was built for.
   */
  static async connect(
    node: AztecNode,
    registry: AztecAddress,
    opts: { verifyClass?: boolean; allowRehearsalSuccessor?: boolean } = {},
  ) {
    try {
      if (opts.verifyClass === false) throw new FogError('invalid_argument', 'contract class verification cannot be disabled');
      const [infoResult, instanceResult] = await Promise.allSettled([
        Promise.resolve().then(() => node.getNodeInfo()),
        Promise.resolve().then(() => node.getContract(registry)),
      ]);
      if (infoResult.status === 'rejected') throw infoResult.reason;
      if (instanceResult.status === 'rejected') throw instanceResult.reason;
      const info = infoResult.value;
      const instance = instanceResult.value;
      if (!instance) throw new FogError('wrong_deployment', `no contract at ${registry}`);
      const classId = instance.currentContractClassId.toString();
      const protocol = registryProtocol(classId);
      const original = instance.originalContractClassId?.toString();
      if (original && registryProtocol(original).version !== protocol.version) {
        throw new FogError('wrong_deployment', 'registry implementation is incompatible with its original storage');
      }
      const reader = new RegistryReader(
        node,
        {
          chainId: BigInt(info.l1ChainId),
          rollupVersion: BigInt(info.rollupVersion),
          registry,
          protocolVersion: protocol.version,
        },
        classId,
        { allowRehearsalSuccessor: opts.allowRehearsalSuccessor },
      );
      if (isV8Class(classId)) await reader.snapshot();
      return reader;
    } catch (e) {
      throw toFogError(e);
    }
  }

  get registry() {
    return this.deployment.registry;
  }

  async snapshot(finality: Finality = 'proposed'): Promise<Snapshot> {
    // Bounded retry for a reorg of N; advancing the latest head is not a failure.
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await this.guard(() => this.node.getBlockData(finality));
      if (!data) throw new FogError('network', `node has no ${finality} block`);
      const snap: Snapshot = {
        blockNumber: Number(data.header.globalVariables.blockNumber),
        blockHash: data.blockHash.toString(),
        timestamp: BigInt(data.header.globalVariables.timestamp),
        finality,
      };
      if (this.modular) await this.classAt(snap);
      if (await this.isCanonical(snap)) return snap;
    }
    throw new FogError('network', 'could not obtain a canonical registry snapshot after three attempts');
  }

  /** True when the block a snapshot was taken from is still part of the chain (no reorg since). */
  async isCanonical(snap: Snapshot): Promise<boolean> {
    const data = await this.guard(() => this.node.getBlockData(BlockNumber(snap.blockNumber)));
    return !!data && data.blockHash.toString() === snap.blockHash;
  }

  async getConfig(snap?: Snapshot): Promise<RegistryConfig> {
    if (!this.modular && this.configCache) return this.configCache;
    const s = snap ?? (await this.snapshot());
    if (this.modular) return this.memo(s, 'config', () => this.readModularConfig(s));
    const [feeToken, treasury, annualPrice, priceVersion] = await this.readFields(
      this.slots.config.slot.toBigInt(),
      PACKED_LEN.RegistryConfig,
      s,
    );
    this.configCache = {
      feeToken: AztecAddress.fromBigIntUnsafe(feeToken),
      treasury: AztecAddress.fromBigIntUnsafe(treasury),
      annualPrice,
      priceVersion: Number(priceVersion),
    };
    return this.configCache;
  }

  private async readModularConfig(s: Snapshot): Promise<RegistryConfig> {
    await this.classAt(s);
    const { registrar } = await this.getModules(s);
    const [kind, [feeToken, treasury, annualPrice, priceVersion]] = await Promise.all([
      this.assertModule(registrar, 'registrar', s),
      this.readFields(BigInt(modular.registrar.storage.config), 4, s, registrar),
    ]);
    const tiered = kind === 'registrarTiered' || kind === 'registrarLaunch';
    const launch = kind === 'registrarLaunch';
    const [tiers, policy, cap] = await Promise.all([
      tiered ? this.readFields(BigInt(modular.registrarTiered.storage.length_prices), 2, s, registrar) : undefined,
      launch ? this.readFields(BigInt(modular.registrarLaunch.storage.policy), 2, s, registrar) : undefined,
      launch ? this.readFields(BigInt(modular.registrarLaunch.storage.max_renew_ahead), 1, s, registrar) : undefined,
    ]);
    return {
      feeToken: AztecAddress.fromBigIntUnsafe(feeToken),
      treasury: AztecAddress.fromBigIntUnsafe(treasury),
      annualPrice,
      priceVersion: Number(priceVersion),
      registrar,
      ...(policy ? { launch: { minPublicLength: Number(policy[0]), paused: policy[1] !== 0n, maxRenewAhead: cap![0] } } : {}),
      ...(tiers ? { lengthPrices: { three: tiers[0], four: tiers[1] } } : {}),
    };
  }

  /** The registry class check at one snapshot, shared by every read of that snapshot. */
  private async classAt(s: Snapshot) {
    this.currentClass = await this.memo(s, 'class', () => this.assertCurrentClass(s));
    return this.currentClass;
  }

  /**
   * Shares one in-flight or settled read per block hash and key. Failures are not kept, so a retry reads again.
   */
  private memo<T>(s: Snapshot, key: string, read: () => Promise<T>): Promise<T> {
    const id = `${s.blockNumber}:${s.blockHash}`;
    let entries = this.snapshotMemo.get(id);
    if (!entries) {
      entries = new Map();
      this.snapshotMemo.set(id, entries);
      while (this.snapshotMemo.size > SNAPSHOT_MEMO_LIMIT) this.snapshotMemo.delete(this.snapshotMemo.keys().next().value!);
    }
    const hit = entries.get(key);
    if (hit) return hit as Promise<T>;
    const pending = read();
    entries.set(key, pending);
    pending.catch(() => {
      if (entries.get(key) === pending) entries.delete(key);
    });
    return pending;
  }

  /**
   * Lifecycle and public owner live in two slots. Reads are pinned to the same snapshot.
   */
  private async rawName(node: bigint, snap: Snapshot): Promise<NameRecord> {
    const [[meta], [owner]] = await Promise.all([
      this.readMap(this.slots.names.slot, node, PACKED_LEN.NameMeta, snap),
      this.readMap(this.slots.owners.slot, node, 1, snap),
    ]);
    return {
      ...unpackNameMeta(meta),
      owner: AztecAddress.fromBigIntUnsafe(owner),
    };
  }

  /**
   * Reads a name's lifecycle record at `snap`, clamping subname expiry to every ancestor's lease
   * and zeroing `expiresAt` if any ancestor was re-registered under a newer generation.
   */
  async getName(node: bigint, snap: Snapshot): Promise<NameRecord> {
    const record = await this.rawName(node, snap);
    if (!this.extended) return record;
    let current = node,
      expiry = record.expiresAt;
    for (let depth = 0; depth < 5; depth++) {
      const link = await this.getParent(current, snap);
      if (!link.parent) return { ...record, expiresAt: expiry };
      const parent = await this.rawName(link.parent, snap);
      if (!parent.generation || parent.generation !== link.parentGeneration)
        return { ...record, expiresAt: 0n };
      if (parent.expiresAt < expiry) expiry = parent.expiresAt;
      current = link.parent;
    }
    throw new FogError('corrupt_data', 'subname ancestry exceeds maximum depth');
  }

  async getParent(node: bigint, snap: Snapshot) {
    if (!this.extended) return { parent: 0n, parentGeneration: 0, depth: 0 };
    const [parent, generation, depth] = await this.readMap(this.slots.parents.slot, node, 3, snap);
    return { parent, parentGeneration: Number(generation), depth: Number(depth) };
  }

  async getManager(node: bigint, generation: number, snap: Snapshot) {
    if (!this.extended) return AztecAddress.ZERO;
    const [manager] = await this.readMap(
      this.slots.managers.slot,
      await recordKey(node, generation),
      1,
      snap,
    );
    return AztecAddress.fromBigIntUnsafe(manager);
  }

  async getTransfer(node: bigint, generation: number, snap: Snapshot) {
    if (!this.extended) return { recipient: AztecAddress.ZERO, expiresAt: 0n };
    const [recipient, expiresAt] = await this.readMap(
      this.slots.transfers.slot,
      await recordKey(node, generation),
      2,
      snap,
    );
    return { recipient: AztecAddress.fromBigIntUnsafe(recipient), expiresAt };
  }

  /** Read a known key without enumerating every profile record. Empty or inactive records are absent. */
  async getTextRecord(
    node: bigint,
    generation: number,
    key: string,
    snap: Snapshot,
  ): Promise<string | undefined> {
    const encodedKey = encodeRecordKey(key);
    if (!this.extended) return undefined;
    const current = await this.getName(node, snap);
    if (current.generation !== generation || current.expiresAt <= snap.timestamp) return undefined;
    const scope = await recordKey(node, generation);
    const valueKey = await hashWithSeparator([scope, encodedKey], TEXT_DOMAIN);
    const words = await this.readMap(this.slots.text_values.slot, valueKey, 9, snap);
    return decodeTextValue(words.slice(0, 8), Number(words[8])) || undefined;
  }

  async getTextRecords(
    node: bigint,
    generation: number,
    snap: Snapshot,
  ): Promise<Record<string, string>> {
    if (!this.extended) return {};
    const current = await this.getName(node, snap);
    if (current.generation !== generation || current.expiresAt <= snap.timestamp) return {};
    const scope = await recordKey(node, generation);
    const [count] = await this.readMap(this.slots.text_count.slot, scope, 1, snap);
    if (count > 64n) throw new FogError('corrupt_data', 'record count exceeds limit');
    const entries: (readonly [string, string])[] = [];
    // The protocol permits raw Field keys/bytes. Return SDK-compatible records without letting an
    // unsupported entry hide the rest of a profile; transport errors must still fail the read.
    for (let offset = 0; offset < Number(count); offset += 4) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(4, Number(count) - offset) }, async (_, j) => {
          const index = await hashWithSeparator([scope, offset + j], INDEX_DOMAIN);
          const [key] = await this.readMap(this.slots.text_keys.slot, index, 1, snap);
          let decodedKey: string;
          try {
            decodedKey = decodeRecordKey(key);
          } catch (e) {
            if (e instanceof FogError && e.code === 'corrupt_data') return undefined;
            throw e;
          }
          const valueKey = await hashWithSeparator([scope, key], TEXT_DOMAIN);
          const words = await this.readMap(this.slots.text_values.slot, valueKey, 9, snap);
          try {
            return [decodedKey, decodeTextValue(words.slice(0, 8), Number(words[8]))] as const;
          } catch (e) {
            if (e instanceof FogError && e.code === 'corrupt_data') return undefined;
            throw e;
          }
        }),
      );
      entries.push(
        ...batch.filter((entry): entry is readonly [string, string] => entry !== undefined),
      );
    }
    return Object.fromEntries(entries.filter(([, value]) => value.length));
  }

  /** Reconstruct and verify every label, including the parent chain. */
  async getPublishedName(node: bigint, snap: Snapshot, depth = 0): Promise<string> {
    if (depth > 4) throw new FogError('corrupt_data', 'name exceeds maximum depth');
    const published = await this.getPublishedLabel(node, snap);
    if (!published.present) throw new FogError('corrupt_data', 'name label is unavailable');
    const leaf = unpackLabel(published.packedLabel, published.labelLen).label;
    const { parent } = await this.getParent(node, snap);
    const name = parent ? `${leaf}.${await this.getPublishedName(parent, snap, depth + 1)}` : leaf;
    if ((await nodeOf(normalizeName(name, { allowSubnames: true }))) !== node)
      throw new FogError('corrupt_data', 'name does not match node');
    return name;
  }

  async getCommit(c: bigint, snap: Snapshot): Promise<CommitRecord> {
    const [f] = await this.readMap(this.slots.commits.slot, c, PACKED_LEN.CommitRecord, snap);
    return unpackCommit(f);
  }

  /** Raw public record; use resolveAddress/resolvePrimary or inspectResolver to validate resolver trust. */
  async getAddress(node: bigint, generation: number, snap: Snapshot): Promise<AddressRecord> {
    const key = await recordKey(node, generation);
    const [addr, meta] = await this.readMap(
      this.slots.records.slot,
      key,
      PACKED_LEN.AddressRecord,
      snap,
    );
    return {
      ...unpackAddressMeta(meta),
      addr: AztecAddress.fromBigIntUnsafe(addr),
    };
  }

  /** V7 separates editor revisions from holder revisions. Older protocols share the name revision. */
  async getRecordRevision(node: bigint, generation: number, snap: Snapshot): Promise<number> {
    if (registryProtocol(this.currentClass).version < 7) return (await this.getName(node, snap)).revision;
    const [revision] = await this.readMap(this.slots.record_revisions.slot, await recordKey(node, generation), 1, snap);
    if (revision > 0xffffffffn) throw new FogError('corrupt_data', 'record revision exceeds u32');
    return Number(revision);
  }

  async getPrimary(address: AztecAddress, snap: Snapshot): Promise<PrimaryRecord> {
    const key = await primaryKey(address);
    const [node, meta] = await this.readMap(
      this.slots.primary.slot,
      key,
      PACKED_LEN.PrimaryRecord,
      snap,
    );
    return { ...unpackPrimaryMeta(meta), node };
  }

  async getPublishedLabel(node: bigint, snap: Snapshot): Promise<PublishedLabel> {
    const [packedLabel, meta] = await this.readMap(
      this.slots.published_labels.slot,
      node,
      PACKED_LEN.PublishedLabel,
      snap,
    );
    return { ...unpackPublishedMeta(meta), packedLabel };
  }

  private async readMap(mapSlot: Fr, key: bigint, len: number, snap: Snapshot) {
    const base = await hashWithSeparator(
      [mapSlot.toBigInt(), key],
      BigInt(DomainSeparator.PUBLIC_STORAGE_MAP_SLOT),
    );
    return this.readFields(base, len, snap);
  }

  private readFields(
    base: bigint,
    len: number,
    snap: Snapshot,
    address = this.registry,
  ): Promise<bigint[]> {
    const block = BlockNumber(snap.blockNumber);
    return this.guard(() =>
      Promise.all(
        Array.from({ length: len }, (_, i) =>
          this.node
            .getPublicStorageAt(block, address, new Fr(base + BigInt(i)))
            .then((v) => v.toBigInt()),
        ),
      ),
    );
  }

  /** Recheck before new snapshots/writes; an unrecognized upgrade is never read using a guessed layout. */
  async assertCurrentClass(snap?: Snapshot) {
    if (isV8Class(this.currentClass)) {
      const state = await this.getCoreUpgradeState(snap);
      this.currentClass = state.currentClass;
      return this.currentClass;
    }
    const instance = await this.guard(() => this.node.getContract(this.registry, snap ? BlockNumber(snap.blockNumber) : undefined));
    const id = instance?.currentContractClassId.toString();
    if (!id || registryProtocol(id).version !== this.deployment.protocolVersion)
      throw new FogError('wrong_deployment', 'registry upgraded to an unsupported class; update the SDK');
    this.currentClass = id;
    return id;
  }

  async getCoreUpgradeState(snap?: Snapshot) {
    if (!isV8Class(this.currentClass)) throw new FogError('unsupported', 'core upgrades require an independent V8 registry');
    let s = snap;
    if (!s) {
      const data = await this.guard(() => this.node.getBlockData('proposed'));
      if (!data) throw new FogError('network', 'node has no proposed block');
      s = { blockNumber: Number(data.header.globalVariables.blockNumber), blockHash: String(data.blockHash), timestamp: BigInt(data.header.globalVariables.timestamp), finality: 'proposed' };
    }
    return this.guard(() => readCoreUpgrade(this.node, this.registry, s!, this.upgradeProfile));
  }

  /** Reserved status at one snapshot; other registrar kinds have no launch reservations. */
  async isReserved(node: bigint, snap?: Snapshot): Promise<boolean> {
    const s = snap ?? await this.snapshot();
    const config = await this.getConfig(s);
    if (!config.launch) return false;
    const slot = await hashWithSeparator([BigInt(modular.registrarLaunch.storage.reserved), node], BigInt(DomainSeparator.PUBLIC_STORAGE_MAP_SLOT));
    return (await this.readFields(slot, 1, s, config.registrar))[0] !== 0n;
  }

  /** Public launch channel only. Availability/ownership is queried separately; admin mint and renewal bypass this policy. */
  async eligibility(name: string, snap?: Snapshot): Promise<LaunchEligibility> {
    const label = normalizeName(name);
    const s = snap ?? await this.snapshot();
    const config = await this.getConfig(s);
    if (!config.launch) return 'open';
    if (config.launch.paused) return 'paused';
    if (label.len < config.launch.minPublicLength) return 'too_short';
    return await this.isReserved(await nodeOf(label), s) ? 'reserved' : 'open';
  }

  /** Verifies a module's class and registry binding; returns which supported implementation it is. */
  assertModule(address: AztecAddress, kind: 'registrar' | 'resolver', snap: Snapshot) {
    return this.memo(snap, `module:${kind}:${address}`, () => this.readModule(address, kind, snap));
  }

  private async readModule(address: AztecAddress, kind: 'registrar' | 'resolver', snap: Snapshot) {
    const instance = await this.guard(() => this.node.getContract(address, BlockNumber(snap.blockNumber)));
    const classId = instance?.currentContractClassId.toString();
    const impl = (kind === 'registrar' ? (['registrar', 'registrarTiered', 'registrarLaunch'] as const) : (['resolver'] as const)).find(
      (k) => modular[k].classId === classId,
    );
    if (!impl) throw new FogError('wrong_deployment', `unsupported ${kind} class`);
    const [registry] = await this.readFields(
      BigInt(modular[impl].storage.registry),
      1,
      snap,
      address,
    );
    if (registry !== this.registry.toBigInt())
      throw new FogError('wrong_deployment', `${kind} belongs to another registry`);
    return impl;
  }

  async getModules(snap?: Snapshot) {
    if (!this.modular)
      throw new FogError('invalid_argument', 'this registry has no replaceable modules');
    const s = snap ?? (await this.snapshot());
    const [registrar, resolver, revision] = await this.memo(s, 'modules', () =>
      this.readFields(this.slots.modules.slot.toBigInt(), 3, s),
    );
    if (!registrar || !resolver || !revision)
      throw new FogError('wrong_deployment', 'registry modules are not initialized');
    return {
      registrar: AztecAddress.fromBigIntUnsafe(registrar),
      resolver: AztecAddress.fromBigIntUnsafe(resolver),
      revision: Number(revision),
    };
  }

  private async resolverAddress(node: bigint, generation: number, snap: Snapshot) {
    const [address] = await this.readMap(this.slots.resolvers.slot, await recordKey(node, generation), 1, snap);
    return AztecAddress.fromBigIntUnsafe(address);
  }

  /** Inspect an inherited resolver without hiding transport failures. Class and registry binding are both required. */
  async inspectResolver(node: bigint, generation: number, snap?: Snapshot): Promise<ResolverInspection> {
    if (!this.modular) return { address: this.registry, verified: true, isDefault: true };
    const s = snap ?? await this.snapshot();
    const [address, modules] = await Promise.all([this.resolverAddress(node, generation, s), this.getModules(s)]);
    const isDefault = address.equals(modules.resolver);
    if (address.isZero()) return { address, verified: false, isDefault, reason: 'zero' };
    try {
      await this.assertModule(address, 'resolver', s);
      return { address, verified: true, isDefault };
    } catch (error) {
      if (!(error instanceof FogError) || error.code !== 'wrong_deployment') throw error;
      return { address, verified: false, isDefault,
        reason: error.message === 'resolver belongs to another registry' ? 'other_registry' : 'unknown_class' };
    }
  }

  async getResolver(node: bigint, generation: number, snap?: Snapshot) {
    if (!this.modular) return this.registry;
    const s = snap ?? await this.snapshot();
    const resolver = await this.resolverAddress(node, generation, s);
    await this.assertModule(resolver, 'resolver', s);
    return resolver;
  }

  async getAdministrator(snap?: Snapshot): Promise<AztecAddress | undefined> {
    const slot = this.slots.administrator?.slot;
    if (!slot) return undefined;
    const s = snap ?? (await this.snapshot());
    const [address] = await this.readFields(slot.toBigInt(), 1, s);
    return AztecAddress.fromBigIntUnsafe(address);
  }

  async getLegacyRegistry(snap?: Snapshot): Promise<AztecAddress | undefined> {
    if (!this.modular) return undefined;
    const s = snap ?? (await this.snapshot());
    const [address] = await this.readFields(this.slots.legacy.slot.toBigInt(), 1, s);
    return address ? AztecAddress.fromBigIntUnsafe(address) : undefined;
  }

  async getLegacyName(node: bigint, snap: Snapshot): Promise<NameRecord | undefined> {
    if (!this.modular) return;
    const [address] = await this.readFields(this.slots.legacy.slot.toBigInt(), 1, snap);
    if (!address) return;
    const legacy = await RegistryReader.connect(this.node, AztecAddress.fromBigIntUnsafe(address));
    return legacy.getName(node, snap);
  }

  /** Transport failures become `network` errors so callers never mistake them for empty state. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = toFogError(e);
      throw err.code === 'reverted' ? new FogError('network', err.message, e) : err;
    }
  }
}
