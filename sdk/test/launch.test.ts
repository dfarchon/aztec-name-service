import assert from 'node:assert/strict';
import test from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { RegistryReader } from '../src/client/reader.js';
import { nodeOf } from '../src/core/hash.js';
import { normalizeName } from '../src/core/label.js';
import { toAnsError } from '../src/core/errors.js';
import { NameRegistrarLaunchContract } from '../src/artifacts/NameRegistrarLaunch.js';
import { getFeeQuote, buildFeeAuthorization } from '../src/transactions/fees.js';
import { prepareRegistration, submitCommit, submitRegistration } from '../src/transactions/registration.js';
import { getFeeReadiness } from '../src/wallet/fee-balance.js';
import metadata from '../src/artifacts/modular-metadata.json' with { type: 'json' };
import pinned from './fixtures/classids-6.0.0.json' with { type: 'json' };
const addr = (n: bigint) => AztecAddress.fromBigIntUnsafe(n);
const YEAR = 31536000n;
async function fixture() {
  const registry = addr(1n), registrar = addr(2n), resolver = addr(3n), account = addr(5n);
  const snap = { blockNumber: 10, blockHash: 'block-10', timestamp: 1000n, finality: 'checkpointed' as const };
  const classes = new Map([[registry.toString(),metadata.v6.classId],[registrar.toString(),metadata.registrarLaunch.classId],[resolver.toString(),metadata.resolver.classId]]);
  const state = new Map<string,bigint>();
  const write = (address: AztecAddress, slot: string | bigint, values: bigint[]) => values.forEach((v,i)=>state.set(`${address}:${BigInt(slot)+BigInt(i)}`,v));
  write(registry,metadata.v6.storage.modules,[2n,3n,1n]);
  write(registrar,metadata.registrarLaunch.storage.registry,[1n]);
  write(resolver,metadata.resolver.storage.registry,[1n]);
  write(registrar,metadata.registrarLaunch.storage.config,[0n,0n,0n,1n]);
  write(registrar,metadata.registrarLaunch.storage.length_prices,[0n,0n]);
  write(registrar,metadata.registrarLaunch.storage.policy,[7n,0n]);
  write(registrar,metadata.registrarLaunch.storage.max_renew_ahead,[YEAR]);
  const node = {
    getNodeInfo:async()=>({l1ChainId:31337,rollupVersion:1}),
    getContract:async(a:AztecAddress)=>({currentContractClassId:Fr.fromString(classes.get(a.toString())!)}),
    getPublicStorageAt:async(_:unknown,a:AztecAddress,slot:Fr)=>new Fr(state.get(`${a}:${slot.toBigInt()}`)??0n),
    getBlockData:async()=>({blockHash:snap.blockHash,header:{globalVariables:{blockNumber:10,timestamp:1000}}}),
  } as any;
  const reader = await RegistryReader.connect(node,registry);
  reader.getLegacyName=async()=>undefined;
  reader.getName=async()=>({owner:AztecAddress.ZERO,generation:0,revision:0,expiresAt:0n});
  reader.getCommit=async()=>({committedAt:900n,consumed:false});
  const policy=(len:number,paused=false)=>write(registrar,metadata.registrarLaunch.storage.policy,[BigInt(len),BigInt(paused)]);
  const reserve=async(name:string,value=true)=>{const slot=await deriveStorageSlotInMap(new Fr(BigInt(metadata.registrarLaunch.storage.reserved)),new Fr(await nodeOf(normalizeName(name))));write(registrar,slot.toBigInt(),[BigInt(value)]);};
  const ctx={reader,account,get wallet(){throw Error('must not request wallet');},queue:{run:async(fn:()=>unknown)=>fn()},signer:{},ensureRegistered:async()=>{},registrationContract:async()=>{throw Error('must not construct call');}} as any;
  return {reader,registrar,write,policy,reserve,snap,ctx};
}

