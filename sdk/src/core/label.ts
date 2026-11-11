import { MAX_LABEL_LEN, MIN_LABEL_LEN } from "./constants.js";
import { AnsError } from "./errors.js";

/** A label in the exact form the contract accepts. */
export type Label = {
  /** Canonical text, e.g. "alice". */
  label: string;
  /** Parent of a V4 subname; bytes/packed encode only this label. */
  parent?: Label;
  /** 31 bytes, zero padded: the `[u8; 31]` argument of contract functions. */
  bytes: number[];
  len: number;
  /** Big-endian packing of `bytes` into one Field, as `pack_label` computes it. */
  packed: bigint;
};

/**
 * Display suffix of every ANS name (".fog", Fully Obfuscated Glyph). It is presentation only: contracts hash and store
 * the bare label, so `alice.fog` is the root label `alice`. SDK calls that take a name expect the canonical label.
 */
export const NAME_SUFFIX = ".fog";

/** Display form of a canonical label: `alice` → `alice.fog`, `team.alice` → `team.alice.fog`. */
export function formatName(name: string | Pick<Label, "label">): string {
  return `${typeof name === "string" ? name : name.label}${NAME_SUFFIX}`;
}

export type NormalizeOptions = {
  /**
   * Display suffix stripped once from the end of the input; pass `NAME_SUFFIX` for user input. Without it any other dot
   * is a subname separator (with `allowSubnames`) or rejected.
   */
  suffix?: string;
  allowSubnames?: boolean;
};

const isLower = (c: number) => c >= 97 && c <= 122;
const isDigit = (c: number) => c >= 48 && c <= 57;
const HYPHEN = 45;

/**
 * Turns user input into the canonical label. ASCII letters are lowercased; every other rule matches `pack_label`
 * exactly (3–31 chars of [a-z0-9-], no leading or trailing hyphen). Non-ASCII input is rejected, not transliterated.
 */
export function normalizeName(
  input: string,
  opts: NormalizeOptions = {},
): Label {
  let s = input.normalize("NFC").trim();
  if (opts.suffix && s.toLowerCase().endsWith(opts.suffix.toLowerCase()))
    s = s.slice(0, -opts.suffix.length);
  if (opts.allowSubnames && s.includes(".")) {
    const parts = s.split(".");
    if (parts.length > 5) throw new AnsError("invalid_name", "at most four subname levels are supported");
    let result = normalizeName(parts.pop()!);
    while (parts.length) { const leaf = normalizeName(parts.pop()!); result = { ...leaf, label: `${leaf.label}.${result.label}`, parent: result }; }
    return result;
  }
  if (s.includes("."))
    throw new AnsError(
      "invalid_name",
      "subnames and unknown suffixes are not supported",
    );
  s = s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  return labelFromCanonical(s);
}

/** Validates an already canonical label without rewriting it. */
export function labelFromCanonical(label: string): Label {
  const len = label.length;
  if (len < MIN_LABEL_LEN || len > MAX_LABEL_LEN) {
    throw new AnsError(
      "invalid_name",
      `label must be ${MIN_LABEL_LEN}–${MAX_LABEL_LEN} characters`,
    );
  }
  const bytes = new Array<number>(MAX_LABEL_LEN).fill(0);
  for (let i = 0; i < len; i++) {
    const c = label.charCodeAt(i);
    if (!(isLower(c) || isDigit(c) || c === HYPHEN)) {
      throw new AnsError("invalid_name", 'only a-z, 0-9 and "-" are allowed');
    }
    if (c === HYPHEN && (i === 0 || i === len - 1)) {
      throw new AnsError("invalid_name", 'label cannot start or end with "-"');
    }
    bytes[i] = c;
  }
  return { label, bytes, len, packed: packBytes(bytes) };
}

/**
 * Extra rules for new root registrations, on top of `labelFromCanonical`: no "--" anywhere (punycode-style `xn--`
 * look-alikes) and no "0x" prefix (address look-alikes). Existing names that break them still resolve and renew.
 * Matches `assert_new_label` in the tiered registrar.
 */
export function assertRegistrableLabel(label: Label) {
  if (label.label.startsWith("0x"))
    throw new AnsError("invalid_name", 'label cannot start with "0x"');
  if (label.label.includes("--"))
    throw new AnsError("invalid_name", 'label cannot contain "--"');
}

export function packBytes(bytes: number[]): bigint {
  let packed = 0n;
  for (const b of bytes) packed = (packed << 8n) | BigInt(b);
  return packed;
}

/** Inverse of `pack_label`; throws `corrupt_data` for anything the contract could not have accepted. */
export function unpackLabel(packed: bigint, len: number): Label {
  if (
    len < MIN_LABEL_LEN ||
    len > MAX_LABEL_LEN ||
    packed < 0n ||
    packed >= 1n << 248n
  ) {
    throw new AnsError("corrupt_data", "packed label out of range");
  }
  const bytes = new Array<number>(MAX_LABEL_LEN).fill(0);
  let rest = packed;
  for (let i = MAX_LABEL_LEN - 1; i >= 0; i--) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (bytes.slice(len).some((b) => b !== 0))
    throw new AnsError("corrupt_data", "packed label has non-zero padding");
  try {
    return labelFromCanonical(String.fromCharCode(...bytes.slice(0, len)));
  } catch {
    throw new AnsError("corrupt_data", "packed label is not canonical");
  }
}

/**
 * Encodes a short ASCII tag (e.g. an application id such as "dark-forest") as a Field: fixed 31-byte big-endian
 * packing, so the encoding never depends on JSON or string concatenation.
 */
export function asciiTagToField(tag: string): bigint {
  if (tag.length === 0 || tag.length > 31 || !/^[\x21-\x7e]+$/.test(tag)) {
    throw new AnsError(
      "invalid_argument",
      "tag must be 1–31 printable ASCII characters",
    );
  }
  const bytes = new Array<number>(31).fill(0);
  for (let i = 0; i < tag.length; i++) bytes[i] = tag.charCodeAt(i);
  return packBytes(bytes);
}
