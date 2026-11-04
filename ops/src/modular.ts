import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import type { Check } from './monitor.js';

export type ModulesState = { classId: string; registrar: string; resolver: string; revision: number; administrator?: string };
const implementations = [metadata.registry, metadata.upgradeTest, metadata.extended, metadata.current, metadata.v6, metadata.v7];
export const modularClass = (id: string) => implementations.some(item => item.classId === id);
/** Supported implementations per module slot; a tiered Registrar replaces the single-price one without migration. */
const moduleClasses = { registrar: [metadata.registrar, metadata.registrarTiered, metadata.registrarLaunch], resolver: [metadata.resolver] };
type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
const field = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

/** Read all slots at one block; validate both class identity and the module's immutable registry binding. */
export async function inspectModules(rpc: Rpc, registry: string, classId: string, block: number): Promise<{ modules: ModulesState; checks: Check[] }> {
  const read = (address: string, slot: string, count: number) => Promise.all(Array.from({length:count}, (_,i) => rpc<string>('getPublicStorageAt',[block,address,field(BigInt(slot)+BigInt(i))]).then(BigInt)));
  const implementation = implementations.find(item => item.classId === classId);
  if (!implementation) throw new Error('Unknown registry implementation');
  const administratorSlot = 'administrator' in implementation.storage ? implementation.storage.administrator : undefined;
  const [m, administrator] = await Promise.all([
    read(registry, implementation.storage.modules, 3),
    administratorSlot ? read(registry, administratorSlot, 1) : undefined,
  ]);
  const modules: ModulesState = { classId, registrar: field(m[0]), resolver: field(m[1]), revision: Number(m[2]), ...(administrator ? {administrator: field(administrator[0])} : {}) };
  const checks = await Promise.all((['registrar','resolver'] as const).map(async kind => {
    try {
      const instance = await rpc<{currentContractClassId:string}|null>('getContract',[modules[kind]]);
      const known = moduleClasses[kind].find(item => item.classId === instance?.currentContractClassId);
      const [binding] = known ? await read(modules[kind],known.storage.registry,1) : [undefined];
      const ok = m[2]>0n && !!known && binding===BigInt(registry);
      return {name:kind,ok,detail:ok?'Contract class and registry match':'Unknown module or registry mismatch'};
    } catch { return {name:kind,ok:false,detail:'Unable to read module'}; }
  }));
  return {modules,checks};
}
