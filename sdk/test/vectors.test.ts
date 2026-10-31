// Mirrors contracts/name_registry/src/vectors.nr. Change both together.
import assert from "node:assert/strict";
import { test } from "node:test";

import { AztecAddress } from "@aztec-labs/aztec.js/addresses";

import {
  feeFor,
  nodeOf,
  normalizeName,
  primaryKey,
  recordKey,
  registerCommitment,
  unpackAddressMeta,
  unpackCommit,
  unpackNameMeta,
  unpackPrimaryMeta,
  unpackPublishedMeta,
} from "../src/index.js";

const NODE_ALICE =
  0x1e43ad6ce21bd590eec0cf0102bf2b9c004408b642822c350bd9272a481e4106n;
const addr = (v: bigint) => AztecAddress.fromBigIntUnsafe(v);

test("labels and nodes match Noir", async () => {
  const alice = normalizeName("alice");
  assert.equal(
    alice.packed,
    0x616c6963650000000000000000000000000000000000000000000000000000n,
  );
  assert.equal(await nodeOf(alice), NODE_ALICE);
  assert.equal(
    await nodeOf(normalizeName("a-b-c-123")),
    0x22a3417e9cf5bdc8b7e84dd05e8736cdfb4b247f6eb8c8dac9ec772e58c08e01n,
  );
  assert.equal(
    await nodeOf(normalizeName("abcdefghijklmnopqrstuvwxyz01234")),
    0x13742b846f16f355aae4620bb95641607fc3ed13793db26f468f54a552c20d19n,
  );
});

test("keys and commitments match Noir", async () => {
  assert.equal(
    await recordKey(NODE_ALICE, 1),
    0x2a60ad25054c663434d186658f3d09d36416cc091bf25ea3568a35d6c360659bn,
  );
  assert.equal(
    await primaryKey(addr(0x1234n)),
    0x49d87238c9b3f124e99a67cd5b1054f7fd4598094754af7f53926bc76104ef1n,
  );
  assert.equal(
    await registerCommitment({
      chainId: 31337n,
      registry: addr(0xabcdn),
      node: NODE_ALICE,
      expectedGeneration: 0,
      owner: addr(0x99n),
      duration: 31_536_000n,
      feeToken: addr(0x77n),
      treasury: addr(0x88n),
      priceVersion: 1,
      maxFee: 1000n,
      quoteExpiry: 1_700_000_000n,
      secret: 0x42n,
    }),
    0x5df62081aa93851512f72883c63943eae2a1503c7d48df06759d36a62039596n,
  );
});

test("fees match Noir", () => {
  assert.equal(feeFor(1000n, 31_536_000n), 1000n);
  assert.equal(feeFor(1000n, 86_400n), 3n);
});

test("storage packing decodes the Noir vectors", () => {
  assert.deepEqual(unpackNameMeta(0x6553f1000000000700000003n), {
    generation: 3,
    revision: 7,
    expiresAt: 1_700_000_000n,
  });
  assert.deepEqual(unpackCommit(0x1000000006553f100n), {
    committedAt: 1_700_000_000n,
    consumed: true,
  });
  assert.deepEqual(unpackAddressMeta(0x100000005n), {
    bindingVersion: 5,
    present: true,
  });
  assert.deepEqual(unpackPrimaryMeta(0x10000000900000002n), {
    generation: 2,
    bindingVersion: 9,
    present: true,
  });
  assert.deepEqual(unpackPublishedMeta(0x105n), { labelLen: 5, present: true });
  // Unwritten slots decode to "absent".
  assert.deepEqual(unpackNameMeta(0n), {
    generation: 0,
    revision: 0,
    expiresAt: 0n,
  });
  assert.equal(unpackAddressMeta(0n).present, false);
});
