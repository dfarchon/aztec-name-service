/**
 * Resumable switch of the public V5 testnet registry to the length-tiered Registrar, with real proofs.
 * Phase 1 (default) only deploys the Registrar; it changes nothing users see. Release the site, then run with
 * ANS_TIERED_CONFIGURE=1 to activate it as administrator and verify an exact 4-character charge.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnsContext, RegistryReader, NameRegistrarTieredContract, checkRegistration, configureModules, deserializePlan,
  getAvailability, getFeeQuote, inspectHolding, prepareRegistration, readFeeTokenMetadata, serializePlan,
  submitCommit, submitRegistration, trackTx, waitUntilRegistrable,
} from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { NO_WAIT } from '@aztec-labs/aztec.js/contracts';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec-labs/aztec.js/node';
import { TokenContract, TokenContractArtifact } from '@aztec-labs/noir-contracts.js/Token';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import deployment from '../../deployments/testnet.json' with { type: 'json' };
import feeAsset from '../../deployments/testnet-payment.json' with { type: 'json' };
import { sponsoredFpc } from './common.js';
import { assertStateToolchain, assertTestnet } from './testnet-network.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { acceptanceChecks, runCheckpointedStep } from './testnet-checkpoint.js';

const UNIT = 10n ** 18n, YEAR = 31536000n;
// Test-asset tiers mirror deployments/aztec-pricing.json: 128 / 32 / 1 per year.
const prices = { three: 128n * UNIT, four: 32n * UNIT, base: UNIT, priceVersion: 3 };

const url = process.env.TESTNET_NODE_URL ?? deployment.nodeUrl;
const rawNode = createAztecNodeClient(url), info = await rawNode.getNodeInfo();
assertTestnet(url, info);
assert.equal(deployment.chainId, String(info.l1ChainId));
assert.equal(deployment.rollupVersion, String(info.rollupVersion));
assert.equal(feeAsset.asset.official, false);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const privateDir = (path: string) => {
  const dir = resolve(path), rel = relative(repo, dir);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('../'), 'State must remain outside the repository');
  return dir;
};
const keysDir = privateDir(process.env.TESTNET_LEGACY_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-v5.2.1'));
const dir = privateDir(process.env.TESTNET_TIERED_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-tiered-5.2.1'));
await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
const unlock = acquireTestnetLock(join(dir, 'runner.lock')); process.once('exit', unlock);
const keys = JSON.parse(await readFile(join(keysDir, 'state.json'), 'utf8')) as {
  toolchainVersion: string; network: string; keys: { secret: string; salt: string; signingKey: string }[]; addresses: Record<string, string>;
};
assertStateToolchain(keys);
assert.equal(keys.network, info.l1ContractAddresses.rollupAddress.toString());

const registryAddress = AztecAddress.fromStringUnsafe(deployment.registry);
const reader = await RegistryReader.connect(rawNode, registryAddress);
const before = await reader.getConfig(), modules = await reader.getModules();
const paymentToken = AztecAddress.fromStringUnsafe(feeAsset.asset.token);
const tokenMetadata = await readFeeTokenMetadata(reader, paymentToken);
assert.equal(tokenMetadata.symbol, 'mAZTEC'); assert.equal(tokenMetadata.decimals, 18);
assert(before.treasury.equals(AztecAddress.fromStringUnsafe(feeAsset.treasury)), 'Treasury differs from the payment manifest');

type State = {
  toolchainVersion: '5.2.1'; network: string; registry: string; salt: string; name: string;
  addresses: Record<string, string>; transactions: Record<string, string>; done: string[]; checks: string[];
  plan?: string; balanceBefore?: string[];
};
const statePath = join(dir, 'state.json');
let state: State;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  // 4 characters, so the acceptance registration exercises a non-base tier; base36 avoids "--" and "0x".
  const name = `t${Math.random().toString(36).slice(2, 5).padEnd(3, '0')}`;
  state = { toolchainVersion: '5.2.1', network: keys.network, registry: registryAddress.toString(), salt: Fr.random().toString(),
    name, addresses: {}, transactions: {}, done: [], checks: [] };
}
assertStateToolchain(state); assert.equal(state.network, keys.network); assert.equal(state.registry, registryAddress.toString());
assert.equal(state.name.length, 4);
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
const check = (name: string, value: unknown) => { assertions.check(name, value); console.log(`PASS ${name}`); };
const step = async (name: string, send: () => Promise<unknown>, verify: () => Promise<void> = async () => {}) => {
  activeStep = name; console.log(`STEP ${name}`);
  await runCheckpointedStep(state, name, send, hash => trackTx(node, hash, txOptions), verify, save);
  activeStep = '';
};

const wallets: EmbeddedWallet[] = [];
try {
  for (const role of ['owner', 'treasury']) wallets.push(await EmbeddedWallet.create(node, {
    pxe: { proverEnabled: true, dataDirectory: join(dir, 'wallets', role) },
  }));
  const fpc = await sponsoredFpc(), publishedFpc = await node.getContract(fpc.instance.address);
  assert(publishedFpc, 'Sponsored FPC missing');
  assert(publishedFpc.currentContractClassId.equals(fpc.instance.currentContractClassId), 'Sponsored FPC class mismatch');
  for (const wallet of wallets) await wallet.registerContract(publishedFpc, fpc.artifact);
  const accounts = [
    await wallets[0].createSchnorrInitializerlessAccount(Fr.fromString(keys.keys[0].secret), Fr.fromString(keys.keys[0].salt), Fq.fromString(keys.keys[0].signingKey)),
    await wallets[1].createSchnorrInitializerlessAccount(Fr.fromString(keys.keys[2].secret), Fr.fromString(keys.keys[2].salt), Fq.fromString(keys.keys[2].signingKey)),
  ];
  const [ownerAddress, treasury] = accounts.map(a => a.address), wallet = wallets[0], fee = fpc.fee.fee;
  assert((await reader.getAdministrator())?.equals(ownerAddress), 'Saved owner is not the registry administrator');
  assert(treasury.equals(before.treasury), 'Saved treasury account differs from the active treasury');

  const deploy = NameRegistrarTieredContract.deploy(wallet, registryAddress, paymentToken, treasury, prices.base, prices.three, prices.four, prices.priceVersion,
    { salt: Fr.fromString(state.salt), deployer: ownerAddress });
  const instance = await deploy.getInstance();
  if (state.addresses.registrar) assert.equal(state.addresses.registrar, instance.address.toString(), 'Artifact or constructor changed since checkpoint');
  Object.assign(state.addresses, { registrar: instance.address.toString(), previousRegistrar: state.addresses.previousRegistrar ?? modules.registrar.toString(), resolver: modules.resolver.toString() });
  await save();
  await step('deploy-tiered-registrar', () => deploy.send({ from: ownerAddress, fee, wait: NO_WAIT }));
  check('tiered registrar class verified on public testnet', (await node.getContract(instance.address))?.currentContractClassId.equals(instance.currentContractClassId));
  console.log(`TIERED REGISTRAR ${instance.address}`);
  if (process.env.ANS_TIERED_CONFIGURE !== '1') {
    console.log('Deployed only. Release the site, then rerun with ANS_TIERED_CONFIGURE=1 to activate it.');
    process.exit(0);
  }

  const owner = new AnsContext(reader, { wallet, account: ownerAddress, fee });
  await owner.ensureRegistered({ feeToken: { address: paymentToken, artifact: TokenContractArtifact } });
  await wallets[1].registerContract((await node.getContract(paymentToken))!, TokenContractArtifact);
  await step('configure-tiered', () => configureModules(owner, { registrar: instance.address, resolver: modules.resolver }, txOptions), async () => {
    check('tiered registrar active immediately', (await reader.getModules()).registrar.equals(instance.address));
  });
  const config = await reader.getConfig();
  check('length tiers read back from chain', config.lengthPrices?.three === prices.three && config.lengthPrices.four === prices.four && config.annualPrice === prices.base && config.priceVersion === prices.priceVersion);
  const quote = async (labelLength: number) => (await getFeeQuote(reader, { operation: 'register', duration: YEAR, labelLength })).fee;
  check('quotes follow 128 / 32 / 1 mAZTEC per year', await quote(3) === prices.three && await quote(4) === prices.four && await quote(5) === prices.base);
  await assert.rejects(prepareRegistration(owner, { name: '0xabcd', duration: YEAR }), (e: any) => e.code === 'invalid_name');
  await assert.rejects(prepareRegistration(owner, { name: 'xn--ab', duration: YEAR }), (e: any) => e.code === 'invalid_name');
  check('SDK refuses 0x prefixes and "--" before any wallet request', true);

  const balance = async (i: number) => BigInt((await TokenContract.at(paymentToken, wallets[i]).methods.balance_of_private(accounts[i].address).simulate({ from: accounts[i].address })).result as bigint);
  if (!state.plan) {
    assert(['unregistered', 'released'].includes((await getAvailability(reader, state.name)).status), `${state.name} is not available`);
    // The test owner deployed mAZTEC and is its minter; top up a valueless test balance for the paid check.
    if (state.transactions['fund-owner'] || await balance(0) < prices.four)
      await step('fund-owner', () => TokenContract.at(paymentToken, wallet).methods.mint_to_private(ownerAddress, prices.four * 2n).send({ from: ownerAddress, fee, wait: NO_WAIT }));
    state.balanceBefore = [String(await balance(0)), String(await balance(1))];
    assert(BigInt(state.balanceBefore[0]) >= prices.four, 'Owner needs at least 32 mAZTEC');
    state.plan = serializePlan(await prepareRegistration(owner, { name: state.name, duration: YEAR }));
    await save();
  }
  await step('commit', () => submitCommit(owner, deserializePlan(state.plan!), txOptions), async () => {
    const plan = { ...deserializePlan(state.plan!), commitTx: state.transactions.commit }; state.plan = serializePlan(plan);
    check('commit persisted', (await checkRegistration(reader, plan)).state !== 'commit_missing');
  });
  await step('register', async () => {
    const plan = deserializePlan(state.plan!); await waitUntilRegistrable(reader, plan, { pollMs: 5000, timeoutMs: 30 * 60_000 });
    return submitRegistration(owner, plan, txOptions);
  }, async () => {
    check('4-character registration charges exactly 32 mAZTEC', await balance(0) === BigInt(state.balanceBefore![0]) - prices.four && await balance(1) === BigInt(state.balanceBefore![1]) + prices.four);
    check('registered name owned by test owner', (await inspectHolding(owner, state.name)).isHolder);
  });
  const report = { toolchainVersion: '5.2.1', nodeUrl: url, l1ChainId: info.l1ChainId, rollupVersion: info.rollupVersion, realProofs: true,
    registry: state.registry, registrar: state.addresses.registrar, previousRegistrar: state.addresses.previousRegistrar, resolver: state.addresses.resolver,
    feeToken: paymentToken.toString(), treasury: treasury.toString(), lengthPrices: { three: String(prices.three), four: String(prices.four) },
    annualPrice: String(prices.base), priceVersion: prices.priceVersion, name: state.name, transactions: state.transactions,
    ...assertions.report(), completedAt: new Date().toISOString() };
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`ALL ${assertions.report().checks.length} TIERED TESTNET CHECKS PASSED; ${join(dir, 'report.json')}`);
} finally { await Promise.allSettled(wallets.map(w => w.stop())); }
