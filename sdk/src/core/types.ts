import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";

/** Everything a client pins before talking to a registry. */
export type Deployment = {
  chainId: bigint;
  /** Rollup version, part of every authwit message hash. */
  rollupVersion: bigint;
  registry: AztecAddress;
  protocolVersion: number;
};

export type NameRecord = {
  generation: number;
  owner: AztecAddress;
  revision: number;
  expiresAt: bigint;
};

export type CommitRecord = { committedAt: bigint; consumed: boolean };

export type AddressRecord = {
  present: boolean;
  addr: AztecAddress;
  bindingVersion: number;
};

export type PrimaryRecord = {
  present: boolean;
  node: bigint;
  generation: number;
  bindingVersion: number;
};

export type PublishedLabel = {
  present: boolean;
  packedLabel: bigint;
  labelLen: number;
};

export type RegistryConfig = {
  /** V3 immutable fee policy that is currently active. Absent for legacy registries. */
  registrar?: AztecAddress;
  feeToken: AztecAddress;
  treasury: AztecAddress;
  /** 5+ character annual price; the only price when `lengthPrices` is absent. */
  annualPrice: bigint;
  priceVersion: number;
  /** Tiered registrars only: annual prices for 3- and 4-character labels. */
  lengthPrices?: { three: bigint; four: bigint };
};

export type Finality = "proposed" | "checkpointed" | "proven" | "finalized";

/** The block a read was answered from. All reads of one resolution share one snapshot. */
export type Snapshot = {
  blockNumber: number;
  blockHash: string;
  /** Timestamp of that block; the lifecycle is evaluated against it, as the contract would. */
  timestamp: bigint;
  finality: Finality;
};
