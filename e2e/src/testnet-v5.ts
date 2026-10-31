/** Resumable V5 deployment and real-proof acceptance with immediate administrator configuration. Legacy test accounts stay in their private state directory. */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnsContext, RegistryReader, NameRegistryV5Contract, NameRegistrarContract, NameResolverContract,
  checkRegistration, deserializePlan, getAvailability, inspectHolding, listOwnedNames, migrateName,
  renew, configureModules, readFeeTokenMetadata, prepareRegistration, resolveAddress, resolveChainAddress, resolvePrimary, serializePlan,
  setAddress, setPrimary, setManager, setTextRecord, setChainAddress, issueSubname,
  offerTransfer, acceptTransfer, submitCommit, submitRegistration, trackTx, waitUntilRegistrable,
} from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { NO_WAIT } from '@aztec-labs/aztec.js/contracts';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec-labs/aztec.js/node';
import { TokenContract, TokenContractArtifact } from '@aztec-labs/noir-contracts.js/Token';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import deployment from '../../deployments/legacy/testnet-v4.json' with { type: 'json' };
import feeAsset from '../../deployments/testnet-payment.json' with { type: 'json' };
import { sponsoredFpc } from './common.js';
import { assertStateToolchain, assertTestnet } from './testnet-network.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { acceptanceChecks, runCheckpointedStep } from './testnet-checkpoint.js';

