import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { NO_FROM } from '@aztec-labs/aztec.js/account';
import { NO_WAIT } from '@aztec-labs/aztec.js/contracts';
import { FeeJuicePaymentMethodWithClaim } from '@aztec-labs/aztec.js/fee';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { TxStatus } from '@aztec-labs/aztec.js/tx';
import canonical from '../../deployments/testnet-v6.json' with { type: 'json' };
// The rehearsal is paid (mAZTEC), so its fixture starts from the archived paid deployment, not the free current one.
import paid from '../../deployments/legacy/testnet-v6-tiered.json' with { type: 'json' };
import { REPO, type Manifest } from './deploy-v6-plan.js';
import { FEE_JUICE, type BridgeClaim } from './fee-juice-payment.js';
import { V6_PROFILES } from './v6-network.js';
import { runCheckpointedStep } from './testnet-checkpoint.js';
import { manifestBinding } from './testnet-v6-e2e-state.js';
import { createRegistrationNode, main, userDeploymentOptions } from './testnet-v6-nofpc-register.js';
import { logRegistrationFailure, RegistrationFailure } from './testnet-v6-nofpc-errors.js';
import {
  assertRegisterConfirmation, captureRegisterBroadcast, loadRehearsalManifest, parseRegisterArgs,
  readRegisterJson, recheckRegisterTransactions, recordRegisterReceipt, registerConfirmation,
  registerPaths, registerReport, saveRegisterState, validateRegisterState,
  type PublicReceipt, type RegisterOptions, type RegisterState,
} from './testnet-v6-nofpc-state.js';

const address = (n: number) => new AztecAddress(new Fr(n)).toString();
const hash = `0x${'1'.repeat(64)}`;
const m: Manifest = { ...paid, feePayment: 'fee-juice', sponsoredFpc: null,
  network: 'testnet-v6',
  registry: address(100), resolver: address(101), registrar: address(102), feeToken: address(103),
  owner: address(105),
  feeTokenSource: 'official', registrarKind: 'tiered' };
const profile = V6_PROFILES['testnet-v6'];
const info = { nodeVersion: '6.0.0', l1ChainId: 11155111, rollupVersion: 679261766, realProofs: true,
  l1ContractAddresses: { rollupAddress: profile.rollup, feeJuicePortalAddress: profile.feeJuicePortal,
    feeAssetHandlerAddress: profile.feeAssetHandler } };
