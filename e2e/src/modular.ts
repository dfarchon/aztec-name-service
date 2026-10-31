/** Isolated acceptance for administrator configuration, holder migration and paid name operations. */
import assert from 'node:assert/strict';
import { exerciseExtensions } from './extensions.js';
import { writeFile } from 'node:fs/promises';
import pricing from '../../deployments/aztec-pricing.json' with { type: 'json' };
import {
  AnsContext, RegistryReader, NameRegistryContract, NameRegistryV5Contract, NameRegistrarContract, NameResolverContract,
  getAvailability, prepareRegistration, submitCommit, submitRegistration, checkRegistration, setAddress, setPrimary,
  resolveAddress, resolvePrimary, listOwnedNames, buildFeeAuthorization, renew, setResolver, migrateName,
  type RegistrationPlan,
  createRegistrationFlow, getFeeReadiness, configureModules, setAdministrator,
} from '@ans/sdk';
import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client';
import { TokenContract, TokenContractArtifact } from '@aztec-labs/noir-contracts.js/Token';
import { newWallet, randomKeys, sponsoredFpc } from './common.js';

const url = process.env.NODE_URL ?? 'http://127.0.0.1:8082';
const adminUrl = process.env.ANS_DEBUG_URL ?? url;
if (!['localhost','127.0.0.1'].includes(new URL(url).hostname) || !['localhost','127.0.0.1'].includes(new URL(adminUrl).hostname)) throw new Error('This rehearsal is local-only');
const node = createAztecNodeClient(url);
const info = await node.getNodeInfo();
assert.equal(info.realProofs,false,'this rehearsal requires an isolated proof-disabled local node');
const debug=createAztecNodeDebugClient(adminUrl);
const wallet=await newWallet(node);
const YEAR=31536000n,PRICE=1000000n;
const checks:string[]=[];
const check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push(name);console.log(`PASS ${checks.length}: ${name}`);};
const rejected=async(name:string,action:()=>Promise<unknown>)=>{await assert.rejects(action);check(name,true);};
try {
  const fpc=await sponsoredFpc();await wallet.registerContract(fpc.instance,fpc.artifact);const fee=fpc.fee.fee;
  const [keys]=await getInitialTestAccountsData();
  const admin=(await wallet.createSchnorrInitializerlessAccount(keys.secret,keys.salt,keys.signingKey)).address;
  const newAccount=async()=>{const k=randomKeys();return (await wallet.createSchnorrInitializerlessAccount(k.secret,k.salt,k.signingKey)).address;};
  const alice=await newAccount(),bob=await newAccount(),treasury=await newAccount();
  const {contract:token}=await TokenContract.deploy(wallet,admin,'ANS Fee','ANSF',6).send({from:admin,fee});
  await token.methods.mint_to_private(alice,PRICE*30n).send({from:admin,fee});
  const {contract:legacy}=await NameRegistryContract.deploy(wallet,token.address,treasury,PRICE,1).send({from:admin,fee});
  const legacyReader=await RegistryReader.connect(node,legacy.address);
  const oldOwner=new AnsContext(legacyReader,{wallet,account:alice,fee});
  const oldTarget=oldOwner.as(bob);
  const mature=async(reader:RegistryReader,plan:RegistrationPlan)=>{
    await debug.warpL2TimeAtLeastBy(70);
    assert.equal((await checkRegistration(reader,plan,0n)).state,'ready_to_register');
  };
  const register=async(ctx:AnsContext,name:string)=>{
    let plan=await prepareRegistration(ctx,{name,duration:YEAR});
    ({plan}=await submitCommit(ctx,plan));await mature(ctx.reader,plan);await submitRegistration(ctx,plan);return plan;
  };
  await oldOwner.ensureRegistered({feeToken:{address:token.address,artifact:TokenContractArtifact}});
  await register(oldOwner,'legacy-name');
  await setAddress(oldOwner,{name:'legacy-name',address:bob});await setPrimary(oldTarget,{name:'legacy-name'});
  const oldName=await getAvailability(legacyReader,'legacy-name');
  const {contract:core}=await NameRegistryV5Contract.deploy(wallet,legacy.address).send({from:admin,fee});
  const {contract:registrar}=await NameRegistrarContract.deploy(wallet,core.address,token.address,treasury,PRICE,1).send({from:admin,fee});
  const {contract:resolver}=await NameResolverContract.deploy(wallet,core.address).send({from:admin,fee});
  await core.methods.bootstrap(registrar.address,resolver.address).send({from:admin,fee});
  let reader=await RegistryReader.connect(node,core.address);
  let owner=new AnsContext(reader,{wallet,account:alice,fee}), target=owner.as(bob);
  await owner.ensureRegistered({feeToken:{address:token.address,artifact:TokenContractArtifact}});
  const balance=async(a:AztecAddress)=>BigInt((await token.methods.balance_of_private(a).simulate({from:a})).result as bigint);
  check('reader recognizes V5 and exact module fee policy',(await reader.getConfig()).registrar?.equals(registrar.address));
  const available=await getAvailability(reader,'legacy-name');
  check('legacy names are reserved before migration',!available.available&&available.migration?.owner.equals(alice));
  await rejected('another account cannot migrate a legacy name',()=>migrateName(target,'legacy-name'));
  await migrateName(owner,'legacy-name');
  const imported=await getAvailability(reader,'legacy-name');
  check('migration preserves ownership and expiry',imported.record.owner.equals(alice)&&imported.record.expiresAt===oldName.record.expiresAt);
  check('migration copies forward address',(await resolveAddress(reader,'legacy-name')).status==='resolved');
  check('migration does not copy reverse consent',(await resolvePrimary(reader,bob)).status==='none');
  await setPrimary(target,{name:'legacy-name'});
  check('target reconfirms primary on the new registry',(await resolvePrimary(reader,bob)).status==='verified');
  await rejected('migration cannot repeat',()=>migrateName(owner,'legacy-name'));
  const before=await balance(alice), received=await balance(treasury);
  const plan=await register(owner,'modular-name');
  check('V3 plan pins its registrar',plan.v===3&&plan.registrar===registrar.address.toString());
  check('paid registration debits and credits the exact fee',before-await balance(alice)===PRICE&&await balance(treasury)-received===PRICE);
  check('both migrated and registered names appear in discovery',(await listOwnedNames(reader,alice)).names.length===2);
  await setAddress(owner,{name:'modular-name',address:bob});await setPrimary(target,{name:'modular-name'});
  check('forward and reverse resolution works through modular writes',(await resolvePrimary(reader,bob)).status==='verified');
  await rejected('non-holder cannot use resolver',()=>setAddress(target,{name:'modular-name',address:bob}));
  // A clearly named local mock verifies 18-decimal arithmetic and token replacement; it is not official AZTEC.
  const aztecPrice=BigInt(pricing.annualPrice);
  const {contract:pricingToken}=await TokenContract.deploy(wallet,admin,'Mock AZTEC','mAZTEC',pricing.decimals).send({from:admin,fee});
  await pricingToken.methods.mint_to_private(alice,aztecPrice*30n).send({from:admin,fee});
  const pricingBalance=async(a:AztecAddress)=>BigInt((await pricingToken.methods.balance_of_private(a).simulate({from:a})).result as bigint);
  const {contract:nextRegistrar}=await NameRegistrarContract.deploy(wallet,core.address,pricingToken.address,treasury,aztecPrice,2).send({from:admin,fee});
  await rejected('module initialization cannot repeat',()=>core.methods.bootstrap(nextRegistrar.address,resolver.address).send({from:admin,fee}));
  await rejected('another account cannot initialize modules',()=>core.methods.bootstrap(nextRegistrar.address,resolver.address).send({from:alice,fee}));
  const retiredPlan=await prepareRegistration(owner,{name:'obsolete-policy',duration:YEAR});
  const administrator = new AnsContext(reader,{wallet,account:admin,fee});
  await rejected('another account cannot configure modules directly',()=>core.methods.configure_modules(1,nextRegistrar.address,resolver.address).send({from:alice,fee}));
  await configureModules(administrator,{registrar:nextRegistrar.address,resolver:resolver.address});
  const pricedCore=core,pricedRegistrar=nextRegistrar,pricedResolver=resolver;
  check('administrator configuration is effective without advancing chain time',(await reader.getModules()).registrar.equals(nextRegistrar.address));
  check('configuration preserves existing name ownership',(await getAvailability(reader,'modular-name')).record.owner.equals(alice));
  check('old unconsumed plan is invalidated by immediate configuration',(await checkRegistration(reader,retiredPlan)).state==='policy_changed');
  await rejected('old plan cannot ask for another payment',()=>submitRegistration(owner,retiredPlan));
  const nextPolicy=await reader.getConfig();
  check('live reader refreshes the token and 18-decimal price instead of returning cached fees',nextPolicy.annualPrice===aztecPrice&&nextPolicy.feeToken.equals(pricingToken.address)&&nextPolicy.priceVersion===2);
  const paymentQuote=await import('@ans/sdk').then(sdk=>sdk.getFeeQuote(reader,{operation:'register',duration:YEAR}));
  const readiness=await getFeeReadiness(owner,paymentQuote);
  check('SDK preflight automatically registers the switched asset and reads its private balance',readiness.ready&&readiness.token?.decimals===18&&readiness.token?.symbol==='mAZTEC');
  const held=await getAvailability(reader,'modular-name');
  const renewalBalance=await pricingBalance(alice),renewalTreasury=await pricingBalance(treasury),legacyTokenBalance=await balance(alice);
  await renew(owner,{name:'modular-name',duration:YEAR});
  check('AZTEC-denominated mock renewal debits and credits exactly 10^18 units',renewalBalance-await pricingBalance(alice)===aztecPrice&&await pricingBalance(treasury)-renewalTreasury===aztecPrice);
  check('renewal after the fee switch does not debit the old ANSF token',await balance(alice)===legacyTokenBalance);
  const registrationBalance=await pricingBalance(alice),registrationTreasury=await pricingBalance(treasury);
  const savedPlans=new Map<string,RegistrationPlan>();
  const flow=createRegistrationFlow(owner,{load:async key=>savedPlans.get(key),save:async(key,plan)=>{savedPlans.set(key,{...plan});}});
  let pricedPlan=await flow.prepare({name:'aztec-pricing',acceptedQuote:await flow.quote(YEAR)});
  const unsent=pricedPlan;
  pricedPlan=await flow.commit(pricedPlan);
  check('SDK saves the secret and submitted commit hash before returning',savedPlans.size===1&&[...savedPlans.values()][0].commitTx===pricedPlan.commitTx);
  const resumed=await flow.commit(unsent);
  check('SDK resumes an old copy by its stored commit hash',resumed.commitTx===pricedPlan.commitTx);
  await mature(reader,pricedPlan);pricedPlan=await flow.finish(pricedPlan);
  const paidBalance=await pricingBalance(alice);
  await flow.finish(unsent);
  check('SDK payment recovery tracks the saved hash without charging twice',await pricingBalance(alice)===paidBalance);
  check('AZTEC-denominated mock registration pins the new token and exact fee',pricedPlan.feeToken===pricingToken.address.toString()&&BigInt(pricedPlan.fee)===aztecPrice&&registrationBalance-await pricingBalance(alice)===aztecPrice&&await pricingBalance(treasury)-registrationTreasury===aztecPrice);
  check('new registrar renews the same ownership record',(await getAvailability(reader,'modular-name')).record.expiresAt===held.record.expiresAt+YEAR);
  const {contract:nextResolver}=await NameResolverContract.deploy(wallet,pricedCore.address).send({from:admin,fee});

  check('new default does not silently replace existing resolver',(await reader.getResolver(held.node,held.record.generation)).equals(pricedResolver.address));
  await setResolver(owner,{name:'modular-name',resolver:nextResolver.address});
  check('explicit resolver change clears address',(await resolveAddress(reader,'modular-name')).status==='unset');
  await setAddress(owner,{name:'modular-name',address:bob});
  check('old primary cannot revive after resolver change',(await resolvePrimary(reader,bob)).status==='stale');
  await setPrimary(target,{name:'modular-name'});
  const current=await getAvailability(reader,'modular-name');
  await rejected('retired per-name resolver cannot write',()=>pricedResolver.methods.set_address(current.node,current.record.generation,current.record.revision,true,bob).send({from:alice,fee}));
  const warpAfterFinality = async (seconds: number) => {
    // Long synthetic warps must not age private logs beyond an unfinalized L1 checkpoint.
    const block = (await node.getChainTips()).checkpointed.block.number;
    await debug.prove();
    const anvilUrl = process.env.ANVIL_URL ?? 'http://127.0.0.1:8547';
    assert(['localhost','127.0.0.1'].includes(new URL(anvilUrl).hostname), 'Local Anvil only');
    const mined = await fetch(anvilUrl, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'anvil_mine',params:['0x40']})});
    const result = await mined.json() as {error?: {message: string}};
    if (!mined.ok || result.error) throw new Error(result.error?.message ?? 'Local L1 finality mining failed');
    const deadline = Date.now() + 60_000;
    while ((await node.getChainTips()).finalized.block.number < block) {
      if (Date.now() >= deadline) throw new Error('Local checkpoints must finalize before a long time warp');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await debug.warpL2TimeAtLeastBy(seconds);
  };
  if (process.env.ANS_EXTENSIONS === '1') await exerciseExtensions(owner,target,warpAfterFinality,check);
  await setAdministrator(administrator,bob);
  await rejected('previous administrator cannot configure through the SDK',()=>configureModules(administrator,{registrar:pricedRegistrar.address,resolver:pricedResolver.address}));
  const nextAdministrator=administrator.as(bob);
  await configureModules(nextAdministrator,{registrar:pricedRegistrar.address,resolver:pricedResolver.address});
  check('administrator handoff is immediate and reads back',(await reader.getAdministrator())?.equals(bob));
  const report={completedAt:new Date().toISOString(),nodeUrl:url,realProofs:false,registry:pricedCore.address.toString(),legacy:legacy.address.toString(),registrar:pricedRegistrar.address.toString(),resolver:pricedResolver.address.toString(),holderResolver:nextResolver.address.toString(),feeToken:pricingToken.address.toString(),previousFeeToken:token.address.toString(),configurationMode:"administrator",administrator:bob.toString(),pricingTest:{mock:true,symbol:'mAZTEC',decimals:pricing.decimals,annualPrice:String(aztecPrice)},sponsoredFpc:fpc.instance.address.toString(),checks};
  await writeFile(process.env.ANS_EXTENSIONS === '1' ? '/tmp/ans-v5-local-report.json' : '/tmp/ans-modular-local-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(`ALL ${checks.length} MODULAR LOCAL CHECKS PASSED`);
} finally {await wallet.stop();}
