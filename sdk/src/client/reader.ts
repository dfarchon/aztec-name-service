import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BlockNumber, Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { DomainSeparator } from '@aztec-labs/constants';

import modular from '../artifacts/modular-metadata.json' with { type: 'json' };
import { PACKED_LEN } from '../core/constants.js';
import { registryProtocol, registryProtocols } from '../core/registry-protocol.js';
import { AnsError, toAnsError } from '../core/errors.js';
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
export class RegistryReader {
  private configCache?: RegistryConfig;
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
  ) {
    this.modular = registryProtocol(classId).modular;
    this.currentClass = classId;
  }

  /**
   * Pins the deployment: reads chain id and rollup version from the node and, unless disabled, checks that the
   * contract at `registry` runs exactly the class this SDK was built for.
   */
  static async connect(
    node: AztecNode,
    registry: AztecAddress,
    opts: { verifyClass?: boolean } = {},
  ) {
    try {
      const [infoResult, instanceResult] = await Promise.allSettled([
        Promise.resolve().then(() => node.getNodeInfo()),
        opts.verifyClass === false
          ? undefined
          : Promise.resolve().then(() => node.getContract(registry)),
      ]);
      if (infoResult.status === 'rejected') throw infoResult.reason;
      if (instanceResult.status === 'rejected') throw instanceResult.reason;
      const info = infoResult.value,
        instance = instanceResult.value;
      let classId = registryProtocols.legacy.classId;
      if (opts.verifyClass !== false) {
        if (!instance) throw new AnsError('wrong_deployment', `no contract at ${registry}`);
        classId = instance.currentContractClassId.toString();
        const protocol = registryProtocol(classId);
        const original = instance.originalContractClassId?.toString();
        if (original && registryProtocol(original).version !== protocol.version)
          throw new AnsError('wrong_deployment', 'registry implementation is incompatible with its original storage');
      }
      return new RegistryReader(
        node,
        {
          chainId: BigInt(info.l1ChainId),
          rollupVersion: BigInt(info.rollupVersion),
          registry,
          protocolVersion: registryProtocol(classId).version,
        },
        classId,
      );
    } catch (e) {
      throw toAnsError(e);
    }
  }

  get registry() {
    return this.deployment.registry;
  }

  async snapshot(finality: Finality = 'proposed'): Promise<Snapshot> {
    const [data] = await Promise.all([
      this.guard(() => this.node.getBlockData(finality)),
      this.modular ? this.assertCurrentClass() : undefined,
    ]);
    if (!data) throw new AnsError('network', `node has no ${finality} block`);
    return {
      blockNumber: Number(data.header.globalVariables.blockNumber),
      blockHash: data.blockHash.toString(),
      timestamp: BigInt(data.header.globalVariables.timestamp),
      finality,
    };
  }

  /** True when the block a snapshot was taken from is still part of the chain (no reorg since). */
  async isCanonical(snap: Snapshot): Promise<boolean> {
    const data = await this.guard(() => this.node.getBlockData(BlockNumber(snap.blockNumber)));
    return !!data && data.blockHash.toString() === snap.blockHash;
  }

  async getConfig(snap?: Snapshot): Promise<RegistryConfig> {
    if (!this.modular && this.configCache) return this.configCache;
    const s = snap ?? (await this.snapshot());
    if (this.modular) {
      await this.assertCurrentClass();
      const { registrar } = await this.getModules(s);
      const tiered = (await this.assertModule(registrar, 'registrar', s)) === 'registrarTiered';
      const [[feeToken, treasury, annualPrice, priceVersion], tiers] = await Promise.all([
        this.readFields(BigInt(modular.registrar.storage.config), 4, s, registrar),
        tiered
          ? this.readFields(BigInt(modular.registrarTiered.storage.length_prices), 2, s, registrar)
          : undefined,
      ]);
      return {
        feeToken: AztecAddress.fromBigIntUnsafe(feeToken),
        treasury: AztecAddress.fromBigIntUnsafe(treasury),
        annualPrice,
        priceVersion: Number(priceVersion),
        registrar,
        ...(tiers ? { lengthPrices: { three: tiers[0], four: tiers[1] } } : {}),
      };
    }
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
    throw new AnsError('corrupt_data', 'subname ancestry exceeds maximum depth');
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
    if (count > 64n) throw new AnsError('corrupt_data', 'record count exceeds limit');
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
            if (e instanceof AnsError && e.code === 'corrupt_data') return undefined;
            throw e;
          }
          const valueKey = await hashWithSeparator([scope, key], TEXT_DOMAIN);
          const words = await this.readMap(this.slots.text_values.slot, valueKey, 9, snap);
          try {
            return [decodedKey, decodeTextValue(words.slice(0, 8), Number(words[8]))] as const;
          } catch (e) {
            if (e instanceof AnsError && e.code === 'corrupt_data') return undefined;
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
    if (depth > 4) throw new AnsError('corrupt_data', 'name exceeds maximum depth');
    const published = await this.getPublishedLabel(node, snap);
    if (!published.present) throw new AnsError('corrupt_data', 'name label is unavailable');
    const leaf = unpackLabel(published.packedLabel, published.labelLen).label;
    const { parent } = await this.getParent(node, snap);
    const name = parent ? `${leaf}.${await this.getPublishedName(parent, snap, depth + 1)}` : leaf;
    if ((await nodeOf(normalizeName(name, { allowSubnames: true }))) !== node)
      throw new AnsError('corrupt_data', 'name does not match node');
    return name;
  }

  async getCommit(c: bigint, snap: Snapshot): Promise<CommitRecord> {
    const [f] = await this.readMap(this.slots.commits.slot, c, PACKED_LEN.CommitRecord, snap);
    return unpackCommit(f);
  }

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
  async assertCurrentClass() {
    const instance = await this.guard(() => this.node.getContract(this.registry));
    const id = instance?.currentContractClassId.toString();
    if (!id || registryProtocol(id).version !== this.deployment.protocolVersion)
      throw new AnsError(
        'wrong_deployment',
        'registry upgraded to an unsupported class; update the SDK',
      );
    this.currentClass = id;
    return id;
  }

  /** Verifies a module's class and registry binding; returns which supported implementation it is. */
  async assertModule(address: AztecAddress, kind: 'registrar' | 'resolver', snap: Snapshot) {
    const instance = await this.guard(() => this.node.getContract(address));
    const classId = instance?.currentContractClassId.toString();
    const impl = (kind === 'registrar' ? (['registrar', 'registrarTiered'] as const) : (['resolver'] as const)).find(
      (k) => modular[k].classId === classId,
    );
    if (!impl) throw new AnsError('wrong_deployment', `unsupported ${kind} class`);
    const [registry] = await this.readFields(
      BigInt(modular[impl].storage.registry),
      1,
      snap,
      address,
    );
    if (registry !== this.registry.toBigInt())
      throw new AnsError('wrong_deployment', `${kind} belongs to another registry`);
    return impl;
  }

  async getModules(snap?: Snapshot) {
    if (!this.modular)
      throw new AnsError('invalid_argument', 'this registry has no replaceable modules');
    const s = snap ?? (await this.snapshot());
    const [registrar, resolver, revision] = await this.readFields(
      this.slots.modules.slot.toBigInt(),
      3,
      s,
    );
    if (!registrar || !resolver || !revision)
      throw new AnsError('wrong_deployment', 'registry modules are not initialized');
    return {
      registrar: AztecAddress.fromBigIntUnsafe(registrar),
      resolver: AztecAddress.fromBigIntUnsafe(resolver),
      revision: Number(revision),
    };
  }

  async getResolver(node: bigint, generation: number, snap?: Snapshot) {
    if (!this.modular) return this.registry;
    const s = snap ?? (await this.snapshot());
    const [address] = await this.readMap(
      this.slots.resolvers.slot,
      await recordKey(node, generation),
      1,
      s,
    );
    const resolver = AztecAddress.fromBigIntUnsafe(address);
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
      const err = toAnsError(e);
      throw err.code === 'reverted' ? new AnsError('network', err.message, e) : err;
    }
  }
}
