import {
  GRACE_PERIOD,
  MAX_DURATION,
  MIN_DURATION,
  SECONDS_PER_YEAR,
} from "./constants.js";
import { AnsError } from "./errors.js";
import type { NameRecord, RegistryConfig } from "./types.js";

/**
 * - unregistered: never registered (generation 0)
 * - active: resolvable, holder can do everything
 * - grace: expired, not resolvable, only the holder can renew
 * - released: grace over, anyone can register the next generation
 */
export type NameStatus = "unregistered" | "active" | "grace" | "released";

export function nameStatus(rec: NameRecord, now: bigint): NameStatus {
  if (rec.generation === 0) return "unregistered";
  if (now < rec.expiresAt) return "active";
  if (now < rec.expiresAt + GRACE_PERIOD) return "grace";
  return "released";
}

export const isRegistrable = (s: NameStatus) =>
  s === "unregistered" || s === "released";

export function assertDuration(duration: bigint) {
  if (
    duration < MIN_DURATION ||
    duration > MAX_DURATION ||
    duration % SECONDS_PER_YEAR !== 0n
  ) {
    throw new AnsError("invalid_argument", "租期必须为 1–5 个整年");
  }
}

/** Launch leases are exactly 365 days for both registration and renewal. */
export function assertPolicyDuration(config: RegistryConfig, duration: bigint) {
  assertDuration(duration);
  if (config.launch && duration !== SECONDS_PER_YEAR)
    throw new AnsError("invalid_argument", "lease must be one year");
}

/** `fee_for`: pro-rata annual price, rounded up. */
export function feeFor(annualPrice: bigint, duration: bigint): bigint {
  return (annualPrice * duration + SECONDS_PER_YEAR - 1n) / SECONDS_PER_YEAR;
}

/** Annual price for a label of `labelLength` characters. Tiered registrars require the length. */
export function annualPriceFor(config: RegistryConfig, labelLength?: number): bigint {
  if (!config.lengthPrices) return config.annualPrice;
  if (labelLength === undefined)
    throw new AnsError("invalid_argument", "this registrar prices by name length; pass the name");
  if (labelLength === 3) return config.lengthPrices.three;
  if (labelLength === 4) return config.lengthPrices.four;
  return config.annualPrice;
}

/** The exact amount the contract will charge for `duration`. */
export function chargeFor(config: RegistryConfig, duration: bigint, labelLength?: number): bigint {
  return config.feeToken.isZero() ? 0n : feeFor(annualPriceFor(config, labelLength), duration);
}
