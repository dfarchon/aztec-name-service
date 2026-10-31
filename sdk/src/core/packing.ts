/**
 * Decoders for the registry's packed storage, mirroring the `Packable` impls in `contracts/name_registry/src/types.nr`
 * ; Vectors in `test/vectors.test.ts` and `vectors.nr::test_sdk_vectors_packing` pin both sides.
 */

const M8 = 0xffn;
const M32 = 0xffff_ffffn;
const M64 = 0xffff_ffff_ffff_ffffn;

/** `generation (32) | revision (32) | expires_at (64)` */
export function unpackNameMeta(f: bigint) {
  return {
    generation: Number(f & M32),
    revision: Number((f >> 32n) & M32),
    expiresAt: (f >> 64n) & M64,
  };
}

/** `committed_at (64) | consumed (1)` */
export function unpackCommit(f: bigint) {
  return { committedAt: f & M64, consumed: ((f >> 64n) & 1n) === 1n };
}

/** `[addr, binding_version (32) | present (1)]` */
export function unpackAddressMeta(f: bigint) {
  return { bindingVersion: Number(f & M32), present: ((f >> 32n) & 1n) === 1n };
}

/** `[node, generation (32) | binding_version (32) | present (1)]` */
export function unpackPrimaryMeta(f: bigint) {
  return {
    generation: Number(f & M32),
    bindingVersion: Number((f >> 32n) & M32),
    present: ((f >> 64n) & 1n) === 1n,
  };
}

/** `[packed_label, label_len (8) | present (1)]` */
export function unpackPublishedMeta(f: bigint) {
  return { labelLen: Number(f & M8), present: ((f >> 8n) & 1n) === 1n };
}
