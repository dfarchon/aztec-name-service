/** Public reserved-list data and deterministic launch-policy operations; no wallet/key I/O. */
import { createHash } from 'node:crypto';
import { nodeOf, normalizeName } from '@ans/sdk';
export function canonicalReservedLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Reserved labels must be a JSON array');
  const labels = value.map(v => normalizeName(v).label);
  if (labels.some((v,i) => v !== value[i] || v.includes('.'))) throw new Error('Reserved labels must be canonical root labels');
  if (new Set(labels).size !== labels.length) throw new Error('Duplicate reserved label');
  return labels.sort();
}
export function reservedListHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalReservedLabels(value))).digest('hex');
}
export async function reservedNodes(labels: string[]): Promise<bigint[]> {
  return Promise.all(canonicalReservedLabels(labels).map(label => nodeOf(normalizeName(label))));
}
export function reservedBatches(nodes: bigint[]): bigint[][] {
  const batches: bigint[][] = [];
  for (let i=0;i<nodes.length;i+=32) batches.push([...nodes.slice(i,i+32),...Array<bigint>(Math.max(0,32-(nodes.length-i))).fill(0n)]);
  return batches;
}
/** Include event-discovered nodes as well as the canonical list so copying cannot silently drop dynamic reservations. */
export async function reservationParity(nodes: bigint[], events: {node:bigint;reserved:boolean}[], readOld:(node:bigint)=>Promise<boolean>) {
  const all=[...new Set([...nodes,...events.map(e=>e.node)])].filter(n=>n!==0n);
  return Promise.all(all.map(async node=>({node,reserved:await readOld(node)})));
}
export async function verifyReservations(expected:{node:bigint;reserved:boolean}[], read:(node:bigint)=>Promise<boolean>) {
  for(const entry of expected) if(await read(entry.node)!==entry.reserved) throw new Error(`Reserved parity mismatch at node ${entry.node}`);
}
