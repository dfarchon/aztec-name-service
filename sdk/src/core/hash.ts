import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { poseidon2Hash } from "@zkpassport/poseidon2";

import { DOMAIN, ROOT_NODE } from "./constants.js";
import type { Label } from "./label.js";

/** `poseidon2_hash_with_separator(inputs, separator)` from the Noir protocol library. */
export async function hashWithSeparator(
  inputs: (bigint | number | boolean)[],
  separator: bigint,
): Promise<bigint> {
  const fields = [separator, ...inputs].map(
    (v) => new Fr(typeof v === "boolean" ? (v ? 1n : 0n) : BigInt(v)),
  );
  return poseidon2Hash(fields.map((field) => field.toBigInt()));
}

export function nodeFromPacked(packed: bigint, len: number): Promise<bigint> {
  return hashWithSeparator([len, packed], DOMAIN.LABEL_V1).then((labelKey) =>
    hashWithSeparator([ROOT_NODE, labelKey], DOMAIN.NODE_V1),
  );
}

export async function nodeOf(label: Label): Promise<bigint> {
  const parent = label.parent ? await nodeOf(label.parent) : ROOT_NODE;
  const key = await hashWithSeparator([label.len, label.packed], DOMAIN.LABEL_V1);
  return hashWithSeparator([parent, key], DOMAIN.NODE_V1);
}

export function recordKey(
  node: bigint,
  generation: number | bigint,
): Promise<bigint> {
  return hashWithSeparator([node, generation, 0n], DOMAIN.RECORD_KEY_V1);
}

export function primaryKey(address: AztecAddress): Promise<bigint> {
  return hashWithSeparator([0n, address.toBigInt()], DOMAIN.PRIMARY_KEY_V1);
}

export type RegisterCommitmentInput = {
  registrar?: AztecAddress;
  chainId: bigint;
  registry: AztecAddress;
  node: bigint;
  expectedGeneration: number;
  owner: AztecAddress;
  duration: bigint;
  feeToken: AztecAddress;
  treasury: AztecAddress;
  priceVersion: number;
  maxFee: bigint;
  quoteExpiry: bigint;
  secret: bigint;
};

/** `compute_register_commitment`: binds deployment, name, generation, holder, lease and every fee condition. */
export async function registerCommitment(
  i: RegisterCommitmentInput,
): Promise<bigint> {
  const base = await hashWithSeparator(
    [
      i.chainId,
      i.registry.toBigInt(),
      i.node,
      i.expectedGeneration,
      i.owner.toBigInt(),
      i.duration,
      i.feeToken.toBigInt(),
      i.treasury.toBigInt(),
      i.priceVersion,
      i.maxFee,
      i.quoteExpiry,
      i.secret,
    ],
    DOMAIN.REGISTER_V3,
  );
  return i.registrar ? hashWithSeparator([i.registrar.toBigInt(), base], 0x414e535f4d4f44554c41525f5633n) : base;
}
