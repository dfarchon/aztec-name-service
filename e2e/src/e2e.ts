/** Local Aztec 5.2.1 acceptance for the public-owner, single-address protocol. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import {
  AnsContext, checkRegistration, clearAddress, clearPrimary, connectAns, deserializePlan, getAvailability, getPrivateFeeBalance,
  inspectHolding, listOwnedNames, NameRegistryContract, normalizeName, prepareRegistration,
  RegistryReader, renew, resolveAddress, resolvePrimary, resolvePrimaryMany, serializePlan,
  setAddress, setPrimary, submitCommit, submitRegistration, type RegistrationPlan,
} from '@ans/sdk';
import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { TokenContract, TokenContractArtifact } from '@aztec-labs/noir-contracts.js/Token';
import { newWallet, NODE_URL, randomKeys, sponsoredFpc } from './common.js';

const YEAR = 31536000n;
const PRICE = 1000000n;
const node = createAztecNodeClient(NODE_URL);
const wallet = await newWallet(node);
let recovered: Awaited<ReturnType<typeof newWallet>> | undefined;
let checks = 0;
function check(message: string, value: unknown) { assert.ok(value, message); console.log(`PASS ${++checks}: ${message}`); }
try {
  const fpc = await sponsoredFpc();
  await wallet.registerContract(fpc.instance, fpc.artifact);
  const fee = fpc.fee.fee;
  const [keys] = await getInitialTestAccountsData();
  const deployer = (await wallet.createSchnorrInitializerlessAccount(keys.secret, keys.salt, keys.signingKey)).address;
  const ownerKeys = randomKeys();
  const alice = (await wallet.createSchnorrInitializerlessAccount(ownerKeys.secret, ownerKeys.salt, ownerKeys.signingKey)).address;
  const createAccount = async () => { const k = randomKeys(); return (await wallet.createSchnorrInitializerlessAccount(k.secret, k.salt, k.signingKey)).address; };
  const gamer = await createAccount();
  const treasury = await createAccount();
  const { contract: token } = await TokenContract.deploy(wallet, deployer, 'ANS Fee', 'ANSF', 6).send({ from: deployer, fee });
  await token.methods.mint_to_private(alice, PRICE * 20n).send({ from: deployer, fee });
  const { contract: contract } = await NameRegistryContract.deploy(wallet, token.address, treasury, PRICE, 1).send({ from: deployer, fee });
  const reader = await RegistryReader.connect(node, contract.address);
  const deployment = { registry: contract.address.toString(), chainId: String(reader.deployment.chainId), rollupVersion: String(reader.deployment.rollupVersion) };
  const holder = await connectAns(reader, { wallet, account: alice, deployment });
  // The isolated node permits this local FPC without public instance publication.
  // Public connectAns sponsor verification remains covered separately and must not be bypassed.
  holder.signer.fee = fee;
  check('SDK connects a real EmbeddedWallet with matching chain and rollup identities', holder.account.equals(alice));
  const wrongNetworkWallet = new Proxy(wallet, {
    get(target, prop) {
      if (prop === 'getChainInfo') return async () => ({ chainId: new Fr(reader.deployment.chainId), version: new Fr(reader.deployment.rollupVersion + 1n) });
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(connectAns(reader, { wallet: wrongNetworkWallet, account: alice, deployment }), (e: unknown) => (e as { code: string }).code === 'wrong_deployment');
  check('SDK rejects a wallet on another rollup before registering contracts', true);
  check('private fee read uses the real wallet account after checking its network', await getPrivateFeeBalance(holder, token.address) === PRICE * 20n);
  const game = new AnsContext(reader, { wallet, account: gamer, fee });
  await holder.ensureRegistered({ feeToken: { address: token.address, artifact: TokenContractArtifact } });
  await game.ensureRegistered();
  check('reader verifies deployment and immutable fees', (await reader.getConfig()).annualPrice === PRICE);
  const balance = async (a: AztecAddress) => BigInt((await token.methods.balance_of_private(a).simulate({ from: a })).result as bigint);
  const mature = async (plan: RegistrationPlan) => {
    for (let i = 0; i < 30; i++) {
      const state = (await checkRegistration(reader, plan)).state;
      if (state === 'ready_to_register') return;
      assert.equal(state, 'commit_wait');
      await contract.methods.commit(Fr.random()).send({ from: deployer, fee });
    }
    throw new Error('Commit did not mature after 30 blocks');
  };
  let plan = deserializePlan(serializePlan(await prepareRegistration(holder, { name: 'Alice', duration: YEAR })));
  const label = normalizeName('alice');
  const noirHash = (await contract.methods.register_commitment(alice, label.bytes, label.len, 0, YEAR, plan.maxFee, plan.quoteExpiry, plan.secret).simulate({ from: alice })).result;
  check('SDK commitment matches Noir', BigInt(noirHash as bigint) === plan.commitment);
  ({ plan } = await submitCommit(holder, plan));
  check('plan survives serialization with its commit hash', deserializePlan(serializePlan(plan)).commitTx === plan.commitTx);
  await mature(plan);
  const before = await balance(alice);
  await submitRegistration(holder, plan);
  check('paid registration charges owner and credits treasury exactly', before - await balance(alice) === PRICE && await balance(treasury) === PRICE);
  const held = await inspectHolding(holder, 'alice');
  check('public owner and automatic public label', held.isHolder && held.labelPublished && held.record.owner.equals(alice));
  check('registered name is unavailable', !(await getAvailability(reader, 'alice')).available);
  await assert.rejects(setAddress(new AnsContext(reader, { wallet: wrongNetworkWallet, account: alice, fee }), { name: 'alice', address: gamer }), (e: unknown) => (e as { code: string }).code === 'wrong_deployment');
  check('SDK rejects an existing context after its wallet switches rollup', true);
  check('public event discovery returns current owner names', (await listOwnedNames(reader, alice)).names.some(n => n.name === 'alice'));
  check('another account has no owned name', (await listOwnedNames(reader, gamer)).names.length === 0);
  check('new name starts without an address', (await resolveAddress(reader, 'alice')).status === 'unset');
  await assert.rejects(setAddress(game, { name: 'alice', address: gamer }), (e: unknown) => (e as {code:string}).code === 'not_holder');
  checks++; console.log(`PASS ${checks}: non-holder cannot edit`);
  await setAddress(holder, { name: 'alice', address: gamer }, { preflight: true });
  const forward = await resolveAddress(reader, 'alice');
  check('owner can bind a different game account', forward.status === 'resolved' && forward.address.equals(gamer));
  check('binding alone does not confirm primary', (await resolvePrimary(reader, gamer)).status === 'none');
  await setPrimary(game, { name: 'alice' });
  check('game account confirmation produces a verified name', (await resolvePrimary(reader, gamer)).status === 'verified');
  const batch = await resolvePrimaryMany(reader, [gamer, gamer, alice]);
  check('batch resolution deduplicates and preserves non-primary accounts', batch.size === 2 && batch.get(gamer.toString())?.status === 'verified' && batch.get(alice.toString())?.status === 'none');
  await setAddress(holder, { name: 'alice', address: alice });
  await setAddress(holder, { name: 'alice', address: gamer });
  const stale = await resolvePrimary(reader, gamer);
  check('A to B to A cannot reactivate old primary', stale.status === 'stale' && stale.reason === 'binding_version_changed');
  await setPrimary(game, { name: 'alice' });
  const oldExpiry = (await inspectHolding(holder, 'alice')).record.expiresAt;
  await renew(holder, { name: 'alice', duration: YEAR });
  check('renew extends lease and pays exact fee', (await inspectHolding(holder, 'alice')).record.expiresAt === oldExpiry + YEAR && await balance(treasury) === 2n * PRICE);
  await clearPrimary(game);
  check('account can clear primary', (await resolvePrimary(reader, gamer)).status === 'none');
  await clearAddress(holder, { name: 'alice' });
  check('holder can clear default record', (await resolveAddress(reader, 'alice')).status === 'unset');
  // A new wallet database can manage a public name without an encrypted label backup.
  recovered = await newWallet(node);
  await recovered.registerContract(fpc.instance, fpc.artifact);
  const restoredAddress = (await recovered.createSchnorrInitializerlessAccount(ownerKeys.secret, ownerKeys.salt, ownerKeys.signingKey)).address;
  const restored = new AnsContext(reader, { wallet: recovered, account: restoredAddress, fee });
  await restored.ensureRegistered();
  check('fresh wallet discovers names through public ownership', (await listOwnedNames(reader, restoredAddress)).names.some(n => n.name === 'alice'));
  await setAddress(restored, { name: 'alice', address: gamer });
  await setPrimary(game, { name: 'alice' });
  check('fresh wallet can manage existing name without name backups', (await resolvePrimary(reader, gamer)).status === 'verified');
  const { contract: free } = await NameRegistryContract.deploy(wallet, AztecAddress.ZERO, AztecAddress.ZERO, 0, 1).send({ from: deployer, fee });
  const freeReader = await RegistryReader.connect(node, free.address);
  check('free registry is available for local demos', (await freeReader.getConfig()).annualPrice === 0n);
  await writeFile('/tmp/ans-local-deployment.json', JSON.stringify({ nodeUrl: NODE_URL, paidRegistry: contract.address.toString(), registry: free.address.toString(), sponsoredFpc: fpc.instance.address.toString(), checks }, null, 2));
  console.log(`ALL ${checks} E2E CHECKS PASSED`);
} finally { await recovered?.stop(); await wallet.stop(); }