const identity = { chainId: m.chainId, rollupVersion: m.rollupVersion, rollup: m.rollup };
const base = ['--manifest', '/tmp/ans-fixture-deployer/manifest.json', '--state-dir', '/tmp/ans-fixture-user', '--name', 'rehearsal'];
const options = () => parseRegisterArgs([...base, '--dry-run']);
const initialState = (c = options()): RegisterState => ({ schema: 'ans-v6-nofpc-register/1', binding: manifestBinding(m),
  confirmation: registerConfirmation(c, m), identity, user: address(104), name: 'rehearsal',
  transactions: {}, records: {}, done: [], feeJuice: { before: '0' } });
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'ans-nofpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deployer = join(root, 'deployer'), stateDir = join(root, 'user'), manifest = join(deployer, 'manifest.json');
  await mkdir(deployer, { mode: 0o700 });
  await writeFile(manifest, JSON.stringify(m));
  const args = ['--manifest', manifest, '--state-dir', stateDir, '--name', 'rehearsal'];
  return { root, deployer, stateDir, manifest, args };
}
function fakeNode(calls: string[], patch = {}) {
  return new Proxy({}, { get(_target, method) {
    return async (a: AztecAddress) => {
      calls.push(String(method));
      if (method === 'getNodeInfo') return { ...info, ...patch };
      if (method === 'getContract') {
        const key = (['registry', 'resolver', 'registrar', 'token'] as const).find(k => (k === 'token' ? m.feeToken : m[k]) === a.toString());
        assert(key, 'Unexpected contract, including any fee-paying contract');
        return { currentContractClassId: m.classIds[key] };
      }
      throw new Error('Unexpected write, wallet or private read');
    };
  } }) as AztecNode;
}
test('self-paid args require manifest, state, valid label and confirmation; reject every FPC flag', () => {
  const c = options();
  assert.equal(c.nodeUrl, profile.nodeUrl);
  assert.equal(c.dryRun, true);
  assert.throws(() => parseRegisterArgs(base), /Exact --confirm/);
  assert.throws(() => parseRegisterArgs([]), /manifest/);
  assert.throws(() => parseRegisterArgs(base.slice(0, 4)), /name/);
  for (const name of ['UPPER', 'ab', 'foo.bar', '0xabc', 'a--bc', '-abc', 'a'.repeat(32)])
    assert.throws(() => parseRegisterArgs([...base.slice(0, 4), '--name', name, '--dry-run']));
  for (const extra of [['--fpc', address(3)], ['--fee-payment', 'sponsored'], ['--sponsored-fpc', address(3)], ['--dry-run', '--dry-run'], ['--node-url']])
    assert.throws(() => parseRegisterArgs([...base, ...extra]));
  assert.throws(() => parseRegisterArgs([...base, '--node-url', 'https://user:password@example.com', '--dry-run']));
});
test('canonical and all repository paths are refused, including physical symlinks', async t => {
  for (const manifest of [relative(process.cwd(), join(REPO, 'deployments/testnet-v6.json')), join(REPO, 'deployments/other.json'),
    join(REPO, 'scripts/fixtures/v6-manifest-local-rehearsal.json'), join(REPO, 'elsewhere.json')])
    assert.throws(() => parseRegisterArgs(['--manifest', manifest, ...base.slice(2), '--dry-run']), /deployments/);
  const f = await fixture(t);
  await symlink(join(REPO, 'deployments/testnet-v6.json'), join(f.deployer, 'link.json'));
  await assert.rejects(registerPaths({ ...options(), manifest: join(f.deployer, 'link.json'), stateDir: f.stateDir }), /deployments/);
  await assert.rejects(loadRehearsalManifest(join(f.deployer, 'link.json')), /repository/);
  const repoLink = join(f.deployer, 'repo-link.json');
  await symlink(join(REPO, 'scripts/fixtures/v6-manifest-local-rehearsal.json'), repoLink);
  await assert.rejects(registerPaths({ ...options(), manifest: repoLink, stateDir: f.stateDir }), /repository/);
  await assert.rejects(loadRehearsalManifest(repoLink), /repository/);
  await writeFile(f.manifest, JSON.stringify({ ...m, registry: canonical.registry }));
  await assert.rejects(loadRehearsalManifest(f.manifest), /Canonical deployment/);
  await writeFile(f.manifest, JSON.stringify({ ...m, feePayment: undefined, sponsoredFpc: canonical.sponsoredFpc }));
  await assert.rejects(loadRehearsalManifest(f.manifest), /no FPC/);
});
test('each canonical address, including owner, is refused by value despite mixed case', async t => {
  const f = await fixture(t);
  for (const known of [canonical, paid]) for (const field of ['registry', 'registrar', 'resolver', 'feeToken', 'owner'] as const) {
    if (BigInt(known[field]) === 0n) continue; // the free deployment has no token
    for (const value of [known[field], `0x${known[field].slice(2).toUpperCase()}`]) {
      await writeFile(f.manifest, JSON.stringify({ ...m, [field]: value }));
      await assert.rejects(loadRehearsalManifest(f.manifest), /Canonical deployment/);
    }
  }
  await writeFile(f.manifest, JSON.stringify(m));
  assert.deepEqual(await loadRehearsalManifest(f.manifest), m);
});
test('user directories cannot overlap deployment/funder state, contain deployer files or be loose', async t => {
  const f = await fixture(t), c = parseRegisterArgs([...f.args, '--dry-run']);
  await assert.rejects(registerPaths({ ...c, stateDir: f.deployer }), /independent/);
  await assert.rejects(registerPaths({ ...c, stateDir: f.root }), /independent/);
  await assert.rejects(registerPaths({ ...c, funderStateDir: f.stateDir }), /independent/);
  await mkdir(f.stateDir, { mode: 0o700 });
  await chmod(f.stateDir, 0o755);
  await assert.rejects(registerPaths(c), /0700/);
  await chmod(f.stateDir, 0o700);
  // Empty marker only: the path check must not parse deployment keys.
  await writeFile(join(f.stateDir, 'keys.json'), 'not JSON');
  await assert.rejects(registerPaths(c), /deployer files/);
});
test('confirmation binds manifest contents, name, user state, funder and endpoint', () => {
  const c = options(), confirm = registerConfirmation(c, m);
  assertRegisterConfirmation({ ...c, dryRun: false, confirm }, m);
  for (const change of [{ name: 'different' }, { stateDir: '/tmp/other-user' }, { manifest: '/tmp/other-manifest' },
    { funderStateDir: '/tmp/owner-state' }, { nodeUrl: 'https://other.invalid' }])
    assert.throws(() => assertRegisterConfirmation({ ...c, ...change, dryRun: false, confirm }, m), /Exact --confirm/);
  assert.throws(() => assertRegisterConfirmation({ ...c, dryRun: false, confirm }, { ...m, annualPrice: '2' }), /Exact --confirm/);
});
test('dry-run uses only public node reads, creates no user state and prints exact confirmation', async t => {
  const f = await fixture(t), calls: string[] = [], output: string[] = [], original = console.log;
  console.log = (...values) => output.push(values.join(' '));
  try { await main([...f.args, '--dry-run'], { createNode: () => fakeNode(calls) }); }
  finally { console.log = original; }
  assert.deepEqual(calls, ['getNodeInfo', 'getContract', 'getContract', 'getContract', 'getContract']);
  assert.deepEqual(await readdir(f.root), ['deployer']);
  const c = await registerPaths(parseRegisterArgs([...f.args, '--dry-run']));
  assert.equal(output.at(-1), `CONFIRM ${registerConfirmation(c, m)}`);
  assert.match(output.join('\n'), /"feePayment": "fee-juice"/);
  assert.doesNotMatch(output.join('\n'), /claimSecret|signingKey|Sponsored/);
});
test('missing/wrong confirmation fails before node creation or private files; identity drift fails on reads', async t => {
  const f = await fixture(t);
  let created = 0;
  const deps = { createNode: () => { created++; throw new Error('must not create node'); } };
  await assert.rejects(main(f.args, deps), /Exact --confirm/);
  await assert.rejects(main([...f.args, '--confirm', 'wrong'], deps), /Exact --confirm/);
  assert.equal(created, 0);
  for (const patch of [{ l1ChainId: 1 }, { rollupVersion: 1 }, { realProofs: false }]) {
    const calls: string[] = [];
    await assert.rejects(main([...f.args, '--dry-run'], { createNode: () => fakeNode(calls, patch) }), /identity mismatch/i);
    assert.deepEqual(calls, ['getNodeInfo']);
  }
});
test('top-level and STEP-REASON logging never echo raw parsing, wallet or RPC errors', () => {
  const secret = 'deadbeef'.repeat(8), output: string[] = [], original = console.error;
  let parsingError: unknown;
  try { Fq.fromString(secret); } catch (error) { parsingError = error; }
  assert(parsingError);
  const hostile = { get name() { throw new Error('name must never be read'); },
    get message() { throw new Error('message must never be read'); },
    toString() { throw new Error('must never stringify'); } };
  console.error = (...values) => output.push(values.join(' '));
  try {
    for (const error of [parsingError, new Error(`wallet ${secret}`), new TypeError(`RPC ${secret}`),
      Object.assign(new Error(secret), { name: secret, code: secret }), secret, hostile, null]) {
      logRegistrationFailure(error);
      logRegistrationFailure(error, 'deploy-user');
    }
    for (const reason of ['CLAIM_NOT_READY', 'BALANCE_EMPTY', 'CONFIRM_MISMATCH', 'IDENTITY_MISMATCH', 'RPC_ERROR'] as const) {
      logRegistrationFailure(new RegistrationFailure(reason, { cause: new Error(secret) }), 'commit');
      assert.equal(output.at(-1), `STEP-REASON commit Error ${reason}`);
    }
  } finally { console.error = original; }
  for (const line of output) {
    assert.match(line, /^(REASON|STEP-REASON (deploy-user|commit)) (AssertionError|SyntaxError|TypeError|RangeError|Error) (UNKNOWN|CLAIM_NOT_READY|BALANCE_EMPTY|CONFIRM_MISMATCH|IDENTITY_MISMATCH|RPC_ERROR)$/);
    assert(!line.includes(secret));
  }
});
test('actual node transport issues one aztec_sendTx after lost response or HTTP failure and retains checkpoint', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const failure of ['lost-response', 'http-503'] as const) {
    const calls: string[] = [], s = initialState();
    const node = createRegistrationNode('http://mock.invalid');
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      for (const request of Array.isArray(body) ? body : [body]) calls.push(request.method);
      assert.equal(s.transactions['deploy-user'], hash);
      if (failure === 'lost-response') throw new Error('synthetic lost response');
      return new Response(JSON.stringify({ error: { message: 'synthetic unavailable' } }), { status: 503 });
    };
    await assert.rejects(captureRegisterBroadcast(s, 'deploy-user', hash, s.user, '0', async () => {}, async () => {},
      () => node.sendTx({ synthetic: true } as never)), /RPC request failed/);
    assert.deepEqual(calls, ['aztec_sendTx']);
    assert.equal(s.transactions['deploy-user'], hash);
    await assert.rejects(captureRegisterBroadcast(s, 'deploy-user', hash, s.user, '0', async () => {}, async () => {},
      () => node.sendTx({ synthetic: true } as never)), /duplicate/);
    await runCheckpointedStep(s, 'deploy-user', () => node.sendTx({ synthetic: true } as never), async () => {}, async () => {}, async () => {});
    assert.deepEqual(calls, ['aztec_sendTx']);
  }
});
test('offline init prints only public Schnorr address, writes 0600 keys and refuses overwrite', async t => {
  const f = await fixture(t);
  const args = ['--import', 'tsx', new URL('./testnet-v6-nofpc-register.ts', import.meta.url).pathname,
    ...f.args.slice(0, 4), '--init-user'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^0x[0-9a-f]{64}\n$/);
  assert.equal(result.stderr, '');
  assert.equal((await stat(f.stateDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.stateDir, 'user-keys.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.stateDir), ['user-keys.json']);
  const twice = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(twice.status, 1); assert.equal(twice.stdout, '');
  assert.doesNotMatch(twice.stderr, /secret|signingKey|0x[0-9a-f]{64}/);
});
test('account self deployment claims Fee Juice at protocol address 3, never a fee-paying contract', async () => {
  const user = AztecAddress.fromStringUnsafe(address(104));
  const claim: BridgeClaim = { network: 'testnet-v6', recipient: user.toString(), amount: '1000',
    claimSecret: new Fr(8).toString(), claimSecretHash: new Fr(9).toString(),
    messageHash: new Fr(10).toString(), leafIndex: '11', complete: true };
  const opts = userDeploymentOptions(user, claim, true);
  assert.equal(opts.from, NO_FROM);
  assert.equal(opts.wait, NO_WAIT);
  assert.equal(opts.skipInstancePublication, false);
  assert(opts.fee.paymentMethod instanceof FeeJuicePaymentMethodWithClaim);
  assert((await opts.fee.paymentMethod.getAsset()).equals(FEE_JUICE));
  assert((await opts.fee.paymentMethod.getFeePayer()).equals(user));
  const payload = await opts.fee.paymentMethod.getExecutionPayload();
  assert.equal(payload.calls.length, 1);
  assert(payload.calls[0].to.equals(FEE_JUICE));
  assert.throws(() => userDeploymentOptions(user, { ...claim, recipient: address(105) }, true), /bridge claim/);
  assert.throws(() => userDeploymentOptions(user, { ...claim, complete: false }, true), /bridge claim/);
  const source = await readFile(new URL('./testnet-v6-nofpc-register.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sponsoredFpc\(|SponsoredFeePaymentMethod|SponsoredFPC/);
  assert.match(source, /mint_to_private\(user, amount\)\.send\(\{ from: owner, wait: NO_WAIT \}\)/);
  assert.match(source, /funderWallet = await EmbeddedWallet\.create\(node, \{ ephemeral: true/);
  assert.doesNotMatch(source, /wallet!\.createSchnorrInitializerlessAccount/);
  assert.match(source, /registerSender\(AztecAddress.fromStringUnsafe\(manifest.owner\)/);
});
test('hash and public pending report are durable before send; ambiguous transport cannot resend', async t => {
  const f = await fixture(t); await mkdir(f.stateDir, { mode: 0o700 });
  const s = initialState(), save = () => saveRegisterState(f.stateDir, s);
  let sends = 0;
  await assert.rejects(captureRegisterBroadcast(s, 'deploy-user', hash, s.user, '0', async () => {}, save, async () => {
    const disk = await readRegisterJson<RegisterState>(join(f.stateDir, 'register-state.json'));
    assert.equal(disk?.transactions['deploy-user'], hash);
    const report = await readRegisterJson<ReturnType<typeof registerReport>>(join(f.stateDir, 'register-report.json'));
    assert.equal(report?.transactions['deploy-user'].txHash, hash);
    sends++; throw new Error('transport lost after send');
  }), /transport lost/);
  await assert.rejects(captureRegisterBroadcast(s, 'deploy-user', hash, s.user, '0', async () => {}, save, async () => { sends++; }), /duplicate/);
  await runCheckpointedStep(s, 'deploy-user', async () => { sends++; }, async saved => {
    assert.equal(saved, hash); return 'mined';
  }, async () => {}, save);
  assert.equal(sends, 1);
  assert.equal((await stat(join(f.stateDir, 'register-report.json'))).mode & 0o777, 0o600);
});
test('pending/mined resume checks hashes first; dropped/reverted never clears hashes; actual receipt fee is recorded', async () => {
  const s = initialState();
  await captureRegisterBroadcast(s, 'deploy-user', hash, s.user, '0', async () => {}, async () => {}, async () => {});
  for (const status of [TxStatus.PENDING, TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.DROPPED]) {
    const receipt: PublicReceipt = { status, blockNumber: status === TxStatus.PENDING || status === TxStatus.DROPPED ? undefined : 123,
      transactionFee: status === TxStatus.PENDING || status === TxStatus.DROPPED ? undefined : 77n, hasExecutionReverted: () => false };
    const calls: string[] = [];
    const run = recheckRegisterTransactions(s, async saved => { calls.push(saved); return receipt; }, async (step, r) => { recordRegisterReceipt(s, step, r, '923'); });
    if (status === TxStatus.DROPPED) await assert.rejects(run, /no resend/); else await run;
    assert.deepEqual(calls, [hash]); assert.equal(s.transactions['deploy-user'], hash);
    if (status === TxStatus.CHECKPOINTED) {
      assert.equal(registerReport(s).transactions['deploy-user'].transactionFee, '77');
      assert.equal(s.records['deploy-user']!.blockNumber, 123);
      recordRegisterReceipt(s, 'deploy-user', receipt, '800');
      assert.equal(s.records['deploy-user']!.userFeeJuiceAfter, '923');
      assert.equal(s.feeJuice.after, '800');
    }
  }
  await assert.rejects(recheckRegisterTransactions(s, async () => ({ status: TxStatus.CHECKPOINTED, blockNumber: 123,
    transactionFee: 33n, hasExecutionReverted: () => true }), async (step, r) => recordRegisterReceipt(s, step, r, '890')), /no resend/);
  assert.equal(registerReport(s).transactions['deploy-user'].transactionFee, '33');
  assert.equal(s.records['deploy-user']!.status, 'reverted');
  assert.equal(s.transactions['deploy-user'], hash);
});
test('public report excludes private recovery plans and validates checkpoint binding/order', () => {
  const c = options(), s = initialState(c);
  s.plan = 'sensitive registration plan';
  validateRegisterState(s, m, c, s.user, identity);
  assert.doesNotMatch(JSON.stringify(registerReport(s)), /sensitive|plan|secret|signingKey/);
  assert.throws(() => validateRegisterState(s, m, { ...c, name: 'other' }, s.user, identity), /binding/);
  s.transactions.register = hash;
  s.records.register = { txHash: hash, payer: s.user, status: 'pending', blockNumber: null, transactionFee: null, userFeeJuiceBefore: '1' };
  assert.throws(() => validateRegisterState(s, m, c, s.user, identity), /order/);
});
