import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, stat, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { sponsoredFpc } from './common.js';
import { V6_PROFILES, assertV6Fpc, assertV6Network, dryRunNode } from './v6-network.js';
import { REPO, ZERO, parseArgs, parseInitKeysArgs, parseOptions, finalizeConfig, confirmation, makePolicy, configHash, deploymentPlan, buildManifest } from './deploy-v6-plan.js';
import { main, physicalPath, privatePaths, v6Artifacts, instances, buildInitialState, assertCheckpointKeys, atomicJson, deploymentError } from './deploy-v6.js';
// macOS tmpdir() is /var/..., a symlink to /private/var; path checks compare physical paths.
const realTmp=realpathSync(tmpdir());
const { V6_TESTNET, v6ManifestProblems } = createRequire(import.meta.url)('../../scripts/deployment-config.mjs');
const base = ['--network','local','--registrar','flat','--price-version','1'];
const treasury = `0x${'0'.repeat(63)}1`;
const testnet = ['--network','testnet-v6','--registrar','tiered','--price-version','1','--treasury',treasury];
const pricing = { decimals:18, annualPrice:'1000000000000000000', lengthPrices:{'3':'128000000000000000000','4':'32000000000000000000'} };
const info = () => ({ nodeVersion:'6.0.0', l1ChainId:11155111, rollupVersion:679261766, realProofs:true, l1ContractAddresses:{rollupAddress:V6_PROFILES['testnet-v6'].rollup} });
test('local SponsoredFPC accepts derived or published official class and rejects drift', () => {
  const derived={address:treasury,currentContractClassId:'official-class'};
  assert.equal(assertV6Fpc('local',derived,'official-class'),'derived-not-published');
  assert.equal(assertV6Fpc('local',derived,'official-class',derived),'published');
  assert.throws(()=>assertV6Fpc('local',derived,'wrong-class'),/derived class/);
  assert.throws(()=>assertV6Fpc('local',derived,'official-class',{...derived,currentContractClassId:'wrong-class'}),/published identity/);
});
test('testnet SponsoredFPC requires pinned address and a published matching class', () => {
  const derived={address:V6_PROFILES['testnet-v6'].sponsoredFpc,currentContractClassId:'official-class'};
  assert.equal(assertV6Fpc('testnet-v6',derived,'official-class',derived),'published');
  assert.throws(()=>assertV6Fpc('testnet-v6',derived,'official-class'),/not published/);
  assert.throws(()=>assertV6Fpc('testnet-v6',{...derived,address:treasury},'official-class',derived),/address mismatch/);
  assert.throws(()=>assertV6Fpc('testnet-v6',derived,'official-class',{...derived,currentContractClassId:'wrong-class'}),/published identity/);
});
test('explicit positive price-version has no default and respects u32 bounds', () => {
  for (const v of ['', '0', '-1', '1.5', 'NaN', '4294967296', '9007199254740993']) assert.throws(() => parseArgs([...base.slice(0,4), ...(v ? ['--price-version',v] : [])]), /price-version/);
  assert.equal(parseArgs(base).priceVersion,1);
});
test('registrar and network are required; unknown and duplicate flags rejected', () => {
  for (const args of [[], ['--network','local'], [...base,'--registrar','tiered'], [...base,'--unknown','value'], [...base,'--token','other']]) assert.throws(()=>parseArgs(args));
});
test('default mAZTEC official token and isolated state directory', () => {
  const c=parseArgs(base,{home:'/tmp/v6-home'});
  assert.equal(c.token,'official'); assert.equal(c.tokenName,'mAZTEC'); assert.equal(c.tokenSymbol,'mAZTEC');
  assert.equal(c.stateDir,'/tmp/v6-home/.local/share/ans/local-aztec6-6.0.0');
  const t=parseArgs([...testnet,'--dry-run'],{home:'/tmp/v6-home'});
  assert.equal(t.stateDir,'/tmp/v6-home/.local/share/ans/testnet-aztec6-6.0.0');
});
test('state path isolation and local manifest deployment directory are mandatory', () => {
  for (const path of ['/tmp/repo/state','/tmp/home/.local/share/ans/testnet-v5.2.1','/tmp/home/.local/share/ans/testnet-v5-5.2.1','/tmp/home/.local/share/ans/testnet-aztec6-6.0.0']) assert.throws(()=>parseArgs([...base,'--state-dir',path],{repo:'/tmp/repo',home:'/tmp/home'}));
  assert.throws(()=>parseArgs([...base,'--manifest-out','/tmp/repo/deployments/local.json'],{repo:'/tmp/repo'}));
});
test('confirmation binds exact testnet identity, token, treasury and selected policy', () => {
  const c=parseArgs([...testnet,'--dry-run']);
  assert.equal(parseArgs([...testnet,'--confirm',confirmation(c)]).dryRun,false);
  for (const args of [testnet,[...testnet,'--confirm','wrong'],[...testnet,'--confirm',confirmation({...c,priceVersion:2})]]) assert.throws(()=>parseArgs(args),/Exact --confirm/);
});
test('testnet treasury must be a nonzero Aztec field address', () => {
  for (const value of [ZERO,'0x01',`0x${'f'.repeat(64)}`]) assert.throws(()=>parseArgs([...testnet.slice(0,-2),'--treasury',value,'--dry-run']),/treasury/);
});
test('network guard checks every identity component', () => {
  assert.equal(assertV6Network('testnet-v6',info()).chainId,'11155111');
  for (const patch of [{nodeVersion:'5.2.1'},{l1ChainId:31337},{rollupVersion:1},{realProofs:false},{l1ContractAddresses:{rollupAddress:`0x${'0'.repeat(40)}`}}]) assert.throws(()=>assertV6Network('testnet-v6',{...info(),...patch}),/mismatch/);
});
test('local profile rejects public URLs and real proofs', () => {
  assert.throws(()=>parseArgs([...base,'--node-url','https://example.com']),/loopback/);
  assert.throws(()=>assertV6Network('local',{...info(),l1ChainId:31337}),/realProofs/);
  assert.equal(assertV6Network('local',{...info(),l1ChainId:31337,realProofs:false}).rollupVersion,'679261766');
  assert.throws(()=>parseArgs([...base,'--node-url','http://user:password@localhost:8080']),/credentials/);
});
test('mjs and TypeScript testnet identity profiles are identical', () => {
  const {nodeUrl,maxBatchSize,...p}=V6_PROFILES['testnet-v6']; assert.deepEqual(p,V6_TESTNET); assert.equal(nodeUrl,'https://aztec-testnet.drpc.org'); assert.equal(maxBatchSize,3);
});
test('dry-run proxy rejects all methods outside read whitelist before invocation', async () => {
  let calls=0; const used=new Set<string>();
  const node=dryRunNode({getNodeInfo:()=>++calls,getContract:()=>++calls,getContractClass:()=>++calls,sendTx:()=>++calls,simulatePublicCalls:()=>++calls},used);
  node.getNodeInfo(); node.getContract(); node.getContractClass();
  assert.throws(()=>node.sendTx(),/forbidden/); assert.throws(()=>node.simulatePublicCalls(),/forbidden/); assert.equal(calls,3);
});
test('config fingerprint binds policy changes and is canonical', () => {
  const c=parseArgs(base),p=makePolicy(c,pricing,treasury),hash=configHash(p);
  assert.equal(hash,configHash(Object.fromEntries(Object.entries(p).reverse()) as typeof p));
  for (const patch of [{priceVersion:2},{registrar:'tiered' as const},{token:'repo' as const},{treasury:ZERO},{annualPrice:'2'},{tokenSymbol:'OTHER'}]) assert.notEqual(hash,configHash({...p,...patch}));
  assert.equal(p.lengthPrices,null); assert.deepEqual(makePolicy({...c,registrar:'tiered'},pricing,treasury).lengthPrices,pricing.lengthPrices);
});
test('pricing rejects invalid decimals or missing tiers', () => {
  const c=parseArgs(base); assert.throws(()=>makePolicy(c,{...pricing,decimals:6},treasury));
  assert.throws(()=>makePolicy({...c,registrar:'tiered'},{decimals:18,annualPrice:'1'},treasury));
});
test('frozen official Token class and both registrar classes verify', async () => {
  const official=await v6Artifacts('official','flat'),tiered=await v6Artifacts('official','tiered');
  assert.equal(official.classIds.token,'0x067df4ddda0b0872ef604f47f3681d5e8c0de98280ac6b79963851c055ba91e0');
  assert.notEqual(official.classIds.registrar,tiered.classIds.registrar);
});
// The repository Token artifact is local compiler output (contracts/target is not committed), so CI skips this check.
// CI only verifies the official Token pin; the repo Token pin is checked locally after `npm run build:contracts`.
const repoToken=join(REPO,'contracts/target/test_token-Token.json');
test('frozen repository Token class verifies', { skip: existsSync(repoToken) ? false : 'run npm run build:contracts first' }, async () => {
  const repo=await v6Artifacts('repo','tiered');
  assert.equal(repo.classIds.token,'0x2fd6045364761e53069842f6595c27616c0d7ab8ee776c6f03731d3b23d7e9fd');
});
test('public manifest and dry plan project only public fields, never private values', async () => {
  const c=parseArgs([...testnet,'--dry-run']),p=makePolicy(c,pricing,treasury),{classIds}=await v6Artifacts('official','tiered');
  const identity={chainId:'11155111',rollupVersion:'679261766',rollup:V6_PROFILES['testnet-v6'].rollup};
  const privateValue='SECRET_TEST_SENTINEL';
  const a={owner:treasury,treasury,registry:treasury,resolver:treasury,registrar:treasury,token:treasury,sponsoredFpc:V6_PROFILES['testnet-v6'].sponsoredFpc,secret:privateValue};
  const tx=Object.fromEntries(['deploy-token','deploy-registry','deploy-resolver','deploy-registrar','bootstrap'].map(x=>[x,treasury]));
  const m=buildManifest(c,p,identity,a,{...classIds,signingKey:privateValue},{...tx,keys:privateValue},'2026-10-27T00:00:00.000Z');
  assert.deepEqual(v6ManifestProblems(m,{expectNetwork:'testnet-v6'}),[]);
  assert(!JSON.stringify(m).includes(privateValue)); assert(!JSON.stringify(deploymentPlan(c,p,identity,a,{...classIds,secret:privateValue})).includes(privateValue));
});
test('physical path checks catch symlinks into repository and resolve absent leaves', async t => {
  const dir=await mkdtemp(join(realTmp,'ans-v6-path-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await symlink(REPO,join(dir,'repo'));
  assert.equal(await physicalPath(join(dir,'absent','leaf')),join(dir,'absent','leaf'));
  await assert.rejects(privatePaths({...parseArgs(base),stateDir:join(dir,'repo','state')}),/outside/);
  await mkdir(join(dir,'state'));
  await assert.rejects(privatePaths({...parseArgs(base),stateDir:join(dir,'state'),manifestOut:join(dir,'repo','deployments','local.json')}));
});

test('dry-run never generates keys or creates state and keeps confirmation independent of owner', async t => {
  const dir = await mkdtemp(join(realTmp, 'ans-v6-dry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fpc = await sponsoredFpc(), calls: string[] = [], output: string[] = [];
  let generated = 0;
  const fake = { getNodeInfo: async () => { calls.push('getNodeInfo'); return info(); }, getContract: async () => { calls.push('getContract'); return fpc.instance; } };
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args.join(' ')));
  for (const network of ['local', 'testnet-v6'] as const) {
    calls.length = 0;
    const state = join(dir, network);
    const node = network === 'local' ? { ...fake, getNodeInfo: async () => { calls.push('getNodeInfo'); return { ...info(), l1ChainId: 31337, realProofs: false }; } } : fake;
    const args = ['--network', network, '--registrar', 'tiered', '--price-version', '1', '--state-dir', state, '--dry-run', ...(network === 'testnet-v6' ? ['--treasury', treasury] : [])];
    await main(args, { createNode: (() => node) as unknown as NonNullable<Parameters<typeof main>[1]>['createNode'], randomKeys: () => { generated++; throw new Error('dry-run generated keys'); } });
    assert.equal(generated, 0);
    await assert.rejects(stat(state), { code: 'ENOENT' });
    assert.deepEqual(calls, ['getNodeInfo', 'getContract']);
    const plan = JSON.parse([...output].reverse().find(line => line.startsWith('DRY-RUN {'))!.slice('DRY-RUN '.length));
    for (const key of ['owner', 'token', 'registry', 'resolver', 'registrar']) assert.equal(plan.addresses[key], 'pending: derived after formal local key generation');
    assert.equal(plan.addresses.treasury, network === 'local' ? plan.addresses.owner : treasury);
    assert.equal(plan.confirm, network === 'local' ? null : confirmation(parseArgs(args)));
    assert.deepEqual(plan.steps, ['preflight', 'deploy-token', 'deploy-registry', 'deploy-resolver', 'deploy-registrar', 'bootstrap', 'readback', 'manifest']);
    assert.equal(plan.policy.lengthPrices['3'], '128000000000000000000');
    assert(plan.classIds.registrar);
  }
});

// Every filesystem fixture is outside the repository and uses an injected home or tmpdir.
import { Fr } from '@aztec-labs/aztec.js/fields';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { randomKeys } from './common.js';
import { initKeys, readKeys, readPublicKeys, type KeysFile } from './init-keys.js';
async function keyFixture(t: { after: (f: () => Promise<unknown>) => void }, network: 'local' | 'testnet-v6' = 'local') {
  const dir = await mkdtemp(join(realTmp, 'ans-key-deploy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state');
  await initKeys(parseInitKeysArgs(['--init-keys', '--network', network, '--state-dir', stateDir]));
  return { dir, stateDir, keys: await readKeys(join(stateDir, 'keys.json'), network) };
}
function noSecrets(output: string, keys: KeysFile) {
  const values = [keys.owner, keys.treasury].flatMap(k => [k.secret, k.salt, k.signingKey]).concat(Object.values(keys.salts));
  assert(values.every(v => !output.includes(v) && !output.includes(BigInt(v).toString())), 'Private material in public output');
}
for (const network of ['local', 'testnet-v6'] as const) test(`init-keys ${network} creates no node and needs no confirmation`, async t => {
  const dir = await mkdtemp(join(realTmp, 'ans-key-cli-')); t.after(() => rm(dir, {recursive:true,force:true}));
  let nodes = 0, fetches = 0, generated = 0; const output: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('unexpected fetch'); });
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args.join(' ')));
  await main(['--init-keys', '--network', network, '--state-dir', join(dir, 'state')], {
    createNode: (() => { nodes++; throw new Error('unexpected network'); }) as any,
    randomKeys: () => { generated++; return randomKeys(); },
  });
  assert.equal(nodes, 0); assert.equal(fetches, 0); assert.equal(generated, 2); assert.equal(output.length, 2);
  const keys = await readKeys(join(dir, 'state/keys.json'), network); noSecrets(output.join('\n'), keys);
  assert(output[0].includes(keys.owner.address) && output[0].includes(keys.treasury.address));
  await assert.rejects(main(['--init-keys', '--network', network, '--state-dir', join(dir,'state')]), /refusing to overwrite/);
});
test('init-keys rejects every deployment option, duplicates and unknown flags', () => {
  const args = ['--init-keys','--network','local'];
  for (const flag of ['registrar','price-version','treasury','confirm','dry-run','node-url','rebroadcast','pricing','token','token-name','token-symbol','manifest-out','unknown'])
    assert.throws(() => parseInitKeysArgs([...args,`--${flag}`,'value']), /--init-keys accepts only/);
  assert.throws(() => parseInitKeysArgs([...args,'--init-keys']), /duplicate/);
  assert.throws(() => parseInitKeysArgs([...args,'--network','local']), /duplicate/);
  assert.throws(() => parseInitKeysArgs(['--init-keys']), /network/);
});
test('init and deploy reject generalized legacy paths and keep both v6 defaults', () => {
  const env = {home:'/tmp/ans-injected-home',repo:'/tmp/ans-injected-repo'};
  for (const name of ['v2','v3','v4','v5','testnet-v5.2.1','testnet-v4-5.2.1','testnet-tiered-5.2.1','archive_v2','testnet-v3-extra','v4.1.2']) {
    const path=join(env.home,'.local/share/ans',name,'child');
    assert.throws(()=>parseInitKeysArgs(['--init-keys','--network','local','--state-dir',path],env), /Legacy/);
    assert.throws(()=>parseArgs([...base,'--state-dir',path],env), /Legacy/);
  }
  for (const network of ['local','testnet-v6'] as const) {
    const parsed=parseInitKeysArgs(['--init-keys','--network',network],env);
    assert.equal(parsed.stateDir,join(env.home,`.local/share/ans/${network==='local'?'local':'testnet'}-aztec6-6.0.0`));
  }
  assert.throws(()=>parseInitKeysArgs(['--init-keys','--network','local','--state-dir',env.repo],env), /outside/);
});
test('init rejects symlink escape into repository before generating', async t => {
  const dir=await mkdtemp(join(realTmp,'ans-key-symlink-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await symlink(REPO,join(dir,'repo'));let calls=0;
  await assert.rejects(initKeys(parseInitKeysArgs(['--init-keys','--network','local','--state-dir',join(dir,'repo','state')]), {randomKeys:()=>{calls++;return randomKeys();},randomSalt:()=>Fr.random(),now:()=>new Date()}), /outside/);
  assert.equal(calls,0);
});
test('deployment error projection exposes known errors and hides arbitrary payloads', () => {
  for (const message of ['Keys file or deployment state already exists; refusing to overwrite','Treasury does not match keys file','--init-keys accepts only --network and --state-dir']) assert.equal(deploymentError(new Error(message)),message);
  assert.equal(deploymentError(new Error('private arbitrary payload')), 'V6 deployment stopped; inspect checkpoint status and network availability');
});
for (const network of ['local','testnet-v6'] as const) test(`keyed ${network} dry-run predicts six addresses with read-only preflight and no writes`, async t => {
  const output:string[]=[];t.mock.method(console,'log',(...args:unknown[])=>output.push(args.join(' ')));
  const {stateDir,keys}=await keyFixture(t,network), before=await stat(stateDir), files=await readdir(stateDir), fpc=await sponsoredFpc(), calls:string[]=[];
  const fake={getNodeInfo:async()=>{calls.push('getNodeInfo');return network==='local'?{...info(),l1ChainId:31337,realProofs:false}:info();},getContract:async()=>{calls.push('getContract');return fpc.instance;}};
  const args=['--network',network,'--registrar','tiered','--price-version','1','--state-dir',stateDir,'--dry-run'];
  await main(args,{createNode:(()=>fake) as any,randomKeys:()=>{throw new Error('generated');}});
  assert.deepEqual(calls,['getNodeInfo','getContract']);
  assert.deepEqual(await readdir(stateDir),files);assert.equal((await stat(stateDir)).mtimeMs,before.mtimeMs);
  const plan=JSON.parse([...output].reverse().find(line=>line.startsWith('DRY-RUN {'))!.slice(8));
  const c=finalizeConfig(parseOptions(args),keys.treasury.address), p=makePolicy(c,pricing,keys.treasury.address), {artifacts,classIds}=await v6Artifacts('official','tiered');
  const predicted=await instances(artifacts,p,AztecAddress.fromStringUnsafe(keys.owner.address),keys.salts);
  assert.equal(plan.addresses.owner,keys.owner.address);assert.equal(plan.addresses.treasury,keys.treasury.address);
  for(const [key,instance] of Object.entries(predicted.values)) assert.equal(plan.addresses[key],instance.address.toString());
  assert.equal(plan.policy.treasury,keys.treasury.address);assert.equal(plan.addressNotice,'Addresses derived from keys file (public values only)');
  noSecrets(output.join('\n'),keys);
  const manifest=buildManifest(c,p,plan.identity,plan.addresses,classIds,Object.fromEntries(['deploy-token','deploy-registry','deploy-resolver','deploy-registrar','bootstrap'].map(k=>[k,treasury])),new Date().toISOString());
  noSecrets(JSON.stringify(manifest),keys);
  assert.deepEqual(v6ManifestProblems(manifest,{expectNetwork:network}),[]);
  if(network==='testnet-v6') {
    assert.equal(plan.confirm,confirmation(c));
    assert.throws(()=>finalizeConfig({...parseOptions(args),dryRun:false,confirm:'wrong'},keys.treasury.address), /Exact --confirm/);
    assert.equal(finalizeConfig({...parseOptions(args),dryRun:false,confirm:plan.confirm},keys.treasury.address).treasury,keys.treasury.address);
  }
});
test('keyed treasury mismatch rejects before node creation', async t => {
  t.mock.method(console,'log',()=>{});const {stateDir}=await keyFixture(t);let calls=0;
  await assert.rejects(main([...base,'--state-dir',stateDir,'--treasury',treasury,'--dry-run'],{createNode:(()=>{calls++;throw new Error('network');}) as any,randomKeys}), /Treasury does not match keys file/);
  assert.equal(calls,0);assert.deepEqual(await readdir(stateDir),['keys.json']);
});
test('new testnet state requires keys before network and missing treasury keeps original error', async t => {
  const dir=await mkdtemp(join(realTmp,'ans-key-required-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
  const c=parseArgs([...testnet,'--dry-run']);
  await assert.rejects(main([...testnet,'--state-dir',join(dir,'absent'),'--confirm',confirmation(c)],{createNode:(()=>{calls++;throw new Error('network');}) as any,randomKeys}), /Keys file required/);
  assert.equal(calls,0);
  await assert.rejects(main(['--network','testnet-v6','--registrar','tiered','--price-version','1','--state-dir',dir,'--dry-run']), /A valid nonzero --treasury AztecAddress is required/);
});
test('initial state consumes keys without random generation and local fallback remains compatible', async t => {
  t.mock.method(console,'log',()=>{});const {stateDir,keys}=await keyFixture(t);
  const c=finalizeConfig(parseOptions([...base,'--state-dir',stateDir]),keys.treasury.address),identity={chainId:'31337',rollupVersion:'679261766',rollup:V6_PROFILES['testnet-v6'].rollup};let generated=0;
  const state=await buildInitialState(c,pricing,identity,c.manifestOut,treasury,keys,()=>{generated++;return randomKeys();});
  assertCheckpointKeys(state,keys);assert.equal(generated,0);assert.equal(state.schema,'ans-deploy-v6-state/1');
  assert(JSON.stringify(state.keys.owner)===JSON.stringify({secret:keys.owner.secret,salt:keys.owner.salt,signingKey:keys.owner.signingKey}));
  assert.equal(state.config.treasury,keys.treasury.address);assert(JSON.stringify(state.salts)===JSON.stringify(keys.salts));
  const fallback=await buildInitialState({...c,treasury:undefined},pricing,identity,c.manifestOut,treasury,undefined,()=>{generated++;return randomKeys();});
  assert.equal(generated,1);assert.equal(fallback.config.treasury,fallback.addresses.owner);
});
test('checkpoint compatibility and each keys mismatch stop before wallet creation', async t => {
  t.mock.method(console,'log',()=>{});const {stateDir,keys}=await keyFixture(t);
  const c=finalizeConfig(parseOptions([...base,'--state-dir',stateDir]),keys.treasury.address),identity={chainId:'31337',rollupVersion:'679261766',rollup:V6_PROFILES['testnet-v6'].rollup},fpc=await sponsoredFpc();
  const original=await buildInitialState(c,pricing,identity,c.manifestOut,fpc.instance.address.toString(),keys);
  let walletCalls=0;t.mock.method(EmbeddedWallet,'create',async()=>{walletCalls++;throw new Error('wallet boundary sentinel');});
  const deps={createNode:(()=>({getNodeInfo:async()=>({...info(),l1ChainId:31337,realProofs:false}),getContract:async()=>fpc.instance})) as any,randomKeys};
  const changes=[(s:typeof original)=>{s.keys.owner.secret=Fr.random().toString();},(s:typeof original)=>{s.keys.owner.salt=Fr.random().toString();},(s:typeof original)=>{s.keys.owner.signingKey=Fr.random().toString();},(s:typeof original)=>{s.salts.token=Fr.random().toString();},(s:typeof original)=>{s.addresses.owner=treasury;},(s:typeof original)=>{s.config.treasury=treasury;}];
  for(const change of changes){const state=structuredClone(original);change(state);await atomicJson(join(stateDir,'state.json'),state);await assert.rejects(main([...base,'--state-dir',stateDir],deps), /Checkpoint keys file mismatch/);assert.equal(walletCalls,0);}
  await atomicJson(join(stateDir,'state.json'),original);
  await assert.rejects(main([...base,'--state-dir',stateDir],deps), /wallet boundary sentinel/);assert.equal(walletCalls,1);
  await rm(join(stateDir,'keys.json'));
  await assert.rejects(main([...base,'--state-dir',stateDir,'--treasury',keys.treasury.address],deps), /wallet boundary sentinel/);assert.equal(walletCalls,2);
  assert.deepEqual((await readdir(stateDir)).sort(),['state.json']);
});

for (const network of ['local', 'testnet-v6'] as const) {
  for (const dryRun of [false, true]) test(`${network} client limits batches to three (dryRun=${dryRun})`, async t => {
    const { stateDir, keys } = await keyFixture(t, network);
    const args = ['--network', network, '--registrar', 'tiered', '--price-version', '1', '--state-dir', stateDir];
    const c = finalizeConfig(parseOptions([...args, '--dry-run']), keys.treasury.address);
    args.push(...(dryRun ? ['--dry-run'] : network === 'testnet-v6' ? ['--confirm', confirmation(c)] : []));
    const stopped = new Error('stop before network I/O');
    const createNode = t.mock.fn<NonNullable<Parameters<typeof main>[1]>['createNode']>(() => { throw stopped; });
    await assert.rejects(main(args, { createNode, randomKeys }), error => error === stopped);
    assert.equal(createNode.mock.callCount(), 1);
    assert.deepEqual(createNode.mock.calls[0].arguments, [c.nodeUrl, { maxBatchSize: 3 }]);
  });
}

import { assertV6FeeJuice } from './v6-network.js';
import { selectFeeJuice, readFeeJuiceBalance, type BridgeClaim } from './fee-juice-payment.js';
const { V6_MAINNET } = createRequire(import.meta.url)('../../scripts/deployment-config.mjs');
test('mainnet profile matches independent mjs and Fee Juice mismatches refuse', () => {
  const { nodeUrl, maxBatchSize, ...p } = V6_PROFILES.mainnet;
  assert.equal(nodeUrl, null); assert.equal(maxBatchSize, 3); assert.deepEqual(p, V6_MAINNET);
  const feeInfo = { ...info(), l1ContractAddresses: { ...info().l1ContractAddresses, feeJuicePortalAddress: V6_PROFILES['testnet-v6'].feeJuicePortal, feeAssetHandlerAddress: V6_PROFILES['testnet-v6'].feeAssetHandler } };
  assert.doesNotThrow(() => assertV6FeeJuice('testnet-v6', feeInfo));
  assert.throws(() => assertV6FeeJuice('testnet-v6', { ...feeInfo, l1ContractAddresses: { ...feeInfo.l1ContractAddresses, feeJuicePortalAddress: treasury } }), /feeJuicePortal/);
  assert.throws(() => assertV6FeeJuice('testnet-v6', { ...feeInfo, l1ContractAddresses: { ...feeInfo.l1ContractAddresses, feeAssetHandlerAddress: treasury } }), /feeAssetHandler/);
});
test('sponsored testnet confirmation is byte-identical to original fixture', () => {
  const c = parseArgs([...testnet, '--dry-run']);
  assert.equal(confirmation(c), `testnet-v6:6.0.0:11155111:679261766:0x1f435a7f2da358caf887a470faeee7d5d5f4efba:registrar=tiered:priceVersion=1:token=official:treasury=${treasury}`);
});
test('sponsored manifest deep-equals existing deployed output', async () => {
  const current = JSON.parse(await readFile(join(REPO, 'deployments/testnet-v6.json'), 'utf8'));
  const c = parseArgs(['--network', 'testnet-v6', '--registrar', current.registrarKind, '--price-version', String(current.priceVersion), '--treasury', current.treasury, '--dry-run']);
  const p = makePolicy(c, { decimals: current.feeDecimals, annualPrice: current.annualPrice, lengthPrices: current.lengthPrices }, current.treasury);
  const identity = { chainId: current.chainId, rollupVersion: current.rollupVersion, rollup: current.rollup };
  const actual = buildManifest(c, p, identity, { ...current, token: current.feeToken }, current.classIds, current.transactions, current.deployedAt);
  assert.deepEqual(actual, current);
  assert.equal(JSON.stringify(actual, null, 2) + '\n', await readFile(join(REPO, 'deployments/testnet-v6.json'), 'utf8'));
  const feeJuice = buildManifest({ ...c, feePayment: 'fee-juice' }, p, identity, { ...current, token: current.feeToken }, current.classIds, current.transactions, current.deployedAt);
  assert.deepEqual(feeJuice, { ...current, feePayment: 'fee-juice', sponsoredFpc: null });
});
test('fee-juice rehearsal requires dated isolated state and explicit manifest outside deployments', () => {
  const extra = ['--fee-payment', 'fee-juice', '--min-fee-juice', '1', '--dry-run'];
  const dir = '/tmp/testnet-aztec6-6.0.0-nofpc-rehearsal-20261102';
  for (const wrong of ['/tmp/testnet-aztec6-6.0.0', '/tmp/undated', dir + 'x']) assert.throws(() => parseArgs([...testnet, ...extra, '--state-dir', wrong, '--manifest-out', '/tmp/result.json']), /rehearsal/);
  assert.throws(() => parseArgs([...testnet, ...extra, '--state-dir', dir]), /explicit/);
  assert.throws(() => parseArgs([...testnet, ...extra, '--state-dir', dir, '--manifest-out', join(REPO, 'deployments/rehearsal.json')]), /deployments/);
  const c = parseArgs([...testnet, ...extra, '--state-dir', dir, '--manifest-out', '/tmp/result.json']); assert.match(confirmation(c), /:fee=fee-juice$/);
  assert.throws(() => parseArgs([...testnet, '--fee-payment', 'fee-juice', '--dry-run']), /min-fee-juice/);
});
test('mainnet refuses before node creation; dry run only calls getNodeInfo', async () => {
  const args = ['--network', 'mainnet', '--node-url', 'https://rpc.invalid', '--registrar', 'flat', '--price-version', '1', '--state-dir', '/tmp/ans-mainnet-refusal', '--manifest-out', '/tmp/mainnet-refusal.json', '--min-fee-juice', '1'];
  let calls = 0;
  await assert.rejects(main(args, { createNode: (() => { calls++; throw new Error('Must not create node'); }) as any, randomKeys }), /Mainnet blocked:.*settlement.l2Token/);
  assert.equal(calls, 0);
  const methods: string[] = [];
  await main([...args, '--dry-run'], { createNode: (() => ({ getNodeInfo: async () => { methods.push('getNodeInfo'); return { nodeVersion: '6.0.0', l1ChainId: 1, rollupVersion: 2070860440, realProofs: true, l1ContractAddresses: { rollupAddress: V6_PROFILES.mainnet.rollup } }; } })) as any, randomKeys });
  assert.deepEqual(methods, ['getNodeInfo']);
});
test('Fee Juice selection covers funded, claim, insufficient, reserved and consumed resume', () => {
  const claim = { complete: true } as BridgeClaim;
  assert.equal(selectFeeJuice(10n, 10n, claim, { done: [] }, 'deploy-token'), 'funded');
  assert.equal(selectFeeJuice(0n, 10n, claim, { done: [] }, 'deploy-token'), 'claim');
  assert.throws(() => selectFeeJuice(0n, 10n, undefined, { done: [] }, 'deploy-token'), /insufficient/);
  const state = { done: ['deploy-token'], feeClaim: { usedBy: 'deploy-token' } };
  assert.throws(() => selectFeeJuice(0n, 10n, claim, state, 'deploy-registry'), /unconsumed/);
  assert.throws(() => selectFeeJuice(0n, 10n, claim, state, 'deploy-token'), /unconsumed/);
  assert.equal(selectFeeJuice(0n, 10n, claim, { done: [], feeClaim: { usedBy: 'deploy-token' } }, 'deploy-token'), 'claim');
});
test('Fee Juice public read uses stdlib-derived owner map slot at protocol address 3', async () => {
  const { deriveStorageSlotInMap } = await import('@aztec-labs/stdlib/hash');
  const { Fr } = await import('@aztec-labs/aztec.js/fields');
  const { AztecAddress } = await import('@aztec-labs/aztec.js/addresses');
  const owner = AztecAddress.fromStringUnsafe(treasury), expected = await deriveStorageSlotInMap(new Fr(1), owner);
  assert.equal(await readFeeJuiceBalance({ getPublicStorageAt: async (block, address, slot) => { assert.equal(block, 'latest'); assert.equal(address.toBigInt(), 3n); assert.equal(slot.toString(), expected.toString()); return new Fr(123); } }, owner), 123n);
});
