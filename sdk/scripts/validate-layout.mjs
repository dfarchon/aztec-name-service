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
