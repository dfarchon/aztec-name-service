import { parseWithBigInt, stringifyWithBigInt } from "@ans/sdk/read";

/**
 * Local secrets for one browser profile. A passphrase is stretched once per unlock (PBKDF2-SHA256); the result keys
 * both the encrypted PXE / wallet stores and this vault. Nothing here is ever sent anywhere.
 */
const ITERATIONS = 310_000;
const SALT_KEY = "ans:vault-salt";

function salt(): Uint8Array {
  let s: string | null = null;
  try {
    s = localStorage.getItem(SALT_KEY);
  } catch {
    throw new Error("Cannot read wallet encryption settings. Allow browser storage and retry.");
  }
  if (s) return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const fresh = crypto.getRandomValues(new Uint8Array(16));
  try {
    localStorage.setItem(SALT_KEY, btoa(String.fromCharCode(...fresh)));
  } catch {
    throw new Error("Cannot save wallet encryption settings. Allow browser storage and retry.");
  }
  return fresh;
}

export const hasVault = () => {
  try {
    return localStorage.getItem(SALT_KEY) !== null;
  } catch {
    return false;
  }
};

export type UnlockedKeys = {
  /** 32-byte key material for the OPFS stores; hand out copies, the stores detach buffers they receive. */
  storeKey: () => Uint8Array;
  recordsKey: CryptoKey;
};

export async function deriveKeys(passphrase: string): Promise<UnlockedKeys> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: salt() as BufferSource,
        iterations: ITERATIONS,
      },
      base,
      512,
    ),
  );
  const storeBytes = bits.slice(0, 32);
  const recordsKey = await crypto.subtle.importKey(
    "raw",
    bits.slice(32),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  bits.fill(0);
  return { storeKey: () => storeBytes.slice(), recordsKey };
}

/** Per-account encrypted records (pending registration plans, tx history, local name list). */
export class RecordStore<T extends object> {
  constructor(
    private readonly key: CryptoKey,
    private readonly storageKey: string,
    private readonly empty: () => T,
  ) {}

  async load(): Promise<T> {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.storageKey);
    } catch {
      throw new Error("Cannot read registration progress. Allow browser storage and retry.");
    }
    if (!raw) return this.empty();
    const { iv, ct } = JSON.parse(raw) as { iv: string; ct: string };
    const bytes = (s: string) =>
      Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(iv) as BufferSource },
      this.key,
      bytes(ct) as BufferSource,
    );
    return {
      ...this.empty(),
      ...parseWithBigInt<T>(new TextDecoder().decode(pt)),
    };
  }

  async save(value: T) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        this.key,
        new TextEncoder().encode(stringifyWithBigInt(value)) as BufferSource,
      ),
    );
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ iv: b64(iv), ct: b64(ct) }),
      );
    } catch {
      throw new Error("Cannot save registration progress. Free up browser storage and retry.");
    }
  }

  clear() {
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
  }
}
