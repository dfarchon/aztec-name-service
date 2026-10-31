import { AnsError } from './errors.js';
import { asciiTagToField } from './label.js';
export const TEXT_DOMAIN = 0x414e535f544558545f5634n;
export const INDEX_DOMAIN = 0x414e535f494e4445585f5634n;
export function encodeRecordKey(key: string): bigint {
  if (!/^[a-z0-9][a-z0-9:._-]{0,30}$/.test(key)) throw new AnsError('invalid_argument', 'record keys must contain 1–31 lowercase ASCII letters, digits, colon, dot, underscore or hyphen');
  return asciiTagToField(key);
}
function wordBytes(word: bigint) {
  if (word < 0n || word >= 1n << 248n) throw new AnsError('corrupt_data', 'record word exceeds 31 bytes');
  const bytes = new Uint8Array(31);
  for (let i = 30; i >= 0; i--) { bytes[i] = Number(word & 255n); word >>= 8n; }
  return bytes;
}
export function decodeRecordKey(key: bigint): string {
  const bytes = wordBytes(key), end = bytes.indexOf(0), used = end < 0 ? 31 : end;
  if (bytes.slice(used).some(Boolean)) throw new AnsError('corrupt_data', 'record key has nonzero padding');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, used));
    encodeRecordKey(text); return text;
  } catch { throw new AnsError('corrupt_data', 'invalid record key'); }
}
export function encodeTextValue(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 248 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new AnsError('invalid_argument', 'record value must be at most 248 UTF-8 bytes without control characters');
  return { bytes: [...bytes, ...new Array<number>(248 - bytes.length).fill(0)], length: bytes.length };
}
export function decodeTextValue(words: bigint[], length: number) {
  if (words.length !== 8 || !Number.isInteger(length) || length < 0 || length > 248) throw new AnsError('corrupt_data', 'invalid record length');
  const bytes = Uint8Array.from(words.flatMap(word => [...wordBytes(word)]));
  if (bytes.slice(length).some(Boolean)) throw new AnsError('corrupt_data', 'record has nonzero padding');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, length)); }
  catch { throw new AnsError('corrupt_data', 'record is not UTF-8'); }
}
/** CAIP-2 identifies the chain; a record stores an address, never moves assets. */
export function chainAddressKey(chain: string) {
  if (!/^[a-z0-9-]{3,8}:[a-zA-Z0-9_-]{1,32}$/.test(chain)) throw new AnsError('invalid_argument', 'use a CAIP-2 chain identifier, for example eip155:1');
  const key = `address:${chain}`; encodeRecordKey(key); return key;
}
export function validateChainAddress(chain: string, address: string) {
  chainAddressKey(chain);
  if (address && chain.startsWith('eip155:') && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new AnsError('invalid_argument', 'EVM addresses must be 20-byte hexadecimal values');
  if (address && /\s/.test(address)) throw new AnsError('invalid_argument', 'addresses cannot contain whitespace');
  encodeTextValue(address); return address;
}
