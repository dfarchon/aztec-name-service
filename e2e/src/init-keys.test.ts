import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { initKeys, readKeys, readPublicKeys, validateKeys, type KeysFile, type InitConfig } from './init-keys.js';
const config = (stateDir: string): InitConfig => ({ network: 'local', stateDir, assertPath: () => {} });
async function fixture(t: { after: (f: () => Promise<unknown>) => void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ans-init-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.chmod(dir, 0o700); return dir;
}
const hash = async (path: string) => createHash('sha256').update(await fs.readFile(path)).digest('hex');
const sentinel = (n: number) => ({ secret: new Fr((1n << 180n) + BigInt(n)), salt: new Fr((1n << 181n) + BigInt(n)), signingKey: new Fq((1n << 182n) + BigInt(n)) });
function privateValues(k: KeysFile) { return [k.owner, k.treasury].flatMap(a => [a.secret, a.salt, a.signingKey]).concat(Object.values(k.salts)); }

test('init schema, address derivation, public projection and modes survive umask zero', async t => {
  const dir = await fixture(t), mask = process.umask(0);
  try {
    await initKeys(config(join(dir, 'state')));
    const path = join(dir, 'state/keys.json'), k = await readKeys(path, 'local');
    assert.equal(k.schema, 'ans-v6-keys/1'); assert(k.owner.address !== k.treasury.address);
    assert.equal((await fs.stat(join(dir, 'state'))).mode & 0o777, 0o700); assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    const publicJson = JSON.stringify(await readPublicKeys(path, 'local'));
    assert([k.owner.secret,k.owner.signingKey,k.treasury.secret,k.treasury.signingKey].every(v => !publicJson.includes(v)));
    assert(await validateKeys(k, 'local'));
  } finally { process.umask(mask); }
});
for (const name of ['keys.json','state.json','runner.lock','keys.json.tmp']) test(`existing ${name} refuses before generating and preserves bytes`, async t => {
  const dir = await fixture(t), path = join(dir,name); await fs.writeFile(path,'existing'); const before = await hash(path); let generated=0;
  await assert.rejects(initKeys(config(dir), { randomKeys: () => { generated++; return sentinel(1); }, randomSalt: () => new Fr(1), now: () => new Date() }), /refusing to overwrite/);
  assert.equal(generated,0); assert.equal(await hash(path),before);
  assert.deepEqual(await fs.readdir(dir),[name]);
});
test('dangling symlinks refuse without creating their target', async t => {
  const dir = await fixture(t), target=join(dir,'absent'); await fs.symlink(target,join(dir,'keys.json'));
  await assert.rejects(initKeys(config(dir)),/refusing to overwrite/); await assert.rejects(fs.stat(target),{code:'ENOENT'});
});
test('concurrent initialization has exactly one winner and leaves no temporary file', async t => {
  const dir = await fixture(t); const results=await Promise.allSettled([initKeys(config(dir)),initKeys(config(dir))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert(results.some(r=>r.status==='rejected' && /refusing to overwrite/.test(String(r.reason))));
  assert.deepEqual(await fs.readdir(dir),['keys.json']); await readKeys(join(dir,'keys.json'),'local');
});
test('existing public directory refuses without changing permissions', async t => {
  const dir=await fixture(t); await fs.chmod(dir,0o755); await assert.rejects(initKeys(config(dir)),/Keys file permissions/);
  assert.equal((await fs.stat(dir)).mode & 0o777,0o755); assert.deepEqual(await fs.readdir(dir),[]);
});
test('account collision retries once and then fails without files', async t => {
  const dir=await fixture(t); let calls=0,salt=0;
  await assert.rejects(initKeys(config(dir),{randomKeys:()=>{calls++;return sentinel(1);},randomSalt:()=>new Fr(++salt),now:()=>new Date()}),/collision after retry/);
  assert.equal(calls,4); assert.deepEqual(await fs.readdir(dir),[]);
});
test('account and salt collisions recover on the second attempt', async t => {
  for (const mode of ['account','salt']) {
    const dir=join(await fixture(t),'state'); let calls=0,salts=0;
    await initKeys(config(dir),{randomKeys:()=>sentinel(mode==='account' && ++calls<=2 ? 1 : ++calls),randomSalt:()=>new Fr(mode==='salt' && ++salts<=4 ? 1 : ++salts),now:()=>new Date()});
    await readKeys(join(dir,'keys.json'),'local');
  }
});
test('sentinel private fields never enter stdout/stderr, including link failure cleanup', async t => {
  const dir=await fixture(t); const captured:string[]=[]; let calls=0,salts=0;
  const deps={randomKeys:()=>sentinel(++calls),randomSalt:()=>new Fr((1n<<183n)+BigInt(++salts)),now:()=>new Date()};
  const log=t.mock.method(console,'log',(...v:unknown[])=>{captured.push(v.join(' '));});
  const error=t.mock.method(console,'error',(...v:unknown[])=>{captured.push(v.join(' '));});
  const stdout=t.mock.method(process.stdout,'write',((v:unknown)=>{captured.push(String(v));return true;}) as typeof process.stdout.write);
  const stderr=t.mock.method(process.stderr,'write',((v:unknown)=>{captured.push(String(v));return true;}) as typeof process.stderr.write);
  let keys:KeysFile;
  try {
    await initKeys(config(join(dir,'ok')),deps); keys=await readKeys(join(dir,'ok/keys.json'),'local');
    const link=t.mock.method(fs,'link',async()=>{throw new Error('forced');});
    try { await assert.rejects(initKeys(config(join(dir,'fail')),deps),/Keys file write failed/); } finally { link.mock.restore(); }
    assert.deepEqual(await fs.readdir(join(dir,'fail')),[]);
  } finally { log.mock.restore();error.mock.restore();stdout.mock.restore();stderr.mock.restore(); }
  const values=privateValues(keys!);
  for(let i=1;i<=calls;i++) values.push(...Object.values(sentinel(i)).map(v=>v.toString()));
  for(let i=1;i<=salts;i++) values.push(new Fr((1n<<183n)+BigInt(i)).toString());
  assert(values.every(v=>!captured.join('\n').includes(v) && !captured.join('\n').includes(BigInt(v).toString())));
  assert.equal(captured.length,2);
});
test('strict schema rejects extra/missing fields, nonhex, range, address, collisions and identity drift', async t => {
  const dir=await fixture(t); await initKeys(config(dir));const original=await readKeys(join(dir,'keys.json'),'local');
  const mutations:((k:any)=>void)[]=[k=>{k.extra=1;},k=>{delete k.owner.salt;},k=>{k.owner.extra=1;},k=>{k.salts.extra=1;},k=>{k.owner.secret='no';},k=>{k.owner.secret=`0x${'f'.repeat(64)}`;},k=>{k.owner.signingKey=`0x${'f'.repeat(64)}`;},k=>{k.owner.address=k.treasury.address;},k=>{k.treasury=k.owner;},k=>{k.salts.token=k.salts.registry;},k=>{k.salts.token=`0x${'0'.repeat(64)}`;},k=>{k.network='testnet-v6';},k=>{k.schema='other';},k=>{k.toolchainVersion='5.2.1';},k=>{k.createdAt='invalid';}];
  for(const mutate of mutations){const k=structuredClone(original);mutate(k);await assert.rejects(validateKeys(k,'local'),/Keys file validation/);}
});
test('read rejects public permissions, symlinks, directories and malformed JSON', async t => {
  const dir=await fixture(t);await initKeys(config(dir));const path=join(dir,'keys.json');
  await fs.chmod(path,0o644);await assert.rejects(readKeys(path,'local'),/Keys file permissions/);await fs.chmod(path,0o600);
  await fs.symlink(path,join(dir,'link'));await assert.rejects(readKeys(join(dir,'link'),'local'),/Keys file permissions/);
  await assert.rejects(readKeys(dir,'local'),/Keys file permissions/);
  await fs.writeFile(path,'{');await assert.rejects(readKeys(path,'local'),/Keys file validation/);
});
test('offline module import boundary excludes network, wallet and transaction modules', async()=>{
  const src=await fs.readFile(new URL('./init-keys.ts',import.meta.url),'utf8');
  const imports=[...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m=>m[1]);
  assert(imports.every(s=>['node:fs','node:crypto','@aztec-labs/accounts/schnorr','@aztec-labs/aztec.js/fields','./common.js'].includes(s)));
});
