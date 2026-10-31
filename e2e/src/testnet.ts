/** Real-proof acceptance on the pinned Sepolia Aztec testnet. Re-run with the same state directory to resume. */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnsContext, checkRegistration, clearAddress, clearPrimary, deserializePlan,
  inspectHolding, listOwnedNames, NameRegistryContract, prepareRegistration, RegistryReader,
  renew, resolveAddress, resolvePrimary, resolvePrimaryMany, serializePlan, setAddress,
  setPrimary, submitCommit, submitRegistration, trackTx, waitUntilRegistrable,
} from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { NO_WAIT } from '@aztec-labs/aztec.js/contracts';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec-labs/aztec.js/node';
import { TokenContract, TokenContractArtifact } from '@aztec-labs/noir-contracts.js/Token';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { randomKeys, sponsoredFpc } from './common.js';
import { assertStateToolchain, assertTestnet } from './testnet-network.js';
import { acquireTestnetLock } from './testnet-lock.js';

const url = process.env.TESTNET_NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const rawNode = createAztecNodeClient(url);
const info = await rawNode.getNodeInfo();
assertTestnet(url, info);
console.log(`TESTNET ${info.nodeVersion}; Sepolia; rollup ${info.rollupVersion}; REAL PROOFS`);

const dir = resolve(process.env.TESTNET_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-v5.2.1'));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const relativeState = relative(repoRoot, dir);
if (!isAbsolute(relativeState) && relativeState !== '..' && !relativeState.startsWith('../'))
  throw new Error('Keep testnet secrets outside the repository; choose an external TESTNET_STATE_DIR');
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const release = acquireTestnetLock(join(dir, 'runner.lock'));
process.once('exit', release);
const statePath = join(dir, 'state.json');
type State = {
  toolchainVersion: '5.2.1'; network: string; name: string; keys: { secret: string; salt: string; signingKey: string }[];
  salts: string[]; addresses: Record<string, string>; transactions: Record<string, string>;
  done: string[]; checks: string[]; plan?: string; oldExpiry?: string; lastError?: string;
};
let state: State;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  state = {
    toolchainVersion: '5.2.1', network: info.l1ContractAddresses.rollupAddress.toString(), name: `ans-${Date.now().toString(36)}`,
    keys: Array.from({ length: 3 }, () => { const k = randomKeys(); return { secret: k.secret.toString(), salt: k.salt.toString(), signingKey: k.signingKey.toString() }; }),
    salts: Array.from({ length: 3 }, () => Fr.random().toString()),
    addresses: {}, transactions: {}, done: [], checks: [],
  };
}
assertStateToolchain(state);
assert.equal(state.network, info.l1ContractAddresses.rollupAddress.toString(), 'saved state belongs to another network');
const save = async () => {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
};
await save(); // Fail before creating any transaction if secrets cannot be persisted.
let activeStep = '';
const node = new Proxy(rawNode, {
  get(target, prop) {
    if (prop === 'sendTx') return async (tx: Tx) => {
      assert.ok(activeStep, 'broadcast outside a test step');
      assert.ok(!state.transactions[activeStep], 'refusing a second broadcast for the same step');
      state.transactions[activeStep] = tx.getTxHash().toString();
      await save(); // Even a lost HTTP response leaves a recoverable hash.
      console.log(`BROADCAST ${activeStep} ${state.transactions[activeStep]}`);
      return target.sendTx(tx);
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as AztecNode;

const txOptions = { timeoutMs: 30 * 60_000, pollMs: 5000, waitFor: 'confirmed' as const,
  onUpdate: (update: { state: string; txHash?: string }) => console.log(`TX ${activeStep}: ${update.state}${update.txHash ? ` ${update.txHash}` : ''}`) };
const step = async (name: string, send: () => Promise<unknown>, verify: () => Promise<void> = async () => {}) => {
  if (state.done.includes(name)) return;
  activeStep = name;
  console.log(`STEP ${name}`);
  if (state.transactions[name]) await trackTx(node, state.transactions[name], txOptions);
  else await send();
  await verify();
  state.done.push(name);
  await save();
  activeStep = '';
};
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  if (!state.checks.includes(name)) state.checks.push(name);
  console.log(`PASS ${name}`);
};
const wallets: EmbeddedWallet[] = [];
try {
  for (const role of ['owner', 'target', 'treasury']) wallets.push(await EmbeddedWallet.create(node, {
    pxe: { proverEnabled: true, dataDirectory: join(dir, 'wallets', role) },
  }));
  const [wallet, targetWallet, treasuryWallet] = wallets;
  const fpc = await sponsoredFpc();
  const publishedFpc = await node.getContract(fpc.instance.address);
  assert.ok(publishedFpc, `no compatible sponsored FPC at ${fpc.instance.address}`);
  assert.ok(publishedFpc.currentContractClassId.equals(fpc.instance.currentContractClassId), 'FPC class mismatch');
  for (const w of wallets) await w.registerContract(publishedFpc, fpc.artifact);
  const fee = fpc.fee.fee;
  const accounts = [];
  for (const [i, k] of state.keys.entries()) accounts.push(await wallets[i].createSchnorrInitializerlessAccount(
    Fr.fromString(k.secret), Fr.fromString(k.salt), Fq.fromString(k.signingKey),
  ));
  // Share only public contract instances. Each PXE holds exactly one account's private keys.
  for (const w of wallets) for (const a of accounts)
    await w.registerContract(a.getInstance(), await a.getAccountContract().getContractArtifact());
  check('owner target and treasury use isolated signing wallets', (await Promise.all(wallets.map(w => w.getAccounts()))).every(a => a.length === 1));
  const [owner, target, treasury] = accounts.map(a => a.address);
  Object.assign(state.addresses, { owner: owner.toString(), target: target.toString(), treasury: treasury.toString(), sponsoredFpc: fpc.instance.address.toString() });
  await save();
  const sendOptions = { from: owner, fee, wait: { timeout: 1800, interval: 5 } };
  const price = 1_000_000n;
  const year = 31_536_000n;
  const tokenDeploy = TokenContract.deploy(wallet, owner, 'ANS Test Fee', 'ANSF', 6, { salt: Fr.fromString(state.salts[0]), deployer: owner });
  const tokenInstance = await tokenDeploy.getInstance();
  state.addresses.token = tokenInstance.address.toString();
  await save();
  await step('deploy-token', async () => {
    await tokenDeploy.send({ ...sendOptions, wait: NO_WAIT });
    await trackTx(node, state.transactions[activeStep], txOptions);
  }, async () => check('fee token deployed', !!await node.getContract(tokenInstance.address)));
  for (const w of wallets) await w.registerContract(tokenInstance, TokenContractArtifact);
  const token = TokenContract.at(tokenInstance.address, wallet);
  await step('mint-test-fees', () => token.methods.mint_to_private(owner, price * 20n).send(sendOptions));

  const registryDeploy = NameRegistryContract.deploy(wallet, token.address, treasury, price, 1, { salt: Fr.fromString(state.salts[1]), deployer: owner });
  const registryInstance = await registryDeploy.getInstance();
  state.addresses.registry = registryInstance.address.toString();
  await save();
  await step('deploy-registry', async () => {
    await registryDeploy.send({ ...sendOptions, wait: NO_WAIT });
    await trackTx(node, state.transactions[activeStep], txOptions);
  }, async () => check('registry deployed with real proof', !!await node.getContract(registryInstance.address)));
  const reader = await RegistryReader.connect(node, registryInstance.address);
  const holder = new AnsContext(reader, { wallet, account: owner, fee });
  const game = new AnsContext(reader, { wallet: targetWallet, account: target, fee });
  await holder.ensureRegistered({ feeToken: { address: token.address, artifact: TokenContractArtifact } });
  await game.ensureRegistered();
  check('registry class and immutable fee verified', (await reader.getConfig()).annualPrice === price);
  const balance = async (a: AztecAddress) => {
    const w = a.equals(treasury) ? treasuryWallet : wallet;
    return BigInt((await TokenContract.at(token.address, w).methods.balance_of_private(a).simulate({ from: a })).result as bigint);
  };
  if (!state.plan) {
    state.plan = serializePlan(await prepareRegistration(holder, { name: state.name, duration: year }));
    await save();
  }
  let plan = deserializePlan(state.plan);
  await step('commit', async () => { ({ plan } = await submitCommit(holder, plan, txOptions)); }, async () => {
    plan = { ...plan, commitTx: state.transactions.commit };
    state.plan = serializePlan(plan);
    check('commit persisted and checkpointed', (await checkRegistration(reader, plan)).state !== 'commit_missing');
  });
  plan = deserializePlan(state.plan);
  await step('register', async () => {
    await waitUntilRegistrable(reader, plan, { pollMs: 5000, timeoutMs: 30 * 60_000 });
    await submitRegistration(holder, plan, txOptions);
  }, async () => {
    check('exact registration fee debited and credited', await balance(owner) === price * 19n && await balance(treasury) === price);
    const held = await inspectHolding(holder, state.name);
    check('owner and public label verified', held.isHolder && held.labelPublished);
    check('ownership discovery includes registered name', (await listOwnedNames(reader, owner)).names.some(n => n.name === state.name));
    check('new registration has no default address', (await resolveAddress(reader, state.name)).status === 'unset');
    await assert.rejects(setAddress(game, { name: state.name, address: target }), (e: unknown) => (e as { code: string }).code === 'not_holder');
    check('non-owner edit rejected before broadcast', true);
  });
  await step('set-target', () => setAddress(holder, { name: state.name, address: target }, txOptions), async () => {
    const forward = await resolveAddress(reader, state.name);
    check('forward resolution points to separate account', forward.status === 'resolved' && forward.address.equals(target));
    check('binding does not automatically confirm primary', (await resolvePrimary(reader, target)).status === 'none');
  });
  await step('confirm-primary', () => setPrimary(game, { name: state.name }, txOptions), async () => {
    check('reverse resolution verified', (await resolvePrimary(reader, target)).status === 'verified');
    const batch = await resolvePrimaryMany(reader, [target, target, owner]);
    check('batch deduplicates and preserves missing primary', batch.size === 2 && batch.get(owner.toString())?.status === 'none');
  });
  await step('change-to-owner', () => setAddress(holder, { name: state.name, address: owner }, txOptions));
  await step('change-back-to-target', () => setAddress(holder, { name: state.name, address: target }, txOptions), async () => {
    const primary = await resolvePrimary(reader, target);
    check('old primary cannot revive after A-B-A', primary.status === 'stale' && primary.reason === 'binding_version_changed');
  });
  await step('reconfirm-primary', () => setPrimary(game, { name: state.name }, txOptions));
  if (!state.oldExpiry) { state.oldExpiry = (await inspectHolding(holder, state.name)).record.expiresAt.toString(); await save(); }
  await step('renew', () => renew(holder, { name: state.name, duration: year }, txOptions), async () => {
    check('renew extends by one year', (await inspectHolding(holder, state.name)).record.expiresAt === BigInt(state.oldExpiry!) + year);
    check('exact renewal fee debited and credited', await balance(owner) === price * 18n && await balance(treasury) === price * 2n);
  });
  await step('clear-primary', () => clearPrimary(game, txOptions), async () => check('primary cleared', (await resolvePrimary(reader, target)).status === 'none'));
  await step('clear-address', () => clearAddress(holder, { name: state.name }, txOptions), async () => check('default address cleared', (await resolveAddress(reader, state.name)).status === 'unset'));
  // Leave a useful public name for browser readback after the mutation/recovery checks.
  await step('restore-target', () => setAddress(holder, { name: state.name, address: target }, txOptions));
  await step('restore-primary', () => setPrimary(game, { name: state.name }, txOptions));
  check('final public forward and reverse state verified', (await resolveAddress(reader, state.name)).status === 'resolved' && (await resolvePrimary(reader, target)).status === 'verified');
  delete state.lastError;
  await save();
  const report = { toolchainVersion: '5.2.1', isolatedWallets: true, nodeUrl: url, nodeVersion: info.nodeVersion, l1ChainId: info.l1ChainId, rollupVersion: info.rollupVersion,
    rollup: state.network, realProofs: true, name: state.name, addresses: state.addresses,
    transactions: state.transactions, checks: state.checks, completedAt: new Date().toISOString() };
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`ALL ${state.checks.length} TESTNET CHECKS PASSED; public report: ${join(dir, 'report.json')}`);
} catch (e) {
  state.lastError = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);
  await save();
  console.error(`Stopped at ${activeStep || 'setup'}; state retained at ${statePath}; no automatic resend`);
  throw e;
} finally { await Promise.allSettled(wallets.map(w => w.stop())); }
