/** Public reserved-list data and deterministic launch-policy operations; no wallet/key I/O. */
import { createHash } from 'node:crypto';
import { nodeOf, normalizeName } from '@ans/sdk';
/** Validate public v1 category files or legacy arrays, returning sorted canonical root labels. */
export function loadReservedList(value: unknown): string[] {
  let labels: unknown[], minimum = 7;
  if (Array.isArray(value)) labels = value;
  else {
    if (!value || typeof value !== 'object') throw new Error('Reserved labels must be an array or v1 category object');
    const list = value as Record<string, unknown>;
    if (list.schema !== 'ans-reserved-labels/1') throw new Error('Unknown reserved list schema');
    if (!Number.isInteger(list.minLength) || Number(list.minLength) < 1 || Number(list.minLength) > 31)
      throw new Error('Invalid reserved list minLength');
    minimum = Math.max(7, Number(list.minLength));
    if (!list.categories || typeof list.categories !== 'object' || Array.isArray(list.categories)) throw new Error('Reserved categories must be an object');
    const entries = Object.entries(list.categories);
    if (!entries.length) throw new Error('Reserved categories must not be empty');
    labels = entries.flatMap(([name, values]) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid reserved category name');
      if (!Array.isArray(values) || !values.length) throw new Error('Reserved category must be a nonempty array');
      return values;
    });
  }
  const canonical = labels.map(label => {
    if (typeof label !== 'string' || label.length < minimum || label.length > 31 ||
        !/^[a-z0-9-]+$/.test(label) || label.startsWith('-') || label.endsWith('-') ||
        label.includes('--') || label.startsWith('0x') || normalizeName(label).label !== label)
      throw new Error('Reserved labels must be canonical legal root labels of length 7–31');
    return label;
  });
  if (new Set(canonical).size !== canonical.length) throw new Error('Duplicate reserved label');
  return canonical.sort();
}
export function canonicalReservedLabels(value: unknown): string[] { return loadReservedList(value); }
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
