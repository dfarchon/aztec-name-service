import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, makePolicy, confirmation, deploymentPlan, deploymentTransactionSteps, ZERO } from './deploy-v6-plan.js';
import { canonicalReservedLabels, reservedListHash, reservedNodes, reservedBatches, reservationParity, verifyReservations } from './launch-policy.js';
import { v6Artifacts, instances } from './deploy-v6.js';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
const args=['--network','local','--registrar','launch','--token','none','--price-version','1'];
const pricing={decimals:18,annualPrice:'1000',lengthPrices:{'3':'128000','4':'32000'}};
const treasury=`0x${'0'.repeat(63)}1`;
test('launch free plan defaults to minimum seven, paused and no renewal cap',()=>{
 const c=parseArgs(args),p=makePolicy(c,pricing,treasury);
 assert.equal(c.minPublicLength,7);assert.equal(c.initialPaused,true);assert.equal(c.maxRenewAhead,'0');
 assert.equal(p.annualPrice,'0');assert.deepEqual(p.lengthPrices,{'3':'0','4':'0'});
 assert.equal(p.reservedListHash,reservedListHash([]));
 const plan=deploymentPlan(c,p,{chainId:'31337',rollupVersion:'1',rollup:'0x1'},{},{}) as any;
 const txSteps=deploymentTransactionSteps({...c,reservedLabels:Array.from({length:33},(_,i)=>`reserve${i}`)});
 assert.deepEqual(txSteps.slice(-3),['seed-reserved-0','seed-reserved-1','bootstrap']);assert(!txSteps.includes('verify-reserved'));
 assert.deepEqual(deploymentTransactionSteps(c).slice(-1),['bootstrap']);
 assert(!plan.steps.includes('deploy-token'));assert(plan.steps.indexOf('seed-reserved')<plan.steps.indexOf('verify-reserved'));assert(plan.steps.indexOf('verify-reserved')<plan.steps.indexOf('bootstrap'));
});
test('launch bounds constructor policy flags and isolates none to launch',()=>{
 for(const pair of [['--min-public-length','2'],['--min-public-length','32'],['--initial-paused','yes'],['--max-renew-ahead','-1'],['--max-renew-ahead','315360001'],['--max-renew-ahead','18446744073709551615'],['--max-renew-ahead','18446744073709551616']])assert.throws(()=>parseArgs([...args,...pair]));
 assert.throws(()=>parseArgs(['--network','local','--registrar','tiered','--token','none','--price-version','1']));
 assert.equal(parseArgs([...args,'--max-renew-ahead','31536000']).maxRenewAhead,'31536000');
 assert.equal(parseArgs([...args,'--max-renew-ahead','315360000']).maxRenewAhead,'315360000');
});
test('launch confirmation binds minimum, pause, renewal cap and reserved hash',()=>{
 const c=parseArgs(args),before=confirmation(c);
 for(const patch of [{minPublicLength:5},{initialPaused:false},{maxRenewAhead:'31536000'},{reservedLabels:['reserve']}])assert.notEqual(confirmation({...c,...patch}),before);
 assert.match(before,/registrar=launch/);
});
test('launch paid policy retains length tiers and token selection',()=>{
 const c=parseArgs(args.map(v=>v==='none'?'repo':v)),p=makePolicy(c,pricing,treasury);
 assert.equal(p.annualPrice,'1000');assert.deepEqual(p.lengthPrices,pricing.lengthPrices);assert.equal(p.token,'repo');
 assert.throws(()=>makePolicy(c,{...pricing,annualPrice:'0'},treasury));
});
test('reserved list canonical hash is stable, empty list committed, malformed labels rejected',()=>{
 assert.equal(reservedListHash(['reserve','another']),reservedListHash(['another','reserve']));
 assert.equal(reservedListHash([]),'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
 for(const value of [null,['Reserve'],['abc','abc'],['sub.abc'],['a']])assert.throws(()=>canonicalReservedLabels(value));
});
test('reserved batching pads exactly 32 and empty list sends no batch',async()=>{
 const n=await reservedNodes(['reserve']);assert.equal(n.length,1);assert.notEqual(n[0],0n);
 assert.deepEqual(reservedBatches([]),[]);assert.equal(reservedBatches(n)[0].length,32);
 assert.equal(reservedBatches(Array.from({length:33},(_,i)=>BigInt(i+1))).length,2);
});
test('event-discovered dynamic reservations and removals are verified before switch',async()=>{
 const entries=await reservationParity([1n],[{node:2n,reserved:true},{node:3n,reserved:false}],async n=>n!==3n);
 assert.deepEqual(entries,[{node:1n,reserved:true},{node:2n,reserved:true},{node:3n,reserved:false}]);
 await verifyReservations(entries,async n=>n!==3n);
 await assert.rejects(verifyReservations(entries,async()=>true),/parity mismatch/);
});
test('launch free deterministic constructor uses zero token and exact policy parameters',async()=>{
 const c=parseArgs(args),p=makePolicy(c,pricing,treasury),{artifacts,classIds}=await v6Artifacts('none','launch');
 assert.equal(classIds.token,ZERO);
 const salts=Object.fromEntries(['token','registry','resolver','registrar'].map(k=>[k,Fr.ONE.toString()]));
 const prepared=await instances(artifacts,p,AztecAddress.fromStringUnsafe(treasury),salts);
 assert(prepared.values.token.address.isZero());
 assert.deepEqual(prepared.args.registrar.slice(-3),[7,true,0n]);assert.equal(prepared.args.registrar.length,10);
});

test('launch administration defaults to a read-only preview without touching a signer',async()=>{
 const {runLaunchAdmin}=await import('./launch-admin.js');
 const reader={registry:AztecAddress.fromStringUnsafe(treasury),snapshot:async()=>({}),getConfig:async()=>({registrar:AztecAddress.fromStringUnsafe(treasury),launch:{minPublicLength:7,paused:true,maxRenewAhead:0n}}),getAdministrator:async()=>AztecAddress.fromStringUnsafe(treasury)} as any;
 const ctx={reader,get wallet(){throw Error('dry run must not request wallet');}} as any;
 assert.equal((await runLaunchAdmin(ctx,{kind:'pause',paused:false})).dryRun,true);
 await assert.rejects(runLaunchAdmin(ctx,{kind:'minimum',length:2}),/Minimum/);
});

test('public free deployment needs no payment treasury but still binds network confirmation',()=>{
 const c=parseArgs(['--network','testnet-v6','--registrar','launch','--token','none','--price-version','1','--dry-run']);
 assert.equal(c.treasury,ZERO);assert.equal(c.initialPaused,true);
 assert.throws(()=>parseArgs(['--network','testnet-v6','--registrar','launch','--token','none','--price-version','1']),/confirm/);
});
