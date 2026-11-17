import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BlockNumber, Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { DomainSeparator, UPDATED_CLASS_IDS_SLOT, CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS } from '@aztec-labs/constants';
import metadata from '../artifacts/modular-metadata.json' with { type: 'json' };
import { hashWithSeparator } from '../core/hash.js';
import { AnsError } from '../core/errors.js';
import type { Snapshot } from '../core/types.js';

/** All times are Unix seconds; all nonces and exact class IDs are bigint. No simulated views. */
export type UpgradeProposal = { active: boolean; kind: number; from: bigint; to: bigint; nonce: bigint; proposedAt: bigint; readyAt: bigint };
export type UpgradeSchedule = { active: boolean; kind: number; from: bigint; to: bigint; nonce: bigint; activationAt: bigint };
export type CoreUpgradeState = {
  snapshot: Snapshot; originalClass: string; currentClass: string; coreClass: bigint; nonce: bigint;
  pending: UpgradeProposal; scheduled: UpgradeSchedule;
  protocol: { previous: bigint; target: bigint; activationAt: bigint; delay: bigint };
};
export type UpgradeProfile = { allowRehearsalSuccessor?: boolean };
const fail = (message: string): never => { throw new AnsError('wrong_deployment', message); };
const protocolAddress = AztecAddress.fromBigIntUnsafe(BigInt(CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS));
const approvedClasses = (profile: UpgradeProfile) => [metadata.v8.classId, ...(profile.allowRehearsalSuccessor ? [metadata.v8Rehearsal.classId] : [])];
export const isV8Class = (id: string) => id === metadata.v8.classId || id === metadata.v8Rehearsal.classId;
const bool = (value: bigint) => { if (value !== 0n && value !== 1n) fail('invalid upgrade flag'); return value === 1n; };