const url = process.env.TESTNET_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const rawNode = createAztecNodeClient(url), info = await rawNode.getNodeInfo();
assertTestnet(url, info);
assert.equal(feeAsset.network.nodeUrl, url);
assert.equal(feeAsset.network.chainId, String(info.l1ChainId));
assert.equal(feeAsset.network.rollupVersion, String(info.rollupVersion));
assert.equal(feeAsset.asset.official, false);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const privateDir = (path: string) => {
  const dir = resolve(path), rel = relative(repo, dir);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('../'), 'State must remain outside the repository');
  return dir;
};
const legacyDir = privateDir(process.env.TESTNET_LEGACY_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-v5.2.1'));
const dir = privateDir(process.env.TESTNET_V5_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-v5-5.2.1'));
assert.notEqual(dir, legacyDir, 'Keep V2 checkpoints intact');
await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
const unlock = acquireTestnetLock(join(dir, 'runner.lock')); process.once('exit', unlock);
const unlockLegacy = acquireTestnetLock(join(legacyDir, 'runner.lock')); process.once('exit', unlockLegacy);
const legacy = JSON.parse(await readFile(join(legacyDir, 'state.json'), 'utf8')) as {
  toolchainVersion: string; network: string; name: string;
  keys: { secret: string; salt: string; signingKey: string }[]; addresses: Record<string, string>;
};
assertStateToolchain(legacy);
assert.equal(legacy.network, info.l1ContractAddresses.rollupAddress.toString());
assert.equal(legacy.addresses.registry, '0x2a3792a422bd763d637d2ba19fdf079ccaabb66c97d0ee5fe96df99c72d07fd1');
const legacyReader = await RegistryReader.connect(rawNode, AztecAddress.fromStringUnsafe(deployment.registry));
const previousPolicy = await legacyReader.getConfig();
const paymentToken = AztecAddress.fromStringUnsafe(feeAsset.asset.token);
const tokenMetadata = await readFeeTokenMetadata(legacyReader, paymentToken);
assert.equal(tokenMetadata.symbol, 'mAZTEC'); assert.equal(tokenMetadata.decimals, 18);
const policy = { feeToken: paymentToken, treasury: AztecAddress.fromStringUnsafe(feeAsset.treasury), annualPrice: BigInt(feeAsset.annualPrice), priceVersion: feeAsset.priceVersion };
assert(policy.treasury.equals(previousPolicy.treasury));
assert.equal(policy.annualPrice, 10n ** 18n); assert.equal(policy.priceVersion, 2);
assert.equal(policy.treasury.toString(), legacy.addresses.treasury);
type State = {
  toolchainVersion: '5.2.1'; network: string; legacy: string; name: string; salts: string[];
  addresses: Record<string, string>; transactions: Record<string, string>; done: string[]; checks: string[];
  plan?: string; balanceBefore?: string[]; lastError?: string;
};
const statePath = join(dir, 'state.json');
let state: State;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  state = { toolchainVersion: '5.2.1', network: legacy.network, legacy: legacyReader.registry.toString(),
    name: `ans-v5-${Date.now().toString(36)}`, salts: Array.from({ length: 4 }, () => Fr.random().toString()),
    addresses: {}, transactions: {}, done: [], checks: [] };
}
assertStateToolchain(state); assert.equal(state.network, legacy.network); assert.equal(state.legacy, legacyReader.registry.toString());
const save = async () => {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
};
await save();
let activeStep = '';
const node = new Proxy(rawNode, {
  get(target, prop) {
    if (prop === 'sendTx') return async (tx: Tx) => {
      assert(activeStep && !state.transactions[activeStep], 'Refusing duplicate or uncheckpointed broadcast');
      state.transactions[activeStep] = tx.getTxHash().toString(); await save();
      console.log(`BROADCAST ${activeStep} ${state.transactions[activeStep]}`);
      return target.sendTx(tx);
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as AztecNode;
const txOptions = { timeoutMs: 30 * 60_000, pollMs: 5000, waitFor: 'confirmed' as const,
  onUpdate: (update: { state: string }) => console.log(`TX ${activeStep}: ${update.state}`) };
const assertions = acceptanceChecks(state.checks);
const transactionReadbacks: Record<string, Awaited<ReturnType<typeof trackTx>>> = {};
const check = (name: string, value: unknown) => {
  assertions.check(name, value); console.log(`PASS ${name}`);
};
const step = async (name: string, send: () => Promise<unknown>, verify: () => Promise<void> = async () => {}) => {
  activeStep = name; console.log(`STEP ${name}`);
  transactionReadbacks[name] = await runCheckpointedStep(state, name, send,
    hash => trackTx(node, hash, txOptions), verify, save);
  activeStep = '';
};
const wallets: EmbeddedWallet[] = [];
try {
  for (const role of ['owner', 'target', 'treasury']) wallets.push(await EmbeddedWallet.create(node, {
    pxe: { proverEnabled: true, dataDirectory: join(dir, 'wallets', role) },
  }));
  const fpc = await sponsoredFpc(), publishedFpc = await node.getContract(fpc.instance.address);
  assert(publishedFpc, 'Sponsored FPC missing');
  assert(publishedFpc.currentContractClassId.equals(fpc.instance.currentContractClassId), 'Sponsored FPC class mismatch');
  for (const wallet of wallets) await wallet.registerContract(publishedFpc, fpc.artifact);
  const accounts: Awaited<ReturnType<EmbeddedWallet['createSchnorrInitializerlessAccount']>>[] = [];
  for (const [i, key] of legacy.keys.entries()) accounts.push(await wallets[i].createSchnorrInitializerlessAccount(
    Fr.fromString(key.secret), Fr.fromString(key.salt), Fq.fromString(key.signingKey),
  ));
  for (const wallet of wallets) for (const account of accounts)
    await wallet.registerContract(account.getInstance(), await account.getAccountContract().getContractArtifact());
  const [ownerAddress, targetAddress, treasury] = accounts.map(a => a.address), wallet = wallets[0], fee = fpc.fee.fee;
  assert.equal(ownerAddress.toString(), legacy.addresses.owner); assert(treasury.equals(policy.treasury));
  check('each signing wallet holds exactly one test account', (await Promise.all(wallets.map(w => w.getAccounts()))).every(a => a.length === 1));
  const send = { from: ownerAddress, fee, wait: NO_WAIT };
  Object.assign(state.addresses, { owner: ownerAddress.toString(), target: targetAddress.toString(), treasury: treasury.toString(), token: policy.feeToken.toString(), sponsoredFpc: fpc.instance.address.toString() });
  const coreDeploy = NameRegistryV5Contract.deploy(wallet, legacyReader.registry, { salt: Fr.fromString(state.salts[0]), deployer: ownerAddress });
  const coreInstance = await coreDeploy.getInstance();
  const registrarDeploy = NameRegistrarContract.deploy(wallet, coreInstance.address, policy.feeToken, policy.treasury, policy.annualPrice, policy.priceVersion, { salt: Fr.fromString(state.salts[1]), deployer: ownerAddress });
  const registrarInstance = await registrarDeploy.getInstance();
  const initialRegistrarDeploy = NameRegistrarContract.deploy(wallet, coreInstance.address, previousPolicy.feeToken, previousPolicy.treasury, previousPolicy.annualPrice, previousPolicy.priceVersion, { salt: Fr.fromString(state.salts[3]), deployer: ownerAddress });
  const initialRegistrarInstance = await initialRegistrarDeploy.getInstance();
  const resolverDeploy = NameResolverContract.deploy(wallet, coreInstance.address, { salt: Fr.fromString(state.salts[2]), deployer: ownerAddress });
  const resolverInstance = await resolverDeploy.getInstance();
  for (const [key, instance] of [['registry', coreInstance], ['registrar', registrarInstance], ['resolver', resolverInstance], ['initialRegistrar', initialRegistrarInstance]] as const) {
    if (state.addresses[key]) assert.equal(state.addresses[key], instance.address.toString(), 'Artifact or constructor changed since checkpoint');
    state.addresses[key] = instance.address.toString();
  }
  await save();
  for (const [key, deploy, instance] of [['registry', coreDeploy, coreInstance], ['registrar', registrarDeploy, registrarInstance], ['resolver', resolverDeploy, resolverInstance], ['initialRegistrar', initialRegistrarDeploy, initialRegistrarInstance]] as const) {
    await step(`deploy-${key}`, () => deploy.send(send));
    check(`${key} class verified on public testnet`, (await node.getContract(instance.address))?.currentContractClassId.equals(instance.currentContractClassId));
  }
  for (const w of wallets) {
    await w.registerContract(coreInstance, NameRegistryV5Contract.artifact);
    await w.registerContract(registrarInstance, NameRegistrarContract.artifact);
    await w.registerContract(resolverInstance, NameResolverContract.artifact);
    const tokenInstance = await node.getContract(policy.feeToken); assert(tokenInstance);
    await w.registerContract(tokenInstance, TokenContractArtifact);
  }
  const core = NameRegistryV5Contract.at(coreInstance.address, wallet);
  await step('bootstrap', () => core.methods.bootstrap(initialRegistrarInstance.address, resolverInstance.address).send(send));
  const reader = await RegistryReader.connect(node, core.address);
  const owner = new AnsContext(reader, { wallet, account: ownerAddress, fee });
  const target = new AnsContext(reader, { wallet: wallets[1], account: targetAddress, fee });
  await owner.ensureRegistered({ feeToken: { address: policy.feeToken, artifact: TokenContractArtifact } }); await target.ensureRegistered();
  await step('configure-payment', () => configureModules(owner, {registrar: registrarInstance.address, resolver: resolverInstance.address}, txOptions), async () => {
    const active=await reader.getModules();
    check('administrator payment configuration is active immediately',active.registrar.equals(registrarInstance.address)&&active.revision===2);
  });
  check('administrator is the existing test owner',(await reader.getAdministrator())?.equals(ownerAddress));
  const current = await reader.getConfig(), legacyRegistry = await reader.getLegacyRegistry();
  check('V5 capabilities and configured mock fee policy active', reader.extended && current.feeToken.equals(policy.feeToken) && current.treasury.equals(policy.treasury) && current.annualPrice === policy.annualPrice && current.priceVersion === policy.priceVersion);
  check('legacy registry preserved', legacyRegistry?.equals(legacyReader.registry));
  await step('migrate-test-name', () => migrateName(owner, legacy.name, txOptions), async () => {
    const old = await getAvailability(legacyReader, legacy.name), moved = await inspectHolding(owner, legacy.name);
    check('test holder migration preserves owner and expiry', moved.isHolder && moved.record.expiresAt === old.record.expiresAt);
    check('test holder migration preserves forward address', (await resolveAddress(reader, legacy.name)).status === 'resolved');
    check('migration requires new reverse consent', (await resolvePrimary(reader, targetAddress)).status === 'none');
  });
  const balance = async (index: number) => BigInt((await TokenContract.at(policy.feeToken, wallets[index]).methods.balance_of_private(accounts[index].address).simulate({ from: accounts[index].address })).result as bigint);
  if (!state.balanceBefore) { state.balanceBefore = [String(await balance(0)), String(await balance(2))]; assert(BigInt(state.balanceBefore[0]) >= policy.annualPrice); await save(); }
  if (!state.plan) { state.plan = serializePlan(await prepareRegistration(owner, { name: state.name, duration: 31536000n })); await save(); }
  await step('commit', () => submitCommit(owner, deserializePlan(state.plan!), txOptions), async () => {
    const plan = { ...deserializePlan(state.plan!), commitTx: state.transactions.commit }; state.plan = serializePlan(plan);
    check('commit persisted', (await checkRegistration(reader, plan)).state !== 'commit_missing');
  });
  await step('register', async () => {
    const plan = deserializePlan(state.plan!); await waitUntilRegistrable(reader, plan, { pollMs: 5000, timeoutMs: 30 * 60_000 });
    return submitRegistration(owner, plan, txOptions);
  }, async () => {
    check('paid registration transfers the exact mock fee', await balance(0) === BigInt(state.balanceBefore![0]) - policy.annualPrice && await balance(2) === BigInt(state.balanceBefore![1]) + policy.annualPrice);
    check('registered name owned by test owner', (await inspectHolding(owner, state.name)).isHolder);
  });
  await step('renew', () => renew(owner, { name: state.name, duration: 31536000n }, txOptions), async () => {
    check('paid renewal transfers the exact mock fee', await balance(0) === BigInt(state.balanceBefore![0]) - policy.annualPrice * 2n && await balance(2) === BigInt(state.balanceBefore![1]) + policy.annualPrice * 2n);
  });
  await step('set-editor', () => setManager(owner, { name: state.name, manager: targetAddress }, txOptions));
  await step('editor-profile', () => setTextRecord(target, { name: state.name, key: 'description', value: 'ANS V5 public testnet · 测试' }, txOptions));
  await step('editor-chain-address', () => setChainAddress(target, { name: state.name, chain: 'eip155:1', address: '0x1234567890123456789012345678901234567890' }, txOptions), async () => {
    const h = await inspectHolding(owner, state.name);
    check('editor profile and multi-chain records read back', (await reader.getTextRecords(h.node, h.record.generation, h.snapshot)).description === 'ANS V5 public testnet · 测试' && await resolveChainAddress(reader, state.name, 'eip155:1') === '0x1234567890123456789012345678901234567890');
  });
  await step('issue-subname', async () => issueSubname(owner, { parent: state.name, label: 'team', owner: targetAddress, expiresAt: (await inspectHolding(owner, state.name)).record.expiresAt - 86400n }, txOptions), async () => check('subname ownership and discovery verified', (await inspectHolding(target, `team.${state.name}`)).isHolder && (await listOwnedNames(reader, targetAddress)).names.some(n => n.name === `team.${state.name}`)));
  await step('offer-transfer', () => offerTransfer(owner, { name: state.name, recipient: targetAddress }, txOptions));
  await step('accept-transfer', () => acceptTransfer(target, { name: state.name }, txOptions), async () => {
    const h = await inspectHolding(target, state.name);
    check('accepted transfer resets records and editor', h.isHolder && h.record.generation === 2 && Object.keys(await reader.getTextRecords(h.node, h.record.generation, h.snapshot)).length === 0 && (await reader.getManager(h.node, h.record.generation, h.snapshot)).isZero());
    check('parent transfer invalidates subname', (await resolveAddress(reader, `team.${state.name}`)).status === 'inactive');
    await assert.rejects(setAddress(owner, { name: state.name, address: ownerAddress }), (error: unknown) => (error as { code?: string }).code === 'not_holder'); check('previous owner cannot edit', true);
  });
  await step('set-address', () => setAddress(target, { name: state.name, address: targetAddress }, txOptions));
  await step('set-primary', () => setPrimary(target, { name: state.name }, txOptions));
  check('final forward and reverse verified', (await resolveAddress(reader, state.name)).status === 'resolved' && (await resolvePrimary(reader, targetAddress)).status === 'verified');
  check('legacy registry remains unchanged', (await getAvailability(legacyReader, legacy.name)).record.owner.equals(ownerAddress));
  delete state.lastError; await save();
  const report = { toolchainVersion: '5.2.1', nodeUrl: url, nodeVersion: info.nodeVersion, l1ChainId: info.l1ChainId, rollupVersion: info.rollupVersion, rollup: state.network, realProofs: true,
    configurationMode: "administrator", legacy: state.legacy, migratedTestName: legacy.name, name: state.name, addresses: state.addresses,
    registryClass: coreInstance.currentContractClassId.toString(), transactions: state.transactions,
    transactionReadbacks, receiptThreshold: txOptions.waitFor, ...assertions.report(), completedAt: new Date().toISOString() };
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`ALL ${assertions.report().checks.length} CURRENT V5 TESTNET CHECKS PASSED; ${state.checks.length} historical checks; ${Object.keys(transactionReadbacks).length} receipts rechecked at ${txOptions.waitFor} or later; ${join(dir, 'report.json')}`);
} catch (e) {
  state.lastError = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300); await save();
  console.error(`Stopped at ${activeStep || 'setup'}; checkpoint retained; no automatic resend`); throw e;
} finally { await Promise.allSettled(wallets.map(w => w.stop())); }
