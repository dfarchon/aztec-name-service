import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import metadata from '../src/artifacts/modular-metadata.json' with {type:'json'};
// @ts-expect-error Build helper is JavaScript and intentionally outside the SDK output.
import {checkLayout,validateV3Layout,validateV5Layout} from '../scripts/validate-layout.mjs';
test('V3 layout baseline rejects shifted slots, altered field types and altered packed encodings',async()=>{
  await validateV3Layout(metadata.registry.storage);
  const root=new URL('../../',import.meta.url);
  const [raw,source,types]=await Promise.all(['contracts/name_registry_v3/storage-layout.json','contracts/name_registry_v3/src/main.nr','contracts/ans_common/src/types.nr'].map(p=>readFile(new URL(p,root),'utf8')));
  const baseline=JSON.parse(raw),declarations=source.match(/struct Storage<Context> \{([\s\S]*?)\n    }/)![1];
  assert.throws(()=>checkLayout(baseline,{...metadata.registry.storage,names:'0x99'},declarations,types),/slot changed/);
  assert.throws(()=>checkLayout(baseline,metadata.registry.storage,declarations.replace('PublicMutable<Modules','PublicMutable<Proposal'),types),/field types/);
  assert.throws(()=>checkLayout(baseline,metadata.registry.storage,declarations,types.replace('TWO_POW_32: Field = 0x100000000','TWO_POW_32: Field = 0x100000001')),/packed encodings/);
  checkLayout(baseline,{...metadata.registry.storage,appended:'0x19'},declarations+'appended:PublicMutable<Field,Context>,',types);
});

test('current V5 source and metadata preserve frozen slots, types and packed encodings without codegen', async () => {
  await validateV5Layout(metadata.current.storage);
  const root = new URL('../../', import.meta.url);
  const [raw, source, common, extensions] = await Promise.all([
    'contracts/name_registry_v5/storage-layout.json',
    'contracts/name_registry_v5/src/main.nr',
    'contracts/ans_common/src/types.nr',
    'contracts/name_registry_v5/src/types.nr',
  ].map(path => readFile(new URL(path, root), 'utf8')));
  const baseline = JSON.parse(raw);
  const declarations = source.match(/struct Storage<Context> \{([\s\S]*?)\n    }/)![1];
  for (const field of ['names', 'commits'] as const)
    await assert.rejects(validateV5Layout({ ...metadata.current.storage, [field]: '0x99' }), /V5 storage slot changed/);
  assert.throws(() => checkLayout(
    baseline, metadata.current.storage, declarations.replace('PublicMutable<CommitRecord', 'PublicMutable<NameMeta'), common + extensions, 'V5',
  ), /V5 storage must preserve existing field types/);
  assert.throws(() => checkLayout(
    baseline, metadata.current.storage, declarations, (common + extensions).replace('TWO_POW_32: Field = 0x100000000', 'TWO_POW_32: Field = 0x100000001'), 'V5',
  ), /V5 packed encodings changed/);
});