/** Reads exactly block N. A moving latest head is allowed; only a changed canonical hash for N invalidates it. */
export async function readCoreUpgrade(node: AztecNode, registry: AztecAddress, snap: Snapshot, profile: UpgradeProfile = {}): Promise<CoreUpgradeState> {
  const block = BlockNumber(snap.blockNumber);
  const read = (address: AztecAddress, base: bigint, count: number) => Promise.all(Array.from({ length: count }, (_, i) => node.getPublicStorageAt(block, address, new Fr(base + BigInt(i))).then(v => v.toBigInt())));
  const map = (slot: bigint, key: bigint) => hashWithSeparator([slot, key], BigInt(DomainSeparator.PUBLIC_STORAGE_MAP_SLOT));
  const slots = metadata.v8.storage;
  const protocolSlot = await map(BigInt(UPDATED_CLASS_IDS_SLOT), registry.toBigInt());
  const [header, instance, core, nonce, pending, scheduled, protocol] = await Promise.all([
    node.getBlockData(block), node.getContract(registry, block),
    read(registry, BigInt(slots.core_class), 1), read(registry, BigInt(slots.upgrade_nonce), 1),
    read(registry, BigInt(slots.pending), 7), read(registry, BigInt(slots.scheduled), 6),
    read(protocolAddress, protocolSlot, 3),
  ]);
  if (!header || String(header.blockHash) !== snap.blockHash || BigInt(header.header.globalVariables.timestamp) !== snap.timestamp) fail('upgrade snapshot header changed');
  const current = instance?.currentContractClassId.toString();
  const original = instance?.originalContractClassId.toString();
  const allowed = approvedClasses(profile);
  if (original !== metadata.v8.classId || !current || !allowed.includes(current)) fail('unknown V8 root or current class; explicit rehearsal profile required');
  const p: UpgradeProposal = { active: bool(pending[0]), kind: Number(pending[1]), from: pending[2], to: pending[3], nonce: pending[4], proposedAt: pending[5], readyAt: pending[6] };
  const s: UpgradeSchedule = { active: bool(scheduled[0]), kind: Number(scheduled[1]), from: scheduled[2], to: scheduled[3], nonce: scheduled[4], activationAt: scheduled[5] };
  if (p.active && s.active) fail('pending and scheduled upgrades overlap');
  if ((!p.active && pending.some(value => value !== 0n)) || (!s.active && scheduled.some(value => value !== 0n))) fail('nonempty inactive upgrade record');
  if (nonce[0] >= 1n << 64n || (s.active && s.nonce >= nonce[0])) fail('invalid upgrade nonce history');
  const effective = s.active && snap.timestamp >= s.activationAt ? s.to : core[0];
  if (BigInt(current!) !== effective) fail('application and runtime class mismatch');
  const known = (id: bigint) => allowed.some(value => BigInt(value) === id);
  if (!known(core[0]) || (s.active && s.from !== core[0])) fail('unknown core history');
  const packed = protocol[0];
  const activationAt = packed & 0xffff_ffffn;
  const delayAt = (packed >> 32n) & 0xffff_ffffn;
  const delayPostSet = (packed >> 64n) & 0xffn;
  const delayPreSet = (packed >> 104n) & 0xffn;
  const delayPost = (packed >> 72n) & 0xffff_ffffn;
  const delayPre = (packed >> 112n) & 0xffff_ffffn;
  if (packed >> 144n || delayPostSet > 1n || delayPreSet > 1n) fail('invalid protocol delay encoding');
  const before = delayPreSet ? delayPre : 86400n;
  const after = delayPostSet ? delayPost : 86400n;
  if (before !== 86400n || after !== 86400n) fail('protocol delay differs from fixed policy');
  const delay = snap.timestamp < delayAt ? before : after;
  const previous = protocol[1] || BigInt(original!);
  const target = protocol[2] || BigInt(original!);
  if (!known(previous) || !known(target)) fail('unknown protocol class history');
  const protocolEffective = snap.timestamp < activationAt ? previous : target;
  if (protocolEffective !== effective) fail('protocol and application effective classes differ');
  if (s.active) {
    if (activationAt !== s.activationAt || target !== s.to || previous !== s.from) fail('protocol schedule differs from application schedule');
  } else if (target !== effective) fail('untracked protocol target');
  const edgeChecks: Promise<void>[] = [];
  const checkEdge = async (from: bigint, to: bigint, kind: number) => {
    if (!known(from) || !known(to) || from === to || (kind !== 1 && kind !== 2)) fail('unknown directed upgrade edge');
    const isForward = from === BigInt(metadata.v8.classId) && to === BigInt(metadata.v8Rehearsal.classId);
    const isRollback = from === BigInt(metadata.v8Rehearsal.classId) && to === BigInt(metadata.v8.classId);
    if (!(kind === 1 && isForward || kind === 2 && isRollback)) fail('unreviewed directed upgrade edge');
    const [source, destination, edge] = await Promise.all([
      map(BigInt(slots.releases), from).then(slot => read(registry, slot, 4)),
      map(BigInt(slots.releases), to).then(slot => read(registry, slot, 4)),
      hashWithSeparator([from, to], 0x414e5308n).then(key => map(BigInt(slots.edges), key)).then(slot => read(registry, slot, 3)),
    ]);
    const family = 0x414e535f434f5245n;
    const seq = (id: bigint) => id === BigInt(metadata.v8.classId) ? 1n : 2n;
    if ([source, destination].some(value => value[0] !== 1n || value[1] !== family) || source[2] !== seq(from) || destination[2] !== seq(to) || edge[0] !== 1n || edge[1] !== BigInt(kind)) fail('on-chain release or edge approval mismatch');
  };
  if (p.active) {
    if (p.from !== effective || p.readyAt !== p.proposedAt + 86400n || p.nonce >= nonce[0]) fail('invalid application proposal');
    edgeChecks.push(checkEdge(p.from, p.to, p.kind));
  }
  if (s.active) edgeChecks.push(checkEdge(s.from, s.to, s.kind));
  await Promise.all(edgeChecks);
  // Active class's release must remain approved, including when no proposal exists.
  const release = await read(registry, await map(BigInt(slots.releases), effective), 4);
  if (release[0] !== 1n || release[1] !== 0x414e535f434f5245n || release[2] !== (effective === BigInt(metadata.v8.classId) ? 1n : 2n)) fail('current release attestation mismatch');
  const canonical = await node.getBlockData(block);
  if (!canonical || String(canonical.blockHash) !== snap.blockHash) fail('upgrade snapshot no longer canonical');
  return { snapshot: snap, originalClass: original!, currentClass: current!, coreClass: core[0], nonce: nonce[0], pending: p, scheduled: s, protocol: { previous, target, activationAt, delay } };
}

/** Conservative floor until public real-proof latency has been measured. Caller may require a larger margin. */
export function assertUpgradeInclusionMargin(state: CoreUpgradeState, minimumSeconds = 900n) {
  if (minimumSeconds < 900n) throw new AnsError('invalid_argument', 'upgrade proving/inclusion margin must be at least 900 seconds');
  if (state.scheduled.active && state.snapshot.timestamp < state.scheduled.activationAt && state.scheduled.activationAt - state.snapshot.timestamp <= minimumSeconds)
    throw new AnsError('unsupported', 'too close to core activation to safely prove and include; resume after activation with refreshed artifacts');
}
