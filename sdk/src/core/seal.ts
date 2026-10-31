import { AnsError } from "./errors.js";

/**
 * Passphrase encryption for exported registration plans and local name lists (PBKDF2-SHA256 + AES-256-GCM via
 * WebCrypto, available in browsers and Node 20+). BigInts survive the round trip.
 */
export type Sealed = {
  v: 1;
  kdf: "pbkdf2-sha256";
  iter: number;
  salt: string;
  iv: string;
  ct: string;
};

const ITERATIONS = 310_000;
const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new AnsError("unsupported", "WebCrypto is not available");
  return s;
};

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? { $bigint: v.toString() } : v,
  );
}

export function parseWithBigInt<T>(text: string): T {
  return JSON.parse(text, (_k, v) =>
    v &&
    typeof v === "object" &&
    typeof v.$bigint === "string" &&
    Object.keys(v).length === 1
      ? BigInt(v.$bigint)
      : v,
  ) as T;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iter: number) {
  const base = await subtle().importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: iter,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(
  value: unknown,
  passphrase: string,
): Promise<Sealed> {
  if (passphrase.length < 8)
    throw new AnsError(
      "invalid_argument",
      "passphrase must be at least 8 characters",
    );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const pt = new TextEncoder().encode(stringifyWithBigInt(value));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      pt as BufferSource,
    ),
  );
  return {
    v: 1,
    kdf: "pbkdf2-sha256",
    iter: ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ct),
  };
}

export async function unseal<T>(
  sealed: Sealed,
  passphrase: string,
): Promise<T> {
  if (sealed?.v !== 1 || sealed.kdf !== "pbkdf2-sha256")
    throw new AnsError("corrupt_data", "unknown export format");
  const key = await deriveKey(passphrase, unb64(sealed.salt), sealed.iter);
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: unb64(sealed.iv) as BufferSource },
      key,
      unb64(sealed.ct) as BufferSource,
    );
    return parseWithBigInt<T>(new TextDecoder().decode(pt));
  } catch {
    throw new AnsError(
      "invalid_argument",
      "wrong passphrase or corrupted export",
    );
  }
}