test('launch artifact class and every storage slot are pinned',async()=>{
  assert.equal((await getContractClassFromArtifact(NameRegistrarLaunchContract.artifact)).id.toString(),pinned.classIds.registrarLaunch);
  assert.deepEqual(metadata.registrarLaunch.storage,Object.fromEntries(Object.entries(NameRegistrarLaunchContract.storage).map(([k,v])=>[k,v.slot.toString()])));
  for(const key of ['registry','config','length_prices'] as const) assert.equal(metadata.registrarLaunch.storage[key],metadata.registrarTiered.storage[key]);
});
test('wallet-free reader decodes launch config, live policy and renewal horizon',async()=>{
  const f=await fixture();
  assert.deepEqual((await f.reader.getConfig(f.snap)).launch,{minPublicLength:7,paused:false,maxRenewAhead:YEAR});
  f.policy(5,true);assert.deepEqual((await f.reader.getConfig(f.snap)).launch,{minPublicLength:5,paused:true,maxRenewAhead:YEAR});
});
test('reserved map derivation matches the protocol helper and supports removal',async()=>{
  const f=await fixture(),n=await nodeOf(normalizeName('reserve'));
  assert.equal(await f.reader.isReserved(n,f.snap),false);await f.reserve('reserve');
  assert.equal(await f.reader.isReserved(n,f.snap),true);await f.reserve('reserve',false);
  assert.equal(await f.reader.isReserved(n,f.snap),false);
});
test('launch eligibility follows live pause, minimum and reservation at a snapshot',async()=>{
  const f=await fixture();assert.equal(await f.reader.eligibility('seventh',f.snap),'open');
  assert.equal(await f.reader.eligibility('sixsix',f.snap),'too_short');f.policy(5);
  assert.equal(await f.reader.eligibility('fifth',f.snap),'open');await f.reserve('reserve');
  assert.equal(await f.reader.eligibility('reserve',f.snap),'reserved');f.policy(5,true);
  assert.equal(await f.reader.eligibility('seventh',f.snap),'paused');
});
test('free quote and readiness require neither wallet nor token authorization',async()=>{
  const f=await fixture(),quote=await getFeeQuote(f.reader,{operation:'register',duration:YEAR,labelLength:7,snapshot:f.snap});
  assert.equal(quote.fee,0n);assert.equal(quote.maxFee,0n);
  assert.equal(await buildFeeAuthorization(f.ctx,{...quote,feeNonce:1n}),undefined);
  assert.equal((await getFeeReadiness(f.ctx,quote)).ready,true);
});
test('launch quote rejects any duration other than one year for register and renew',async()=>{
  const f=await fixture();for(const operation of ['register','renew'] as const)
    await assert.rejects(getFeeQuote(f.reader,{operation,duration:2n*YEAR,labelLength:7,snapshot:f.snap}),(e:any)=>e.code==='invalid_argument');
});
for(const [state,code] of [['too_short','name_not_available_yet'],['reserved','name_reserved'],['paused','registration_paused']] as const)
  test(`launch ${state} prevents plan preparation without wallet access`,async()=>{
    const f=await fixture();if(state==='reserved')await f.reserve('seventh');if(state==='paused')f.policy(7,true);
    await assert.rejects(prepareRegistration(f.ctx,{name:state==='too_short'?'sixsix':'seventh',duration:YEAR}),(e:any)=>e.code===code);
  });
test('policy changes after preparation block commit and reveal before constructing calls',async()=>{
  const f=await fixture(),plan=await prepareRegistration(f.ctx,{name:'seventh',duration:YEAR});
  f.policy(7,true);
  await assert.rejects(submitCommit(f.ctx,plan),(e:any)=>e.code==='registration_paused');
  await assert.rejects(submitRegistration(f.ctx,plan),(e:any)=>e.code==='registration_paused');
});
test('launch assertion messages expose stable SDK error codes',()=>{
  for(const [message,code] of [['name reserved','name_reserved'],['name not yet available','name_not_available_yet'],['registration paused','registration_paused'],['lease must be one year','invalid_argument']] as const)
    assert.equal(toAnsError(new Error(message)).code,code);
});

test('wallet context selects the launch artifact and target kind',async()=>{
  const f=await fixture();
  const {AnsContext}=await import('../src/wallet/context.js');
  let artifact:unknown;
  const wallet={registerContract:async(_:unknown,a:unknown)=>{artifact=a;}} as any;
  const ctx=new AnsContext(f.reader,{wallet,account:addr(5n)});
  assert.equal((await ctx.registrationTarget(f.registrar.toString())).kind,'registrarLaunch');
  assert.equal(artifact,NameRegistrarLaunchContract.artifact);
});

test('launch renewal sends label arguments while pause and reservations do not gate holders',async()=>{
  const f=await fixture();f.policy(7,true);await f.reserve('abc');
  const {renew}=await import('../src/transactions/holder.js');
  const {TxStatus,TxHash}=await import('@aztec-labs/aztec.js/tx');
  const account=addr(5n),label=normalizeName('abc');let args:unknown[]=[];
  f.reader.getName=async()=>({owner:account,generation:1,revision:2,expiresAt:2000n});
  f.reader.node.getTxReceipt=async()=>({status:TxStatus.CHECKPOINTED,blockNumber:10,hasExecutionReverted:()=>false}) as any;
  const ctx=Object.assign(f.ctx,{assertWalletNetwork:async()=>{},registrationTarget:async()=>({kind:'registrarLaunch',contract:{methods:{renew:(...values:unknown[])=>{args=values;return {send:async()=>({txHash:TxHash.random()})};}}}})});
  await renew(ctx,{name:label,duration:YEAR});
  assert.equal(args.length,8);assert.deepEqual(args.slice(0,5),[label.bytes,3,1,2,YEAR]);
});

test('launch reveal simulates before send by default',async()=>{
  const f=await fixture(),plan=await prepareRegistration(f.ctx,{name:'seventh',duration:YEAR});
  const {TxStatus,TxHash}=await import('@aztec-labs/aztec.js/tx');
  let simulations=0,sends=0;
  f.reader.node.getTxReceipt=async()=>({status:TxStatus.CHECKPOINTED,blockNumber:10,hasExecutionReverted:()=>false}) as any;
  f.ctx.registrationContract=async()=>({methods:{register:()=>({simulate:async()=>{simulations++;},send:async()=>{assert.equal(simulations,1);sends++;return {txHash:TxHash.random()};}})}});
  await submitRegistration(f.ctx,plan);
  assert.equal(sends,1);assert.equal(simulations,1);
});
