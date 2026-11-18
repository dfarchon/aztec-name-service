import { FogError } from './errors.js';
import { asciiTagToField } from './label.js';

/** Frozen Poseidon2 domain separators for public text records and key enumeration (`v4_extensions.nr`). */
export const TEXT_DOMAIN = 0x414e535f544558545f5634n;
export const INDEX_DOMAIN = 0x414e535f494e4445585f5634n;

const TEXT_WORD_COUNT = 8;
const TEXT_BYTES_PER_WORD = 31;
const MAX_TEXT_BYTES = TEXT_WORD_COUNT * TEXT_BYTES_PER_WORD;

/** Packs a 1-31 byte ASCII record key (`[a-z0-9][a-z0-9:._-]*`) into a single big-endian Field. */
export function encodeRecordKey(key: string): bigint {
  if (!/^[a-z0-9][a-z0-9:._-]{0,30}$/.test(key)) {
    throw new FogError(
      'invalid_argument',
      'record keys must contain 1–31 lowercase ASCII letters, digits, colon, dot, underscore or hyphen',
    );
  }
  return asciiTagToField(key);
}

function wordBytes(word: bigint): Uint8Array {
  if (word < 0n || word >= 1n << 248n) {
    throw new FogError('corrupt_data', 'record word exceeds 31 bytes');
  }
  const bytes = new Uint8Array(TEXT_BYTES_PER_WORD);
  for (let i = TEXT_BYTES_PER_WORD - 1; i >= 0; i--) {
    bytes[i] = Number(word & 255n);
    word >>= 8n;
  }
  return bytes;
}

/** Inverse of `encodeRecordKey`; rejects non-zero trailing padding or non-canonical characters. */
export function decodeRecordKey(key: bigint): string {
  const bytes = wordBytes(key);
  const end = bytes.indexOf(0);
  const used = end < 0 ? TEXT_BYTES_PER_WORD : end;
  if (bytes.slice(used).some(Boolean)) {
    throw new FogError('corrupt_data', 'record key has nonzero padding');
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, used));
    encodeRecordKey(text);
    return text;
  } catch {
    throw new FogError('corrupt_data', 'invalid record key');
  }
}

/** Encodes a UTF-8 record value into a zero-padded 248-byte buffer (8 x 31-byte Fields), rejecting control characters. */
export function encodeTextValue(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > MAX_TEXT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new FogError(
      'invalid_argument',
      'record value must be at most 248 UTF-8 bytes without control characters',
    );
  }
  return {
    bytes: [...bytes, ...new Array<number>(MAX_TEXT_BYTES - bytes.length).fill(0)],
    length: bytes.length,
  };
}

/** Decodes 8 packed Field words + explicit byte length back into a validated UTF-8 string. */
export function decodeTextValue(words: bigint[], length: number): string {
  if (words.length !== TEXT_WORD_COUNT || !Number.isInteger(length) || length < 0 || length > MAX_TEXT_BYTES) {
    throw new FogError('corrupt_data', 'invalid record length');
  }
  const bytes = Uint8Array.from(words.flatMap((word) => [...wordBytes(word)]));
  if (bytes.slice(length).some(Boolean)) {
    throw new FogError('corrupt_data', 'record has nonzero padding');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, length));
  } catch {
    throw new FogError('corrupt_data', 'record is not UTF-8');
  }
}

/** CAIP-2 (`namespace:reference`) identifies the target chain; records store display addresses and never move assets. */
export function chainAddressKey(chain: string): string {
  if (!/^[a-z0-9-]{3,8}:[a-zA-Z0-9_-]{1,32}$/.test(chain)) {
    throw new FogError('invalid_argument', 'use a CAIP-2 chain identifier, for example eip155:1');
  }
  const key = `address:${chain}`;
  encodeRecordKey(key);
  return key;
}

/** Validates a multi-chain address value against its CAIP-2 chain namespace (20-byte hex required for `eip155:*`). */
export function validateChainAddress(chain: string, address: string): string {
  chainAddressKey(chain);
  if (address && chain.startsWith('eip155:') && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new FogError('invalid_argument', 'EVM addresses must be 20-byte hexadecimal values');
  }
  if (address && /\s/.test(address)) {
    throw new FogError('invalid_argument', 'addresses cannot contain whitespace');
  }
  encodeTextValue(address);
  return address;
}
