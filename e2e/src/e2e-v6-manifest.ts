/** Local-only acceptance against an existing deployment, never a replacement deployment. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { AnsContext, RegistryReader, checkRegistration, getAvailability, getFeeQuote, inspectHolding, prepareRegistration, submitCommit, submitRegistration, waitUntilRegistrable, setAddress, resolveAddress, renew } from '@ans/sdk';
import { NameRegistryV6Contract } from '../../sdk/src/artifacts/NameRegistryV6.js';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { Contract } from '@aztec-labs/aztec.js/contracts';
import { newWallet, randomKeys, sponsoredFpc } from './common.js';
import { V6_PROFILES, assertV6Network } from './v6-network.js';
import { assertPrivateDir, type Manifest } from './deploy-v6-plan.js';
import { physicalPath, v6Artifacts, type V6State } from './deploy-v6.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { readKeys } from './init-keys.js';
const { v6ManifestProblems } = createRequire(import.meta.url)('../../scripts/deployment-config.mjs');
const manifestPath = process.env.ANS_V6_MANIFEST, stateDir = process.env.ANS_V6_STATE_DIR;
assert(manifestPath && stateDir, 'ANS_V6_MANIFEST and ANS_V6_STATE_DIR are required');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
assert.deepEqual(v6ManifestProblems(manifest, { expectNetwork: 'local' }), []);
assert.equal(manifest.chainId, '31337');
const node = createAztecNodeClient(manifest.nodeUrl, { maxBatchSize: V6_PROFILES[manifest.network].maxBatchSize }), info = await node.getNodeInfo();
assert.deepEqual(assertV6Network('local', info, manifest.nodeUrl), { chainId: manifest.chainId, rollupVersion: manifest.rollupVersion, rollup: manifest.rollup });
const dir = await physicalPath(stateDir); assertPrivateDir(dir, 'local');
const unlock = acquireTestnetLock(join(dir, 'runner.lock'));
process.once('exit', unlock);
const wallet = await newWallet(node);
try {
  const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as V6State;
  assert.equal(state.network, 'local'); assert.equal(state.addresses.registry, manifest.registry);
  const fpc = await sponsoredFpc(); await wallet.registerContract(fpc.instance, fpc.artifact);
  const fee = fpc.fee.fee, k = state.keys.owner;
  const admin = (await wallet.createSchnorrInitializerlessAccount(Fr.fromString(k.secret), Fr.fromString(k.salt), Fq.fromString(k.signingKey))).address;
  assert.equal(admin.toString(), manifest.owner);
  const userKey = randomKeys(), user = (await wallet.createSchnorrInitializerlessAccount(userKey.secret, userKey.salt, userKey.signingKey)).address;
  const reader = await RegistryReader.connect(node, AztecAddress.fromStringUnsafe(manifest.registry));
  const { artifacts } = await v6Artifacts(manifest.feeTokenSource, manifest.registrarKind);
  const free=manifest.feeTokenSource==='none';
  const tokenAddress = AztecAddress.fromStringUnsafe(manifest.feeToken);
  const tokenInstance=free?undefined:await node.getContract(tokenAddress);
  if(!free) {assert(tokenInstance);await wallet.registerContract(tokenInstance,artifacts.token);}
  const token = free?undefined:await Contract.at(tokenAddress,artifacts.token,wallet);
  const treasury = AztecAddress.fromStringUnsafe(manifest.treasury);
  // The manifest and node have both passed local-network checks before private keys are read.
  if (!treasury.equals(admin)) {
    const keys = await readKeys(join(dir, 'keys.json'), 'local');
    assert(keys.owner.address === admin.toString() && keys.treasury.address === treasury.toString(), 'Rehearsal keys do not match manifest');
    const t = keys.treasury;
    const restored = (await wallet.createSchnorrInitializerlessAccount(Fr.fromString(t.secret), Fr.fromString(t.salt), Fq.fromString(t.signingKey))).address;
    assert(restored.equals(treasury), 'Rehearsal treasury account mismatch');
  }
  const ctx = new AnsContext(reader, { wallet, account: user, fee });
  await ctx.ensureRegistered(free?{}:{ feeToken: { address: tokenAddress, artifact: artifacts.token } });
  if(token) await token.methods.mint_to_private(user, BigInt(manifest.annualPrice) * 1000n).send({ from: admin, fee });
  const balance = async (a: AztecAddress) => token?BigInt((await token.methods.balance_of_private(a).simulate({ from: a })).result as bigint):0n;
  const check = (name: string, ok: unknown) => { assert(ok, name); console.log(`PASS ${name}`); };
  const year = 31536000n;
  const core = NameRegistryV6Contract.at(reader.registry, wallet);
  const register = async (name: string, expected: bigint) => {
    const before = await balance(user), received = await balance(treasury);
    const quote = await getFeeQuote(reader, { operation: 'register', duration: year, labelLength: name.length });
    check(`${name} quote`, quote.fee === expected);
    let plan = await prepareRegistration(ctx, { name, duration: year });
    ({ plan } = await submitCommit(ctx, plan));
    // The local chain produces blocks on demand. Advance chain time through
    // ordinary unrelated commits, as the existing local acceptance runner does.
    for (let i = 0; i < 30; i++) {
      const status = await checkRegistration(reader, plan);
      if (status.state === 'ready_to_register') break;
      assert.equal(status.state, 'commit_wait');
      await core.methods.commit(Fr.random()).send({ from: admin, fee });
    }
    await waitUntilRegistrable(reader, plan, { pollMs: 1000, timeoutMs: 180_000 });
    await submitRegistration(ctx, plan);
    check(`${name} exact registration debit and treasury credit`, before - await balance(user) === expected && await balance(treasury) - received === expected);
    check(`${name} owner`, (await getAvailability(reader, name)).record.owner.equals(user));
  };
  const name = `v6-${Date.now().toString(36)}`.padEnd(manifest.minPublicLength??3,'a');
  await register(name, BigInt(manifest.annualPrice));
  await setAddress(ctx, { name, address: user });
  const resolved = await resolveAddress(reader, name);
  check('resolver address record', resolved.status === 'resolved' && resolved.address.equals(user));
  const before = await balance(user), received = await balance(treasury), previous = (await getAvailability(reader, name)).record;
  const expiry = previous.expiresAt;
  if (manifest.registrarKind !== 'flat') {
    const holding = await inspectHolding(ctx, name);
    assert(holding.record.owner.equals(user));
    const quote = await getFeeQuote(reader, { operation: 'renew', duration: year, labelLength: holding.label.len, snapshot: holding.snapshot });
    assert.equal(quote.registrar?.toString(), manifest.registrar);
  }
  await renew(ctx, { name, duration: year });
  console.log(`PASS ${manifest.registrarKind} renewal through SDK renew`);
  check('renew exact debit and treasury credit', before - await balance(user) === BigInt(manifest.annualPrice) && await balance(treasury) - received === BigInt(manifest.annualPrice));
  const renewed = (await getAvailability(reader, name)).record;
  check('renew extends expiry', renewed.expiresAt === expiry + year);
  check('renew preserves generation and increments revision', renewed.generation === previous.generation && renewed.revision === previous.revision + 1);
  const three = await getFeeQuote(reader, { operation: 'register', duration: year, labelLength: 3 });
  check('three-character price', three.fee === BigInt(manifest.lengthPrices?.['3'] ?? manifest.annualPrice));
  if (manifest.registrarKind === 'tiered') {
    let short: string;
    do { short = `v${Math.random().toString(36).slice(2, 5).padEnd(3, '0')}`; } while (!(await getAvailability(reader, short)).available);
    await register(short, BigInt(manifest.lengthPrices!['4']));
  } else if(manifest.registrarKind==='flat') check('flat four-character price', (await getFeeQuote(reader, { operation: 'register', duration: year, labelLength: 4 })).fee === BigInt(manifest.annualPrice));
  console.log(`ALL ${manifest.registrarKind} MANIFEST E2E CHECKS PASSED`);
} finally { await wallet.stop(); unlock(); process.removeListener('exit', unlock); }
