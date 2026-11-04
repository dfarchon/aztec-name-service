/** Real-proof, self-paid registration on an isolated deployment. Never uses a fee-paying contract. */
import assert from 'node:assert/strict';
import { lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchnorrAccountContractAddress } from '@aztec-labs/accounts/schnorr';
import {
  AnsContext, RegistryReader, checkRegistration, deserializePlan, getAvailability,
  getFeeQuote, prepareRegistration, resolveAddress, serializePlan, setAddress,
  submitCommit, submitRegistration, trackTx, waitUntilRegistrable,
} from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { NO_FROM } from '@aztec-labs/aztec.js/account';
import { Contract, NO_WAIT } from '@aztec-labs/aztec.js/contracts';
import { FeeJuicePaymentMethodWithClaim } from '@aztec-labs/aztec.js/fee';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import { createAztecNodeClient, type AztecNode } from '@aztec-labs/aztec.js/node';
import { TxHash } from '@aztec-labs/aztec.js/tx';
import { setLogLevel } from '@aztec-labs/foundation/log';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { randomKeys } from './common.js';
import { v6Artifacts } from './deploy-v6.js';
import { readBridgeClaim, readFeeJuiceBalance, type BridgeClaim } from './fee-juice-payment.js';
import { readKeys } from './init-keys.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { runCheckpointedStep } from './testnet-checkpoint.js';
import { COMMIT_OPTIONS, TX_OPTIONS, manifestBinding, privateDirectory, type AccountKeys } from './testnet-v6-e2e-state.js';
import { V6_PROFILES, assertV6FeeJuice, assertV6Network, dryRunNode } from './v6-network.js';
import {
  assertRegisterConfirmation, captureRegisterBroadcast, loadRehearsalManifest, parseRegisterArgs,
  readRegisterJson, recheckRegisterTransactions, recordRegisterReceipt, registerConfirmation,
  registerPaths, saveRegisterState, validateRegisterState, type RegisterOptions, type RegisterState,
  type RegisterStep, type PublicReceipt,
} from './testnet-v6-nofpc-state.js';

