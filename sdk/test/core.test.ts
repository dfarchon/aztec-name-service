import assert from "node:assert/strict";
import { test } from "node:test";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";

import {
  annualPriceFor,
  AnsError,
  assertRegistrableLabel,
  chargeFor,
  asciiTagToField,
  GRACE_PERIOD,
  nameStatus,
  type NameRecord,
  normalizeName,
  seal,
  toAnsError,
  unpackLabel,
  unseal,
} from "../src/index.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as AnsError).code;
  }
  return "ok";
};

test("normalizeName canonicalizes and rejects exactly what the contract rejects", () => {
  assert.equal(normalizeName("  Alice ").label, "alice");
  assert.equal(
    normalizeName("alice.aztec", { suffix: ".aztec" }).label,
    "alice",
  );
  assert.equal(normalizeName("a1-b").len, 4);
  assert.equal(
    code(() => normalizeName("ab")),
    "invalid_name",
  );
  assert.equal(
    code(() => normalizeName("a".repeat(32))),
    "invalid_name",
  );
  assert.equal(
    code(() => normalizeName("-abc")),
    "invalid_name",
  );
  assert.equal(
    code(() => normalizeName("abc-")),
    "invalid_name",
  );
  assert.equal(
    code(() => normalizeName("ab_c")),
    "invalid_name",
  );
  assert.equal(
    code(() => normalizeName("álice")),
    "invalid_name",
  );
  assert.equal(
    code(() => normalizeName("sub.alice")),
    "invalid_name",
  );
  assert.equal(
    code(() => normalizeName("alice.eth", { suffix: ".aztec" })),
    "invalid_name",
  );
});

test("unpackLabel round-trips and refuses non-canonical data", () => {
  const l = normalizeName("dark-forest-9");
  assert.equal(unpackLabel(l.packed, l.len).label, "dark-forest-9");
  assert.equal(
    code(() => unpackLabel(l.packed, l.len - 1)),
    "corrupt_data",
  );
  assert.equal(
    code(() => unpackLabel(l.packed | 1n, l.len)),
    "corrupt_data",
  );
});

test("asciiTagToField is fixed-width and bounded", () => {
  assert.equal(asciiTagToField("df"), 0x6466n << (29n * 8n));
  assert.equal(
    code(() => asciiTagToField("")),
    "invalid_argument",
  );
  assert.equal(
    code(() => asciiTagToField("x".repeat(32))),
    "invalid_argument",
  );
});

test("lifecycle boundaries follow the contract", () => {
  const rec = (generation: number, expiresAt: bigint): NameRecord => ({
    generation,
    owner: AztecAddress.fromBigIntUnsafe(1n),
    revision: 0,
    expiresAt,
  });
  assert.equal(nameStatus(rec(0, 0n), 5n), "unregistered");
  assert.equal(nameStatus(rec(1, 100n), 99n), "active");
  assert.equal(nameStatus(rec(1, 100n), 100n), "grace");
  assert.equal(nameStatus(rec(1, 100n), 100n + GRACE_PERIOD - 1n), "grace");
  assert.equal(nameStatus(rec(1, 100n), 100n + GRACE_PERIOD), "released");
});

test("contract errors map to stable codes; transport errors never look like empty state", () => {
  assert.equal(
    toAnsError(new Error("Assertion failed: 'revision mismatch'")).code,
    "conflict",
  );
  assert.equal(
    toAnsError(new Error("Assertion failed: commitment too young")).code,
    "commit_not_ready",
  );
  assert.equal(toAnsError(new Error("fetch failed")).code, "network");
  assert.equal(
    toAnsError(new Error("User rejected the request")).code,
    "wallet_rejected",
  );
});

test("seal/unseal round-trips bigints and rejects a wrong passphrase", async () => {
  const value = { secret: 123456789012345678901234567890n, label: "alice" };
  const sealed = await seal(value, "correct horse");
  assert.deepEqual(await unseal(sealed, "correct horse"), value);
  await assert.rejects(
    unseal(sealed, "wrong horse!"),
    (e: AnsError) => e.code === "invalid_argument",
  );
});

test("assertRegistrableLabel adds the stricter rules for new registrations only", () => {
  const check = (name: string) => code(() => assertRegistrableLabel(normalizeName(name)));
  assert.equal(check("xn--abc"), "invalid_name");
  assert.equal(check("a--b"), "invalid_name");
  assert.equal(check("0xdead"), "invalid_name");
  assert.equal(check("0X123"), "invalid_name");
  for (const ok of ["a-b-c", "ab0x1", "x0abc", "0abc", "999"]) assert.equal(check(ok), "ok");
  // Existing names that break the new rules still normalize, so they resolve and renew.
  assert.equal(normalizeName("a--b").label, "a--b");
});

test("tiered registrars price 3 and 4 character names separately", () => {
  const zero = AztecAddress.fromBigIntUnsafe(0n);
  const token = AztecAddress.fromBigIntUnsafe(7n);
  const base = { feeToken: token, treasury: token, annualPrice: 1n, priceVersion: 3 };
  const tiered = { ...base, lengthPrices: { three: 128n, four: 32n } };
  assert.equal(annualPriceFor(tiered, 3), 128n);
  assert.equal(annualPriceFor(tiered, 4), 32n);
  assert.equal(annualPriceFor(tiered, 5), 1n);
  assert.equal(annualPriceFor(tiered, 31), 1n);
  assert.equal(chargeFor(tiered, 2n * 31536000n, 3), 256n);
  assert.equal(code(() => chargeFor(tiered, 31536000n)), "invalid_argument");
  // Single-price registrars ignore the length; free registrars charge nothing.
  assert.equal(chargeFor(base, 31536000n, 3), 1n);
  assert.equal(chargeFor({ ...tiered, feeToken: zero }, 31536000n, 3), 0n);
});
