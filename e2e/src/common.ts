import { getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec-labs/constants';
import { SponsoredFPCContractArtifact } from '@aztec-labs/noir-contracts.js/SponsoredFPC';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';

export const NODE_URL = process.env.NODE_URL ?? 'http://localhost:8080';
export const DURATION = 365n * 86400n;
export const SCOPE_DISPLAY = 1n;
export const MIN_COMMIT_AGE_S = 60;

export type Result = { name: string; ok: boolean; detail: string };

export function makeRecorder() {
  const results: Result[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  };
  return { results, record };
}

/** Wraps the node client so every broadcast Tx is captured for inspection. */
export function captureNode(node: AztecNode, sink: Tx[]): AztecNode {
  return new Proxy(node, {
    get(target, prop, receiver) {
      if (prop === 'sendTx') {
        return async (tx: Tx) => {
          sink.push(tx);
          return target.sendTx(tx);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function labelOf(s: string): { label: number[]; len: number } {
  const bytes = Buffer.from(s, 'ascii');
  const label = new Array(31).fill(0);
  bytes.forEach((b, i) => (label[i] = b));
  return { label, len: bytes.length };
}

export function bytesContain(haystack: Buffer, needle: Buffer): boolean {
  return haystack.indexOf(needle) !== -1;
}

export function unwrap<T>(v: unknown): T {
  if (v !== null && typeof v === 'object' && 'result' in (v as object)) return (v as { result: T }).result;
  return v as T;
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export type Keys = { secret: Fr; salt: Fr; signingKey: Fq };
export function randomKeys(): Keys {
  return { secret: Fr.random(), salt: Fr.random(), signingKey: Fq.random() };
}

export async function newWallet(node: AztecNode, proverEnabled = false): Promise<EmbeddedWallet> {
  if (!proverEnabled && (await node.getNodeInfo()).realProofs)
    throw new Error('Proof-disabled wallets are local-only; use npm run test:testnet for a public network');
  return EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled } });
}

export async function sponsoredFpc() {
  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  return {
    instance,
    artifact: SponsoredFPCContractArtifact,
    fee: { fee: { paymentMethod: new SponsoredFeePaymentMethod(instance.address) } },
  };
}

export function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 160);
}
