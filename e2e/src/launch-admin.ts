/** Launch administration. CLI is read-only; mutations require an injected signer and broadcast:true. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, BlockNumber } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { getPublicEvents, type EventCursor } from '@aztec-labs/aztec.js/events';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import { RegistryReader, NameRegistrarLaunchContract, runTx, configureModules, assertRegistrableLabel, registerCommitment, hashWithSeparator, normalizeName, nodeOf, SECONDS_PER_YEAR, type AnsContext } from '@ans/sdk';
import { executeLaunchSwitch, type SwitchState } from './launch-switch.js';
import { loadReservedList, canonicalReservedLabels, reservedNodes, reservedBatches, reservedListHash, reservationParity, verifyReservations } from './launch-policy.js';

export type LaunchAction = {kind:'reserve';labels:string[];reserved:boolean} | {kind:'minimum';length:number} | {kind:'pause';paused:boolean} | {kind:'mint';name:string;recipient:string};
export async function planLaunchAdmin(reader:RegistryReader, action:LaunchAction) {
  assert(['reserve','minimum','pause','mint'].includes(action.kind),'Unknown launch action');
  if(action.kind==='pause')assert(typeof action.paused==='boolean','Pause must be boolean');
  if(action.kind==='reserve')assert(typeof action.reserved==='boolean','Reserved must be boolean');
  const snap=await reader.snapshot(), config=await reader.getConfig(snap);
  assert(config.launch&&config.registrar,'Active registrar is not launch');
  if(action.kind==='reserve') canonicalReservedLabels(action.labels);
  if(action.kind==='minimum') assert(Number.isInteger(action.length)&&action.length>=3&&action.length<=31,'Minimum must be 3–31');
  if(action.kind==='mint') { assertRegistrableLabel(normalizeName(action.name));assert(!AztecAddress.fromStringUnsafe(action.recipient).isZero(),'Recipient required'); }
  return {dryRun:true,registry:reader.registry.toString(),registrar:config.registrar.toString(),administrator:(await reader.getAdministrator(snap))?.toString(),action};
}
async function target(ctx:AnsContext,address:AztecAddress) {
  const s=await ctx.reader.snapshot();
  assert.equal(await ctx.reader.assertModule(address,'registrar',s),'registrarLaunch');
  assert((await ctx.reader.getAdministrator(s))?.equals(ctx.account),'Not current registry administrator');
  const instance=await ctx.reader.node.getContract(address);assert(instance);
  await ctx.wallet.registerContract(instance,NameRegistrarLaunchContract.artifact);
  return NameRegistrarLaunchContract.at(address,ctx.wallet);
}
export async function runLaunchAdmin(ctx:AnsContext,action:LaunchAction,options:{broadcast?:boolean}={}) {
  const plan=await planLaunchAdmin(ctx.reader,action);
  if(!options.broadcast)return plan;
  const address=AztecAddress.fromStringUnsafe(plan.registrar);
  const send=async(build:(c:ReturnType<typeof NameRegistrarLaunchContract.at>)=>any)=>runTx(ctx,async()=>build(await target(ctx,address)),{preflight:true});
  if(action.kind==='minimum')await send(c=>c.methods.set_min_public_length(action.length));
  if(action.kind==='pause')await send(c=>c.methods.set_paused(action.paused));
  if(action.kind==='reserve')for(const batch of reservedBatches(await reservedNodes(action.labels)))await send(c=>c.methods.set_reserved(batch,action.reserved));
  if(action.kind==='mint') {
    const label=normalizeName(action.name),node=await nodeOf(label),snap=await ctx.reader.snapshot();
    const config=await ctx.reader.getConfig(snap),record=await ctx.reader.getName(node,snap);
    const recipient=AztecAddress.fromStringUnsafe(action.recipient),expiry=snap.timestamp+86400n,secret=Fr.random().toBigInt();
    const base=await registerCommitment({chainId:ctx.reader.deployment.chainId,registry:ctx.reader.registry,node,expectedGeneration:record.generation,owner:recipient,duration:SECONDS_PER_YEAR,feeToken:config.feeToken,treasury:config.treasury,priceVersion:config.priceVersion,maxFee:0n,quoteExpiry:expiry,secret});
    const commitment=await hashWithSeparator([address.toBigInt(),base],0x414e535f41444d494e5f4d494e545f5631n);
    await send(c=>c.methods.commit(commitment));
    const until=Date.now()+30*60_000;
    while(true) {
      const s=await ctx.reader.snapshot(),commit=await ctx.reader.getCommit(commitment,s);
      if(commit.committedAt!==0n&&s.timestamp>=commit.committedAt+60n)break;
      assert(Date.now()<until,'Commit maturation timed out; no mint sent');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    await send(c=>c.methods.admin_register(label.bytes,label.len,recipient,record.generation,expiry,secret));
  }
  return {...plan,dryRun:false};
}
/** Copy policy from a complete pinned ReservedChanged history plus the canonical list, then verify before switching. */
export async function copyLaunchPolicy(ctx:AnsContext,to:AztecAddress,labels:string[],options:{broadcast?:boolean}={}) {
  const snap=await ctx.reader.snapshot(),config=await ctx.reader.getConfig(snap);assert(config.launch&&config.registrar);
  const from=config.registrar;let after:EventCursor|undefined;const events:{node:bigint;reserved:boolean}[]=[];
  for(const source of [from,to]) {
    after=undefined;
    do {
      const page:Awaited<ReturnType<typeof getPublicEvents<{node:bigint;reserved:boolean}>>>=await getPublicEvents<{node:bigint;reserved:boolean}>(ctx.reader.node,NameRegistrarLaunchContract.events.ReservedChanged,{contractAddress:source,toBlock:BlockNumber(snap.blockNumber+1),afterEvent:after});
      events.push(...page.events.map(({event})=>({node:BigInt(event.node),reserved:event.reserved})));after=page.nextCursor;
    }while(after);
  }
  const read=async(address:AztecAddress,node:bigint)=>{const slot=await deriveStorageSlotInMap(NameRegistrarLaunchContract.storage.reserved.slot,new Fr(node));return (await ctx.reader.node.getPublicStorageAt(BlockNumber(snap.blockNumber),address,slot)).toBigInt()!==0n;};
  const parity=await reservationParity(await reservedNodes(labels),events,node=>read(from,node));
  const nextConfig=await ctx.queue.run(async()=>{await ctx.assertWalletNetwork();const next=await target(ctx,to);const cap=(await next.methods.get_max_renew_ahead().simulate({from:ctx.account})).result;assert.equal(BigInt(cap),config.launch!.maxRenewAhead,'Replacement renewal cap differs');return (await next.methods.get_config().simulate({from:ctx.account})).result;});
  assert(Number(nextConfig.price_version)>config.priceVersion,'Replacement price_version must increase');
  if(!options.broadcast)return {dryRun:true,from:from.toString(),to:to.toString(),reservedListHash:reservedListHash(labels),entries:parity.map(e=>({...e,node:e.node.toString()})),policy:config.launch};
  const send=async(build:(c:ReturnType<typeof NameRegistrarLaunchContract.at>)=>any)=>runTx(ctx,async()=>build(await target(ctx,to)),{preflight:true});
  await send(c=>c.methods.set_paused(true));
  await send(c=>c.methods.set_min_public_length(config.launch!.minPublicLength));
  for(const reserved of [true,false])for(const batch of reservedBatches(parity.filter(e=>e.reserved===reserved).map(e=>e.node)))await send(c=>c.methods.set_reserved(batch,reserved));
  // Fresh readback, never use a snapshot from before the copy transactions.
  const fresh=await ctx.reader.snapshot();
  await verifyReservations(parity,async node=>{const slot=await deriveStorageSlotInMap(NameRegistrarLaunchContract.storage.reserved.slot,new Fr(node));return (await ctx.reader.node.getPublicStorageAt(BlockNumber(fresh.blockNumber),to,slot)).toBigInt()!==0n;});
  await send(c=>c.methods.set_paused(config.launch!.paused));
  return {dryRun:false,verified:true,from:from.toString(),to:to.toString(),reservedListHash:reservedListHash(labels)};
}
/** Fresh pinned public policy and complete reservation union, including events added during copying. */
async function readSwitchState(ctx:AnsContext,address:AztecAddress,sources:AztecAddress[],labels:string[]):Promise<SwitchState> {
  const snap=await ctx.reader.snapshot();
  const policy=await ctx.queue.run(async()=>{
    await ctx.assertWalletNetwork();
    const c=await target(ctx,address);
    const p=(await c.methods.get_policy().simulate({from:ctx.account})).result;
    const cap=(await c.methods.get_max_renew_ahead().simulate({from:ctx.account})).result;
    return {minPublicLength:Number(p.min_public_length),paused:p.paused,maxRenewAhead:BigInt(cap)};
  });
  const events:{node:bigint;reserved:boolean}[]=[];
  for(const source of sources) {
    let after:EventCursor|undefined;
    do {
      const page:Awaited<ReturnType<typeof getPublicEvents<{node:bigint;reserved:boolean}>>>=await getPublicEvents(ctx.reader.node,NameRegistrarLaunchContract.events.ReservedChanged,{contractAddress:source,toBlock:BlockNumber(snap.blockNumber+1),afterEvent:after});
      events.push(...page.events.map(({event})=>({node:BigInt(event.node),reserved:event.reserved})));after=page.nextCursor;
    }while(after);
  }
  const entries=await reservationParity(await reservedNodes(labels),events,async node=>{
    const slot=await deriveStorageSlotInMap(NameRegistrarLaunchContract.storage.reserved.slot,new Fr(node));
    return (await ctx.reader.node.getPublicStorageAt(BlockNumber(snap.blockNumber),address,slot)).toBigInt()!==0n;
  });
  // The union can grow while copying the old map to a previously populated replacement.
  // Include false entries too: they are necessary to erase stale replacement reservations.
  return {policy,entries};
}
/** Pause the old instance by default; aborts expose an explicit operator recovery plan. */
export async function switchLaunchRegistrar(ctx:AnsContext,to:AztecAddress,labels:string[],options:{broadcast?:boolean;pauseOldDuringSwitch?:boolean}={}) {
  if(!options.broadcast)return {...await copyLaunchPolicy(ctx,to,labels,options),pauseOldDuringSwitch:options.pauseOldDuringSwitch!==false,
    resumePlan:'On abort inspect active module and policy before restoring the old pause state; successful switches leave the old registrar paused.'};
  const from=(await ctx.reader.getModules()).registrar;
  const result=await executeLaunchSwitch({
    active:async()=>(await ctx.reader.getModules()).registrar.toString(),
    read:address=>readSwitchState(ctx,AztecAddress.fromStringUnsafe(address),[from,to],labels),
    pause:async(address,paused)=>{await runTx(ctx,async()=>(await target(ctx,AztecAddress.fromStringUnsafe(address))).methods.set_paused(paused),{preflight:true});},
    copy:()=>copyLaunchPolicy(ctx,to,labels,{broadcast:true}),
    configure:async()=>{
      const modules=await ctx.reader.getModules();
      assert(modules.registrar.equals(from),'Active registrar changed before configure');
      await configureModules(ctx,{registrar:to,resolver:modules.resolver});
    },
  },from.toString(),to.toString(),options.pauseOldDuringSwitch!==false);
  return {...result,verified:true,dryRun:false};
}
async function cli() {
  const args=process.argv.slice(2);assert(args.length===4,'Usage: launch-admin.ts <node-url> <registry> <action-json> <reserved-labels-json>; read-only preview');
  const reader=await RegistryReader.connect(createAztecNodeClient(args[0]),AztecAddress.fromStringUnsafe(args[1]));
  const action=JSON.parse(args[2]) as LaunchAction;
  if(action.kind==='reserve')action.labels=loadReservedList(JSON.parse(await readFile(args[3],'utf8')));
  console.log(JSON.stringify(await planLaunchAdmin(reader,action),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await cli();
