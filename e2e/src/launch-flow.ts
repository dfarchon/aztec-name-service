/** Proof-disabled local acceptance. Intentionally races policy only after the reveal has been proven. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AnsContext, RegistryReader, NameRegistrarLaunchContract, NameResolverContract, prepareRegistration, submitCommit, submitRegistration, checkRegistration, renew, normalizeName, nodeOf, type RegistrationPlan } from '@ans/sdk';
import { NameRegistryV6Contract } from '../../sdk/src/artifacts/NameRegistryV6.js';
import { Contract, NO_WAIT, type InteractionFeeOptions } from '@aztec-labs/aztec.js/contracts';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { TxStatus } from '@aztec-labs/aztec.js/tx';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client';
type AztecNodeDebug=ReturnType<typeof createAztecNodeDebugClient>;
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import { newWallet, sponsoredFpc } from './common.js';
import { switchLaunchRegistrar } from './launch-admin.js';

export async function exerciseLaunchFlow(raw:AztecNode,debug:AztecNodeDebug,wallet:EmbeddedWallet,admin:AztecAddress,alice:AztecAddress,recipient:AztecAddress,treasury:AztecAddress,fee:InteractionFeeOptions,check:(name:string,value:unknown)=>void) {
  assert.equal((await raw.getNodeInfo()).realProofs,false,'Launch acceptance is proof-disabled local only');
  assert.equal(Number((await raw.getNodeInfo()).l1ChainId),31337,'Launch acceptance is local only');
  const YEAR=31536000n;
  const node=raw;
  // A separate PXE sends the admin policy update while the reveal's wallet waits at the raw broadcast boundary.
  const racingWallet=await newWallet(raw);
  try {
    const sponsor=await sponsoredFpc();await racingWallet.registerContract(sponsor.instance,sponsor.artifact);
    const [initial]=await getInitialTestAccountsData();
    const racingAdmin=(await racingWallet.createSchnorrInitializerlessAccount(initial.secret,initial.salt,initial.signingKey)).address;
    assert(racingAdmin.equals(admin));
    const {contract:core}=await NameRegistryV6Contract.deploy(wallet,AztecAddress.ZERO).send({from:admin,fee});
    const {contract:resolver}=await NameResolverContract.deploy(wallet,core.address).send({from:admin,fee});
    const {contract:free}=await NameRegistrarLaunchContract.deploy(wallet,core.address,AztecAddress.ZERO,AztecAddress.ZERO,0n,0n,0n,1,7,false,0n).send({from:admin,fee});
    await core.methods.bootstrap(free.address,resolver.address).send({from:admin,fee});
    const reader=await RegistryReader.connect(node,core.address),owner=new AnsContext(reader,{wallet,account:alice,fee}),administrator=owner.as(admin);
    const readName=async(n:bigint)=>reader.getName(n,await reader.snapshot());
    const readCommit=async(n:bigint)=>reader.getCommit(n,await reader.snapshot());
    const mature=async(plan:RegistrationPlan)=>{await debug.warpL2TimeAtLeastBy(70);assert.equal((await checkRegistration(reader,plan,0n)).state,'ready_to_register');};
    const prepare=async(name:string)=>{let plan=await prepareRegistration(owner,{name,duration:YEAR});({plan}=await submitCommit(owner,plan));await mature(plan);return plan;};
    const plan=await prepare('launchfree');
    check('launch free quote has zero max fee and zero token',plan.fee===0n&&plan.maxFee===0n&&plan.feeToken===AztecAddress.ZERO.toString());
    await submitRegistration(owner,plan);const held=await readName(plan.node);
    await renew(owner,{name:plan.label,duration:YEAR});
    check('launch free registration and renewal extend exactly one year',(await readName(plan.node)).expiresAt===held.expiresAt+YEAR);
    const reserved=await nodeOf(normalizeName('reservedlaunch'));
    const batch=(n:bigint)=>[n,...Array<bigint>(31).fill(0n)];
    await free.methods.set_reserved(batch(reserved),true).send({from:admin,fee});
    await assert.rejects(prepareRegistration(owner,{name:'reservedlaunch',duration:YEAR}),(e:any)=>e.code==='name_reserved');
    check('launch reserved public name fails before signing',true);
    await free.methods.set_paused(true).send({from:admin,fee});
    await assert.rejects(prepareRegistration(owner,{name:'pausedlaunch',duration:YEAR}),(e:any)=>e.code==='registration_paused');
    await renew(owner,{name:plan.label,duration:YEAR});
    const short=normalizeName('abc'),shortNode=await nodeOf(short),snap=await reader.snapshot(),expiry=snap.timestamp+86400n,secret=Fr.random();
    await free.methods.set_reserved(batch(shortNode),true).send({from:admin,fee});
    const commitment=(await free.methods.admin_commitment(recipient,short.bytes,short.len,0,expiry,secret).simulate({from:admin})).result;
    await free.methods.commit(commitment).send({from:admin,fee});await debug.warpL2TimeAtLeastBy(70);
    await free.methods.admin_register(short.bytes,short.len,recipient,0,expiry,secret).send({from:admin,fee});
    check('paused launch admin mints a reserved short name directly to recipient',(await readName(shortNode)).owner.equals(recipient));
    await renew(owner.as(recipient),{name:'abc',duration:YEAR});
    check('pause leaves holder renewal open, including reserved short names',true);
    await free.methods.set_paused(false).send({from:admin,fee});
    const resumed=await prepare('resumedlaunch');await submitRegistration(owner,resumed);
    check('launch resumes public registration',true);
    const repo=loadContractArtifact(JSON.parse(await readFile(new URL('../../contracts/target/test_token-Token.json',import.meta.url),'utf8')));
    const {contract:token}=await Contract.deploy(wallet,repo,[admin,'ans-launch-token'.padEnd(31,'0'),'LAUNCH'.padEnd(31,'0'),6]).send({from:admin,fee});
    await token.methods.mint_to_private(alice,100n).send({from:admin,fee});
    const {contract:paid}=await NameRegistrarLaunchContract.deploy(wallet,core.address,token.address,treasury,1n,128n,32n,2,7,true,0n).send({from:admin,fee});
    // A second wallet uses the same supported launch artifact for the post-proof policy update.
    const paidInstance=await raw.getContract(paid.address);assert(paidInstance);await racingWallet.registerContract(paidInstance,NameRegistrarLaunchContract.artifact);
    const racingPaid=NameRegistrarLaunchContract.at(paid.address,racingWallet);
    const retired=await prepare('retiredlaunch');
    await switchLaunchRegistrar(administrator,paid.address,[],{broadcast:true});
    check('paid switch copies reservations and live policy',(await reader.isReserved(shortNode))&&(await reader.getConfig()).launch?.paused===false);
    check('registrar switch invalidates old plans',(await checkRegistration(reader,retired)).state==='policy_changed');
    const balance=async(who:AztecAddress)=>BigInt((await token.methods.balance_of_private(who).simulate({from:who})).result as bigint);
    // Repository Token is a local fixture class. Register explicitly; the public SDK still rejects unsupported fee assets.
    const witness=async(p:RegistrationPlan)=>owner.queue.run(async()=>{
      await owner.assertWalletNetwork();
      const action=await token.methods.transfer_in_private(alice,treasury,p.fee,p.feeNonce).request();
      return wallet.createAuthWit(alice,{caller:paid.address,call:action.calls[0]});
    });
    const reveal=async(p:RegistrationPlan)=>{const label=normalizeName(p.label);return paid.methods.register(label.bytes,label.len,p.expectedGeneration,p.duration,p.maxFee,p.quoteExpiry,p.feeNonce,p.secret);};
    const paidPlan=await prepare('paidlaunch');let before=await balance(alice),received=await balance(treasury);
    await (await reveal(paidPlan)).send({from:alice,fee,authWitnesses:[await witness(paidPlan)]});
    check('paid launch charges the exact repository-token fee',before-await balance(alice)===1n&&await balance(treasury)-received===1n);
    const race=await prepare('paidreserved');before=await balance(alice);received=await balance(treasury);
    // Change policy only after the wallet has simulated and proven the reveal.
    {
      // Use a proven transaction produced by the existing wallet; intercept the raw node only at sendTx.
      // The supplied wallet's node is raw, so temporarily hook that client's sendTx at this local boundary.
      const originalSend=raw.sendTx.bind(raw);let injected=false;
      raw.sendTx=async(tx)=>{if(!injected){injected=true;await racingPaid.methods.set_reserved(batch(race.node),true).send({from:racingAdmin,fee});}return originalSend(tx);};
      let hash:Awaited<ReturnType<typeof raw.getTxReceipt>>|undefined;
      try {
        const sent=await (await reveal(race)).send({from:alice,fee,authWitnesses:[await witness(race)],wait:NO_WAIT});
        const deadline=Date.now()+180_000;
        do {hash=await raw.getTxReceipt(sent.txHash);if([TxStatus.CHECKPOINTED,TxStatus.PROVEN,TxStatus.FINALIZED].includes(hash.status))break;assert(Date.now()<deadline,'Reserved revert receipt timed out');await new Promise(r=>setTimeout(r,1000));}while(true);
        assert(hash.hasExecutionReverted(),'Must observe an included public revert, not a simulation or dropped transaction');
        console.log(`LAUNCH_REVERT_RECEIPT ${sent.txHash} ${hash.status}`);
      } finally {raw.sendTx=originalSend;}
      assert(injected,'The reservation must change after the reveal reaches broadcast');
      const after=await balance(alice),afterTreasury=await balance(treasury);
      console.log(`LAUNCH_ROLLBACK_BALANCES payer=${before}/${after} treasury=${received}/${afterTreasury}`);
      // S4: this assertion is intentionally fatal; never hide or relax a private-fee rollback failure.
      assert.equal(after,before,'S4: public revert retained payer private fee debit');
      assert.equal(afterTreasury,received,'S4: public revert retained treasury private fee credit');
      check('public reserved-name revert rolls back the private fee transfer',true);
      check('reverted reveal leaves ownership and commitment unconsumed',(await readName(race.node)).generation===0&&!(await readCommit(race.commitment)).consumed);
    }
  } finally {await racingWallet.stop();}
}
