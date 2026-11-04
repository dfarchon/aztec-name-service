/**
 * Protocol constants. Every value here mirrors `contracts/name_registry/src/logic.nr`; `test/vectors.test.ts` and the
 * Noir test `test_sdk_vectors` pin both sides to the same outputs.
 */

/** Version of the SDK <-> contract encoding (domains, packing, storage layout). */
export const PROTOCOL_VERSION = 2;

/** ASCII tags packed big-endian into a Field, used as Poseidon2 domain separators. */
export const DOMAIN = {
  LABEL_V1: 0x414e535f4c4142454c5f5631n, // "ANS_LABEL_V1"
  NODE_V1: 0x414e535f4e4f44455f5631n, // "ANS_NODE_V1"
  REGISTER_V3: 0x414e535f52454749535445525f5633n, // "ANS_REGISTER_V3"
  RECORD_KEY_V1: 0x414e535f5245434f52445f5631n, // "ANS_RECORD_V1"
  PRIMARY_KEY_V1: 0x414e535f5052494d4152595f5631n, // "ANS_PRIMARY_V1"
} as const;

export const ROOT_NODE = 0n;
export const MIN_LABEL_LEN = 3;
export const MAX_LABEL_LEN = 31;

export const MIN_COMMIT_AGE = 60n;
/** Default remaining quote lifetime required before reveal, in chain seconds. */
export const REVEAL_MARGIN = 60n;
/** Commit age + reveal margin + 180 seconds for proving, inclusion and checkpoint lag; checked before creating or sending a plan. */
export const COMMIT_QUOTE_MARGIN = MIN_COMMIT_AGE + REVEAL_MARGIN + 180n;
export const MAX_COMMIT_AGE = 86_400n;
export const GRACE_PERIOD = 30n * 86_400n;
export const MIN_DURATION = 365n * 86_400n;
export const MAX_DURATION = 5n * 365n * 86_400n;
export const SECONDS_PER_YEAR = 365n * 86_400n;
export const MAX_ANNUAL_PRICE = 1n << 96n;

/** `transfer_in_private(from, to, amount, authwit_nonce)` of the standard Aztec token. */
export const TRANSFER_IN_PRIVATE_SIGNATURE =
  "transfer_in_private((Field),(Field),u128,Field)";

/** Number of Fields each packed value occupies in public storage (see `types.nr`). */
export const PACKED_LEN = {
  NameMeta: 1,
  CommitRecord: 1,
  AddressRecord: 2,
  PrimaryRecord: 2,
  PublishedLabel: 2,
  RegistryConfig: 4,
} as const;
