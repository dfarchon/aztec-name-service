/** Real-proof acceptance of the public SDK flow against the configured deployment. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RegistryReader, connectAns, createRegistrationFlow, getFeeQuote, getPrivateFeeBalance,
  inspectHolding, registrationPlanKey, renew, resolveAddress, resolvePrimary,
  seal, setAddress, setPrimary, trackTx, unseal, waitUntilRegistrable,
  type RegistrationPlan, type RegistrationPlanStore, type Sealed,
} from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec-labs/aztec.js/node';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import deployment from '../../deployments/testnet.json' with { type: 'json' };
import sdkPackage from '../../sdk/package.json' with { type: 'json' };
import { acceptanceChecks, runCheckpointedStep } from './testnet-checkpoint.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { assertStateToolchain, assertTestnet } from './testnet-network.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
function privateDirectory(path: string) {
  const dir = resolve(path), rel = relative(repo, dir);
  assert(rel === '..' || rel.startsWith('../'), 'Private state must remain outside the repository');
  return dir;
}
const legacyDir = privateDirectory(process.env.TESTNET_LEGACY_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-v5.2.1'));
const walletDir = privateDirectory((deployment.protocol === 5 ? process.env.TESTNET_V5_STATE_DIR : process.env.TESTNET_V4_STATE_DIR) ?? join(homedir(), `.local/share/ans/testnet-v${deployment.protocol === 5 ? '5' : '4'}-5.2.1`));
const dir = privateDirectory(process.env.TESTNET_FLOW_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-registration-flow-5.2.1'));
assert.notEqual(dir, legacyDir); assert.notEqual(dir, walletDir);
await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
for (const path of new Set([dir, walletDir, legacyDir])) {
  const release = acquireTestnetLock(join(path, 'runner.lock')); process.once('exit', release);
}
const url = process.env.TESTNET_NODE_URL ?? deployment.nodeUrl;
const rawNode = createAztecNodeClient(url), info = await rawNode.getNodeInfo();
assertTestnet(url, info);
const legacy = JSON.parse(await readFile(join(legacyDir, 'state.json'), 'utf8')) as {
  toolchainVersion: string; network: string; addresses: Record<string, string>;
  keys: { secret: string; salt: string; signingKey: string }[];
};
assertStateToolchain(legacy);
assert.equal(legacy.network, info.l1ContractAddresses.rollupAddress.toString());
type State = {
  toolchainVersion: '5.2.1'; network: string; registry: string; name: string;
  transactions: Record<string, string>; done: string[]; checks: string[];
  plan?: Sealed; balances?: string[]; fee?: string; feeToken?: string;
  renewal?: { balances: string[]; fee: string; expiresAt: string };
};
const statePath = join(dir, 'state.json');
let state: State;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  state = { toolchainVersion: '5.2.1', network: legacy.network, registry: deployment.registry,
    name: `ans-flow-${Date.now().toString(36)}`, transactions: {}, done: [], checks: [] };
}
assertStateToolchain(state); assert.equal(state.network, legacy.network); assert.equal(state.registry, deployment.registry);
const completedAtStart = state.done.length === 5;
const save = async () => {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
};
await save();
const keyPath = join(dir, 'vault-key');
let vaultKey: string;
try { vaultKey = await readFile(keyPath, 'utf8'); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  assert(!state.plan, 'Cannot replace a missing key for an existing encrypted plan');
  vaultKey = randomBytes(32).toString('hex');
  await writeFile(keyPath, vaultKey, { mode: 0o600, flag: 'wx' });
}
await chmod(keyPath, 0o600);
let activeStep = '', broadcasts = 0;
const node = new Proxy(rawNode, {
  get(target, prop) {
    if (prop === 'sendTx') return async (tx: Tx) => {
      assert(activeStep && !state.transactions[activeStep], 'Refusing duplicate or uncheckpointed broadcast');
      state.transactions[activeStep] = tx.getTxHash().toString(); await save();
      broadcasts++;
      console.log(`BROADCAST ${activeStep} ${state.transactions[activeStep]}`);
      return target.sendTx(tx);
    };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as AztecNode;
const checks = acceptanceChecks(state.checks);
const check = (label: string, value: unknown) => { checks.check(label, value); console.log(`PASS ${label}`); };
const receipts: Record<string, Awaited<ReturnType<typeof trackTx>>> = {};
const options = { timeoutMs: 30 * 60_000, pollMs: 5000, waitFor: 'confirmed' as const,
  onUpdate: (u: { state: string }) => console.log(`TX ${activeStep}: ${u.state}`) };
const store: RegistrationPlanStore = {
  async load(key) {
    if (!state.plan) return undefined;
    const plan = await unseal<RegistrationPlan>(state.plan, vaultKey);
    assert.equal(registrationPlanKey(plan), key, 'Encrypted plan key mismatch');
    return plan;
  },
  async save(key, plan) {
    assert.equal(registrationPlanKey(plan), key);
    state.plan = await seal(plan, vaultKey); await save();
  },
};
async function loadPlan() {
  assert(state.plan, 'Registration plan missing');
  return unseal<RegistrationPlan>(state.plan, vaultKey);
}
const wallets: EmbeddedWallet[] = [];
const startedAt = Date.now();
try {
  for (const role of ['owner', 'treasury']) wallets.push(await EmbeddedWallet.create(node, {
    pxe: { proverEnabled: true, dataDirectory: join(walletDir, 'wallets', role) },
  }));
  const accounts = [];
  for (const [i, keyIndex] of [0, 2].entries()) {
    const key = legacy.keys[keyIndex];
    accounts.push(await wallets[i].createSchnorrInitializerlessAccount(Fr.fromString(key.secret), Fr.fromString(key.salt), Fq.fromString(key.signingKey)));
  }
  for (const wallet of wallets) for (const account of accounts)
    await wallet.registerContract(account.getInstance(), await account.getAccountContract().getContractArtifact());
  assert.equal(accounts[0].address.toString(), legacy.addresses.owner);
  assert.equal(accounts[1].address.toString(), legacy.addresses.treasury);
  const reader = await RegistryReader.connect(node, AztecAddress.fromStringUnsafe(deployment.registry));
  check('configured deployment verified without deployment transactions', reader.extended);
  const contexts: Awaited<ReturnType<typeof connectAns>>[] = [];
  for (const [i, wallet] of wallets.entries()) contexts.push(await connectAns(reader, {
    wallet, account: accounts[i].address, deployment,
    sponsoredFpc: AztecAddress.fromStringUnsafe(deployment.sponsoredFpc),
  }));
  const ctx = contexts[0];
  const flow = () => createRegistrationFlow(ctx, store);
  let plan: RegistrationPlan;
  if (state.plan) plan = await loadPlan();
  else {
    const quote = await flow().quote(31536000n);
    assert(quote.treasury.equals(accounts[1].address), 'Unexpected treasury; stop before payment');
    check('wallet has the exact quoted private payment token', (await flow().readiness(quote)).ready);
    state.feeToken = quote.feeToken.toString(); state.fee = quote.fee.toString();
    state.balances = await Promise.all(contexts.map(async c => String(await getPrivateFeeBalance(c, quote.feeToken))));
    await save();
    plan = await flow().prepare({ name: state.name, acceptedQuote: quote });
  }
  assert.equal(plan.feeToken, state.feeToken); assert.equal(String(plan.fee), state.fee);
  const storedText = await readFile(statePath, 'utf8');
  check('registration secret is encrypted before the first wallet send', !storedText.includes(plan.secret.toString()) && !!state.plan?.ct);
  const balances = async () => Promise.all(contexts.map(c => getPrivateFeeBalance(c, AztecAddress.fromStringUnsafe(plan.feeToken))));
  async function registrationStep(name: 'commit' | 'register', kind: 'commitTx' | 'registerTx') {
    activeStep = name; console.log(`STEP ${name}`);
    plan = await loadPlan();
    if (state.transactions[name]) {
      // The durable node journal repairs a wallet transport failure that returned no hash.
      plan = { ...plan, [kind]: state.transactions[name], broadcastUnknown: undefined };
      await store.save(registrationPlanKey(plan), plan);
    } else {
      if (name === 'register') await waitUntilRegistrable(reader, plan, { pollMs: 5000, timeoutMs: 30 * 60_000 });
      plan = await (name === 'commit' ? flow().commit(plan, options) : flow().finish(plan, options));
    }
    const beforeRecovery = broadcasts;
    const reloaded = await loadPlan();
    plan = await flow().recover(reloaded, kind, options);
    check(`${name} receipt recovers after encrypted reload without another broadcast`, broadcasts === beforeRecovery && plan[kind] === state.transactions[name]);
    receipts[name] = await trackTx(node, state.transactions[name], options);
    if (!state.done.includes(name)) state.done.push(name);
    await save(); activeStep = '';
  }
  await registrationStep('commit', 'commitTx');
  await registrationStep('register', 'registerTx');
  if (!state.renewal) {
    const currentBalances = await balances();
    check('registration debits payer and credits treasury by exactly the accepted fee', currentBalances[0] === BigInt(state.balances![0]) - plan.fee && currentBalances[1] === BigInt(state.balances![1]) + plan.fee);
    const holding = await inspectHolding(ctx, state.name);
    check('registered name belongs to the paying wallet in the next generation', holding.isHolder && holding.record.generation === plan.expectedGeneration + 1);
    check('registration consumes its commit', (await reader.getCommit(plan.commitment, await reader.snapshot())).consumed);
    const quote = await getFeeQuote(reader, { operation: 'renew', duration: 31536000n });
    assert.equal(quote.feeToken.toString(), plan.feeToken, 'Fee policy changed; review acceptance before renewal');
    state.renewal = { balances: currentBalances.map(String), fee: String(quote.fee), expiresAt: String(holding.record.expiresAt) }; await save();
  }
  async function step(name: string, send: () => Promise<unknown>, verify: () => Promise<void> = async () => {}) {
    activeStep = name; console.log(`STEP ${name}`);
    receipts[name] = await runCheckpointedStep(state, name, send, hash => trackTx(node, hash, options), verify, save);
    activeStep = '';
  }
  await step('renew', async () => {
    const quote = await getFeeQuote(reader, { operation: 'renew', duration: 31536000n });
    assert.equal(String(quote.fee), state.renewal!.fee); assert.equal(quote.feeToken.toString(), plan.feeToken);
    return renew(ctx, { name: state.name, duration: quote.duration, maxFee: quote.maxFee, acceptedQuote: quote }, options);
  }, async () => {
    const afterRenewal = await balances(), holding = await inspectHolding(ctx, state.name);
    check('renewal transfers exactly the accepted fee', afterRenewal[0] === BigInt(state.renewal!.balances[0]) - BigInt(state.renewal!.fee) && afterRenewal[1] === BigInt(state.renewal!.balances[1]) + BigInt(state.renewal!.fee));
    check('renewal extends the existing lease by exactly one year', holding.record.expiresAt === BigInt(state.renewal!.expiresAt) + 31536000n);
  });
  await step('set-address', () => setAddress(ctx, { name: state.name, address: ctx.account }, options));
  await step('set-primary', () => setPrimary(ctx, { name: state.name }, options));
  const [forward, primary] = await Promise.all([resolveAddress(reader, state.name), resolvePrimary(reader, ctx.account)]);
  check('current forward and primary resolution are verified', forward.status === 'resolved' && primary.status === 'verified');
  check('only one broadcast per checkpoint', Object.keys(state.transactions).length === 5 && broadcasts <= 5);
  if (completedAtStart) check('completed acceptance reruns without broadcasting', broadcasts === 0);
  await save();
  const report = { completedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt, sdkVersion: sdkPackage.version,
    network: state.network, registry: state.registry, name: state.name, realProofs: true,
    signingTransport: 'EmbeddedWallet', scope: 'public SDK flow; not browser extension acceptance',
    transactions: state.transactions, receipts, receiptThreshold: options.waitFor,
    broadcastsThisRun: broadcasts, encryptedReload: true, feeToken: plan.feeToken,
    registrationFee: String(plan.fee), renewalFee: state.renewal.fee, ...checks.report() };
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`ALL ${checks.report().checks.length} CURRENT FLOW CHECKS PASSED; public report: ${join(dir, 'report.json')}`);
} catch (error) {
  console.error(`Stopped at ${activeStep || 'setup'}; encrypted plan and hashes retained; no automatic resend`);
  throw error;
} finally { await Promise.allSettled(wallets.map(w => w.stop())); }