type UserKeys = { schema: 'ans-v6-nofpc-user/1'; network: 'testnet-v6'; toolchainVersion: '6.0.0'; user: AccountKeys };
export function userDeploymentOptions(user: AztecAddress, claim: BridgeClaim, classPublished: boolean) {
  assert(claim.complete && claim.recipient === user.toString() && claim.network === 'testnet-v6' &&
    claim.messageHash && claim.leafIndex !== undefined, 'Complete user bridge claim required for deployment');
  return { from: NO_FROM, fee: { paymentMethod: new FeeJuicePaymentMethodWithClaim(user, {
    claimAmount: BigInt(claim.amount), claimSecret: Fr.fromString(claim.claimSecret), messageLeafIndex: BigInt(claim.leafIndex),
  }) }, skipInstancePublication: false, skipClassPublication: classPublished, wait: NO_WAIT };
}
export async function initUser(c: RegisterOptions) {
  await privateDirectory(c.stateDir);
  const unlock = acquireTestnetLock(join(c.stateDir, 'runner.lock'));
  try {
    for (const name of ['user-keys.json', 'register-state.json', 'wallet']) {
      try { await lstat(join(c.stateDir, name)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      throw new Error('User keys or registration state already exists; refusing overwrite');
    }
    const k = randomKeys();
    const address = (await getSchnorrAccountContractAddress(k.signingKey, k.salt, k.secret)).toString();
    const keys: UserKeys = { schema: 'ans-v6-nofpc-user/1', network: 'testnet-v6', toolchainVersion: '6.0.0',
      user: { address, secret: k.secret.toString(), salt: k.salt.toString(), signingKey: k.signingKey.toString() } };
    const file = await open(join(c.stateDir, 'user-keys.json'), 'wx', 0o600);
    try { await file.chmod(0o600); await file.writeFile(JSON.stringify(keys) + '\n'); await file.sync(); }
    finally { await file.close(); }
    console.log(address);
  } finally { unlock(); }
}
async function loadUser(dir: string) {
  const k = await readRegisterJson<UserKeys>(join(dir, 'user-keys.json'));
  assert(k?.schema === 'ans-v6-nofpc-user/1' && k.network === 'testnet-v6' && k.toolchainVersion === '6.0.0', 'User keys required; run --init-user first');
  const a = k.user;
  assert.equal((await getSchnorrAccountContractAddress(Fq.fromString(a.signingKey), Fr.fromString(a.salt), Fr.fromString(a.secret))).toString(), a.address, 'User key address mismatch');
  return a;
}

export async function main(argv = process.argv.slice(2), deps = { createNode: createAztecNodeClient }) {
  const c = await registerPaths(parseRegisterArgs(argv));
  const manifest = await loadRehearsalManifest(c.manifest);
  assertRegisterConfirmation(c, manifest); // Before network, wallet, or private file loading.
  process.env.LOG_LEVEL = 'silent';
  setLogLevel('silent');
  if (c.initUser) { await initUser(c); return; }
  const previousMask = process.umask(0o077);
  let wallet: EmbeddedWallet | undefined;
  let funderWallet: EmbeddedWallet | undefined;
  const releases: (() => void)[] = [];
  try {
    const rawNode = deps.createNode(c.nodeUrl, { maxBatchSize: V6_PROFILES['testnet-v6'].maxBatchSize });
    const used = new Set<string>();
    const preflightNode = c.dryRun ? dryRunNode(rawNode, used) : rawNode;
    const identity = async () => {
      const info = await preflightNode.getNodeInfo();
      const id = assertV6Network('testnet-v6', info, c.nodeUrl);
      assertV6FeeJuice('testnet-v6', info);
      return id;
    };
    const network = await identity();
    for (const key of ['registry', 'registrar', 'resolver', 'token'] as const) {
      const address = key === 'token' ? manifest.feeToken : manifest[key];
      const found = await preflightNode.getContract(AztecAddress.fromStringUnsafe(address));
      assert.equal(found?.currentContractClassId.toString(), manifest.classIds[key], 'Rehearsal contract class mismatch');
    }
    if (c.dryRun) {
      const annual = c.name!.length === 3 ? manifest.lengthPrices?.['3'] : c.name!.length === 4 ? manifest.lengthPrices?.['4'] : undefined;
      console.log(JSON.stringify({ network, registry: manifest.registry, name: c.name, durationSeconds: '31536000',
        feePayment: 'fee-juice', feeToken: manifest.feeToken, registrationFee: annual ?? manifest.annualPrice,
        mintPayer: manifest.owner, mintRequires: '--funder-state-dir if the user private token balance is insufficient',
        steps: ['deploy-user (bridge claim)', 'mint (if needed)', 'commit', 'register', 'set-address (if needed)'],
        nodeMethods: [...used] }, null, 2));
      console.log(`CONFIRM ${registerConfirmation(c, manifest)}`);
      return;
    }
    await privateDirectory(c.stateDir);
    for (const dir of [...new Set([c.stateDir, ...(c.funderStateDir ? [c.funderStateDir] : [])])].sort()) {
      const release = acquireTestnetLock(join(dir, 'runner.lock'));
      releases.push(release); process.once('exit', release);
    }
    const keys = await loadUser(c.stateDir), user = AztecAddress.fromStringUnsafe(keys.address);
    let state = await readRegisterJson<RegisterState>(join(c.stateDir, 'register-state.json'));
    const balance = () => readFeeJuiceBalance(rawNode, user).then(String);
    if (!state) state = { schema: 'ans-v6-nofpc-register/1', binding: manifestBinding(manifest),
      confirmation: registerConfirmation(c, manifest), user: keys.address, name: c.name!, identity: network,
      transactions: {}, records: {}, done: [], feeJuice: { before: await balance() } };
    const s = state;
    validateRegisterState(s, manifest, c, keys.address, network);
    const save = () => saveRegisterState(c.stateDir, s);
    await save();
    const recordReceipt = async (step: RegisterStep, receipt: PublicReceipt) => {
      recordRegisterReceipt(s, step, receipt, await balance());
      await save();
    };
    // Every recorded status is checked before restoring a wallet. No saved hash is ever cleared.
    await recheckRegisterTransactions(s, hash => rawNode.getTxReceipt(TxHash.fromString(hash)), recordReceipt);
    let active: RegisterStep | undefined;
    const node = new Proxy(rawNode, { get(target, prop) {
      if (prop === 'sendTx') return async (tx: Tx) => {
        await captureRegisterBroadcast(s, active, tx.getTxHash().toString(), active === 'mint' ? manifest.owner : s.user,
          await balance(), identity, save, () => target.sendTx(tx));
      };
      if (prop === 'getTxReceipt') return async (hash: TxHash) => {
        const receipt = await target.getTxReceipt(hash);
        const step = Object.keys(s.transactions).find(k => s.transactions[k] === hash.toString()) as RegisterStep | undefined;
        if (step) await recordReceipt(step, receipt);
        return receipt;
      };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } }) as AztecNode;
    wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: true, dataDirectory: join(c.stateDir, 'wallet') } });
    const reader = await RegistryReader.connect(node, AztecAddress.fromStringUnsafe(manifest.registry));
    const { artifacts, classIds } = await v6Artifacts(manifest.feeTokenSource, manifest.registrarKind);
    assert.deepEqual(classIds, manifest.classIds, 'Manifest artifacts mismatch');
    // The repository fixture token has the same mint/transfer interface, but a distinct frozen class.
    // Scope its registration to this manifest without expanding the SDK consumer token boundary.
    const ctx = new class extends AnsContext {
      override async registerFeeToken(address: AztecAddress) {
        await this.assertWalletNetwork();
        assert.equal(address.toString(), manifest.feeToken, 'Unexpected fee asset');
        const instance = await node.getContract(address);
        assert.equal(instance?.currentContractClassId.toString(), manifest.feeTokenClassId, 'Fee token class mismatch');
        await this.wallet.registerContract(instance!, artifacts.token);
      }
    }(reader, { wallet, account: user, beforeSend: async account => {
      await identity();
      assert((await readFeeJuiceBalance(node, account)) > 0n, 'User Fee Juice balance is empty');
    } }); // Omitted signer.fee means the account pays its own Fee Juice.
    const queued = <T>(fn: () => T | Promise<T>) => ctx.queue.run(async () => {
      await identity(); await ctx.assertWalletNetwork(); return fn();
    });
    const account = await queued(() => wallet!.createSchnorrAccount(Fr.fromString(keys.secret), Fr.fromString(keys.salt), Fq.fromString(keys.signingKey)));
    assert.equal(account.address.toString(), s.user, 'Restored user mismatch');
    await queued(() => ctx.ensureRegistered({ feeToken: { address: AztecAddress.fromStringUnsafe(manifest.feeToken), artifact: artifacts.token } }));
    // Discover incoming mint notes using the funder's public address, without importing its keys.
    await queued(() => wallet!.registerSender(AztecAddress.fromStringUnsafe(manifest.owner), 'rehearsal-funder'));
    const config = await reader.getConfig();
    assert(config.feeToken.toString() === manifest.feeToken && config.registrar?.toString() === manifest.registrar &&
      config.treasury.toString() === manifest.treasury && config.annualPrice === BigInt(manifest.annualPrice) &&
      config.priceVersion === manifest.priceVersion, 'Manifest fee policy mismatch');
    assert.deepEqual(config.lengthPrices, manifest.lengthPrices ? { three: BigInt(manifest.lengthPrices['3']), four: BigInt(manifest.lengthPrices['4']) } : undefined, 'Manifest tier policy mismatch');
    const token = await queued(() => Contract.at(AztecAddress.fromStringUnsafe(manifest.feeToken), artifacts.token, wallet!));
    const tokenBalance = () => queued(async () => BigInt(String((await token.methods.balance_of_private(user).simulate({ from: user })).result)));
    const step = async (name: RegisterStep, send: () => Promise<unknown>, verify: () => Promise<void>) => {
      active = name;
      await save();
      try {
        await runCheckpointedStep(s, name, send, hash => trackTx(node, hash, TX_OPTIONS), verify, save);
      } catch {
        // A callback/transport failure may follow acceptance. Preserve actual receipt evidence if available.
        if (s.transactions[name]) {
          try { await recordReceipt(name, await rawNode.getTxReceipt(TxHash.fromString(s.transactions[name]))); }
          catch { /* Keep the existing hash and last recorded receipt. */ }
        }
        throw new Error(`Registration stopped at ${name}; checkpoint retained; no automatic resend`);
      } finally { active = undefined; }
    };
    await step('deploy-user', () => queued(async () => {
      const claim = await readBridgeClaim(c.stateDir, 'testnet-v6', s.user);
      assert(claim?.messageHash && claim.leafIndex !== undefined, 'Complete user bridge claim required for deployment');
      assert(await isL1ToL2MessageReady(node, Fr.fromString(claim.messageHash), 'proven'), 'User bridge claim is not ready at proven tip');
      const deploy = await account.getDeployMethod();
      return deploy.send(userDeploymentOptions(user, claim, !!await node.getContractClass(account.getInstance().currentContractClassId)));
    }), async () => {
      assert(await node.getContract(user), 'User account publication missing');
      assert(BigInt(await balance()) > 0n, 'User has no Fee Juice after claim');
    });
    const quote = await getFeeQuote(reader, { operation: 'register', duration: 31536000n, labelLength: s.name.length });
    if (s.transactions.mint || (!s.transactions.commit && await tokenBalance() < quote.fee)) {
      await step('mint', async () => {
        assert(c.funderStateDir, 'Insufficient private mAZTEC; supply --funder-state-dir for owner mint');
        const before = await tokenBalance();
        const amount = quote.fee - before;
        assert(amount > 0n, 'Token funding changed; inspect checkpoint');
        // Never persist deployer keys in the user's wallet store.
        funderWallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: true } });
        const funderCtx = new AnsContext(reader, { wallet: funderWallet, account: AztecAddress.fromStringUnsafe(manifest.owner) });
        return funderCtx.queue.run(async () => {
          await identity(); await funderCtx.assertWalletNetwork();
          const ownerKeys = (await readKeys(join(c.funderStateDir!, 'keys.json'), 'testnet-v6')).owner;
          assert.equal(ownerKeys.address, manifest.owner, 'Funder is not manifest owner');
          const owner = (await funderWallet!.createSchnorrInitializerlessAccount(Fr.fromString(ownerKeys.secret), Fr.fromString(ownerKeys.salt), Fq.fromString(ownerKeys.signingKey))).address;
          assert.equal(owner.toString(), manifest.owner, 'Restored funder mismatch');
          assert((await readFeeJuiceBalance(node, owner)) > 0n, 'Funder Fee Juice is empty');
          // The minting wallet only needs the recipient's public instance to deliver its note.
          await funderWallet!.registerContract(account.getInstance(), await account.getAccountContract().getContractArtifact());
          const tokenAddress = AztecAddress.fromStringUnsafe(manifest.feeToken);
          const tokenInstance = await node.getContract(tokenAddress);
          assert.equal(tokenInstance?.currentContractClassId.toString(), manifest.feeTokenClassId, 'Fee token class mismatch');
          await funderWallet!.registerContract(tokenInstance!, artifacts.token);
          const funderToken = Contract.at(tokenAddress, artifacts.token, funderWallet!);
          assert((await funderToken.methods.is_minter(owner).simulate({ from: owner })).result, 'Manifest owner is not a token minter');
          s.funding = { before: String(before), amount: String(amount) }; await save();
          return funderToken.methods.mint_to_private(user, amount).send({ from: owner, wait: NO_WAIT });
        });
      }, async () => {
        assert(s.funding && await tokenBalance() === BigInt(s.funding.before) + BigInt(s.funding.amount), 'Mint balance mismatch');
      });
    }
    if (!s.plan) {
      assert(!s.transactions.commit, 'Commit exists without plan');
      assert(await tokenBalance() >= quote.fee, 'User registration token balance insufficient');
      s.plan = serializePlan(await prepareRegistration(ctx, { name: s.name, duration: 31536000n, acceptedQuote: quote }));
      await save();
    }
    const plan = () => {
      const p = deserializePlan(s.plan!);
      assert(p.account === s.user && p.label === s.name && p.registry === manifest.registry &&
        p.feeToken === manifest.feeToken && p.registrar === manifest.registrar, 'Saved registration plan mismatch');
      return p;
    };
    await step('commit', async () => {
      assert.equal((await checkRegistration(reader, plan())).state, 'commit_missing', 'Commit exists without checkpoint');
      return submitCommit(ctx, plan(), TX_OPTIONS);
    }, async () => {
      s.plan = serializePlan({ ...plan(), commitTx: s.transactions.commit });
      assert(['commit_wait', 'ready_to_register'].includes((await checkRegistration(reader, plan())).state), 'Commit effect missing');
    });
    await step('register', async () => {
      assert.equal((await waitUntilRegistrable(reader, plan(), COMMIT_OPTIONS)).state, 'ready_to_register', 'Registration already exists without checkpoint');
      return submitRegistration(ctx, plan(), TX_OPTIONS);
    }, async () => {
      s.plan = serializePlan({ ...plan(), registerTx: s.transactions.register });
      assert((await getAvailability(reader, s.name)).record.owner.equals(user), 'Registered owner mismatch');
    });
    const resolved = () => resolveAddress(reader, s.name);
    const initialResolution = await resolved();
    if (s.transactions['set-address'] || initialResolution.status !== 'resolved' || !initialResolution.address.equals(user)) {
      await step('set-address', () => setAddress(ctx, { name: s.name, address: user }, TX_OPTIONS), async () => {
        const r = await resolved(); assert(r.status === 'resolved' && r.address.equals(user), 'Resolution mismatch');
      });
    }
    const result = await resolved();
    assert(result.status === 'resolved' && result.address.equals(user), 'Final resolution mismatch');
    assert((await getAvailability(reader, s.name)).record.owner.equals(user), 'Final name owner mismatch');
    assert(s.done.every(k => s.records[k as RegisterStep]?.blockNumber !== null &&
      s.records[k as RegisterStep]?.transactionFee != null), 'Confirmed transaction is missing its actual block or fee');
    s.resolved = user.toString(); s.feeJuice.after = await balance(); await save();
    console.log(`PASS ${s.name} resolves to ${s.user}; report=${join(c.stateDir, 'register-report.json')}`);
  } finally {
    try { await funderWallet?.stop(); }
    finally {
      try { await wallet?.stop(); }
      finally {
        for (const release of releases.reverse()) { release(); process.removeListener('exit', release); }
        process.umask(previousMask);
      }
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never serialize arbitrary wallet/RPC errors or private checkpoint contents.
    console.error('V6 self-paid registration stopped. Check arguments, dry-run confirmation and private checkpoint; saved hashes are never resent.');
    process.exitCode = 1;
  });
}
