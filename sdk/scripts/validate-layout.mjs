import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const canonical = text => text.replace(/\/\/[^\n]*/g,'').replace(/\s+/g,'');
export function checkLayout(baseline, storage, declarations, packedTypes, version = "V3") {
  for(const [name,slot] of Object.entries(baseline.storage)) if(storage[name]!==slot) throw new Error(`${version} storage slot changed: ${name}`);
  if(!canonical(declarations).startsWith(baseline.declarations)) throw new Error(`${version} storage must preserve existing field types and order`);
  if(createHash('sha256').update(canonical(packedTypes)).digest('hex')!==baseline.packedTypesSha256) throw new Error(`${version} packed encodings changed; introduce new types instead of rewriting existing records`);
}
export async function validateV3Layout(storage, packageName = "name_registry_v3") {
  const root=new URL('../../',import.meta.url);
  const [baseline,source,types]=await Promise.all(['contracts/name_registry_v3/storage-layout.json',`contracts/${packageName}/src/main.nr`,'contracts/ans_common/src/types.nr'].map(p=>readFile(new URL(p,root),'utf8')));
  const declarations=source.match(/struct Storage<Context> \{([\s\S]*?)\n    }/)?.[1];
  if(!declarations) throw new Error('Storage declaration missing');
  checkLayout(JSON.parse(baseline),storage,declarations,types);
}

async function validateExtendedLayout(storage, packageName, version) {
  const root = new URL('../../', import.meta.url);
  const [baseline, source, common, extensions] = await Promise.all([
    `contracts/${packageName}/storage-layout.json`, `contracts/${packageName}/src/main.nr`,
    'contracts/ans_common/src/types.nr', `contracts/${packageName}/src/types.nr`,
  ].map(p => readFile(new URL(p, root), 'utf8')));
  const declarations = source.match(/struct Storage<Context> \{([\s\S]*?)\n    }/)?.[1];
  if (!declarations) throw new Error(`${version} storage declaration missing`);
  checkLayout(JSON.parse(baseline), storage, declarations, common + extensions, version);
}

export const validateV4Layout = storage => validateExtendedLayout(storage, 'name_registry_v4', 'V4');
export const validateV5Layout = storage => validateExtendedLayout(storage, 'name_registry_v5', 'V5');
export const validateV6Layout = storage => validateExtendedLayout(storage, 'name_registry_v6', 'V6');

/** V7 appends its editor counter; every V6 field, slot and packed encoding stays frozen. */
export async function validateV7Layout(storage) {
  await validateExtendedLayout(storage, 'name_registry_v7', 'V7');
  const root = new URL('../../', import.meta.url);
  const [baseline, source, common, extensions] = await Promise.all([
    'contracts/name_registry_v6/storage-layout.json', 'contracts/name_registry_v7/src/main.nr',
    'contracts/ans_common/src/types.nr', 'contracts/name_registry_v7/src/types.nr',
  ].map(path => readFile(new URL(path, root), 'utf8')));
  const v6 = JSON.parse(baseline);
  const declarations = source.match(/struct Storage<Context> \{([\s\S]*?)\n    }/)?.[1];
  if (!declarations) throw new Error('V7 storage declaration missing');
  checkLayout(v6, storage, declarations, common + extensions, 'V7/V6');
  const added = Object.keys(storage).filter(key => !(key in v6.storage));
  if (added.length !== 1 || added[0] !== 'record_revisions' ||
      BigInt(storage.record_revisions) !== BigInt(v6.storage.pending_administrator) + 1n)
    throw new Error('V7 must append only record_revisions after V6 storage');
}
