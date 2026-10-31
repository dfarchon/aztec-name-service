import {readFile,writeFile} from 'node:fs/promises';
// Rehearse the deployed V3 layout with a changed implementation and no reinitializer.
const source=await readFile(new URL('../contracts/name_registry_v3/src/main.nr',import.meta.url),'utf8');
const fixture=source.replace('pub contract NameRegistryV3 {','pub contract RegistryUpgradeTest {')
  .replace('external, initializer, internal','external, internal')
  .replace(/    #\[external\("public"\)\]\n    #\[initializer\]\n    fn constructor\([\s\S]*?\n    }\n/,'')
  .replace('fn implementation_version() -> u32 { 1 }','fn implementation_version() -> u32 { 2 }');
if(fixture.includes('fn constructor') || !fixture.includes('fn implementation_version() -> u32 { 2 }')) throw new Error('Upgrade fixture generation needs review');
await writeFile(new URL('../contracts/registry_upgrade_test/src/main.nr',import.meta.url),fixture);
