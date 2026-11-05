/** Standalone, checkpointed Aztec 6 deployment. No legacy runner is imported. */
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { getSchnorrInitializerlessAccountContractAddress } from '@aztec-labs/accounts/schnorr';
import { RegistryReader, NameRegistrarLaunchContract, NameRegistrarContract, NameRegistrarTieredContract, NameResolverContract, readFeeTokenMetadata, trackTx } from '@ans/sdk';
import { NameRegistryV7Contract } from '../../sdk/src/artifacts/NameRegistryV7.js';
import { NameRegistryV6Contract } from '../../sdk/src/artifacts/NameRegistryV6.js';
import baseline from '../../sdk/test/fixtures/classids-6.0.0.json' with { type: 'json' };
import metadata from '../../web/src/public-metadata.json' with { type: 'json' };
import { loadContractArtifact, type ContractArtifact } from '@aztec-labs/aztec.js/abi';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Contract, NO_WAIT, getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec-labs/aztec.js/node';
import { TokenContractArtifact } from '@aztec-labs/noir-contracts.js/Token';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { FeeJuicePaymentMethodWithClaim, type FeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import { readBridgeClaim, readFeeJuiceBalance, selectFeeJuice } from './fee-juice-payment.js';
import { randomKeys, sponsoredFpc } from './common.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { acceptanceChecks, runCheckpointedStep } from './testnet-checkpoint.js';
import { V6_PROFILES, assertV6Fpc, assertV6FeeJuice, assertV6Network, dryRunNode } from './v6-network.js';
import { REPO, ZERO, DEPLOY_STEPS, deploymentSteps, deploymentTransactionSteps, assertPrivateDir, buildManifest, configHash, deploymentPlan, makePolicy, parseOptions, finalizeConfig, parseInitKeysArgs, within, type Config, type Policy } from './deploy-v6-plan.js';
import { loadReservedList, reservedNodes, reservedBatches, verifyReservations } from './launch-policy.js';
import { initKeys, readKeys, readPublicKeys, type KeysFile, type PublicKeys } from './init-keys.js';
const { assertMainnetReady, mainnetBlockers } = createRequire(import.meta.url)('../../scripts/mainnet-readiness.mjs');
const { v6ManifestProblems } = createRequire(import.meta.url)('../../scripts/deployment-config.mjs');
export type V6State = {
  schema: string; toolchainVersion: string; network: Config['network']; identity: { chainId: string; rollupVersion: string; rollup: string };
  config: Policy; configHash: string; keys: { owner: { secret: string; salt: string; signingKey: string } };
  salts: Record<string, string>; addresses: Record<string, string>; transactions: Record<string, string>; done: string[]; checks: string[];
  feePayment?: Config['feePayment']; feeClaim?: { usedBy: string }; manifestPath: string; deployedAt?: string; lastError?: string;
};
/** Resolve existing ancestors as well as a not-yet-created leaf to prevent symlink escapes. */
export async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return join(await physicalPath(dirname(path)), path.slice(dirname(path).length + 1)); }
}
export async function privatePaths(c: Config) {
  const state = await physicalPath(c.stateDir), out = await physicalPath(c.manifestOut);
  assertPrivateDir(state, c.network, undefined, undefined, c.feePayment);
  assert(!within(state, REPO), 'State must not contain repository');
  if (c.network !== 'testnet-v6' || c.feePayment === 'fee-juice') assert(!within(join(REPO, 'deployments'), out), 'Local manifest cannot enter deployments');
  assert(![join(state, 'state.json'), join(state, 'runner.lock'), join(state, 'keys.json'), join(state, 'keys.json.tmp'), join(state, 'bridge.json'), join(state, 'l1-key.json')].includes(out), 'Manifest cannot overwrite state');
  return { state, out };
}
export async function atomicJson(path: string, value: unknown, mode = 0o600) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode });
  await chmod(`${path}.tmp`, mode); await rename(`${path}.tmp`, path);
}
export async function v6Artifacts(token: Config['token'], registrar: Config['registrar'], registryVersion: 6 | 7 = 6) {
  const tokenArtifact = token !== 'repo' ? TokenContractArtifact : loadContractArtifact(JSON.parse(await readFile(join(REPO, 'contracts/target/test_token-Token.json'), 'utf8')));
  const artifacts = { token: tokenArtifact, registry: registryVersion === 7 ? NameRegistryV7Contract.artifact : NameRegistryV6Contract.artifact, resolver: NameResolverContract.artifact, registrar: registrar === 'launch' ? NameRegistrarLaunchContract.artifact : registrar === 'flat' ? NameRegistrarContract.artifact : NameRegistrarTieredContract.artifact };
  const expected = { token: token !== 'repo' ? metadata.tokenClassId : baseline.classIds.testToken, registry: registryVersion === 7 ? baseline.classIds.v7 : baseline.classIds.v6, resolver: baseline.classIds.resolver, registrar: registrar === 'launch' ? baseline.classIds.registrarLaunch : registrar === 'flat' ? baseline.classIds.registrar : baseline.classIds.registrarTiered };
  const classIds: Record<string, string> = {};
  for (const key of Object.keys(artifacts) as (keyof typeof artifacts)[]) {
    classIds[key] = (await getContractClassFromArtifact(artifacts[key])).id.toString();
    assert.equal(classIds[key], expected[key], `Frozen ${key} class ID mismatch`);
  }
  if(token==='none') classIds.token=ZERO;
  return { artifacts, classIds };
}
export async function instances(artifacts: Record<string, ContractArtifact>, p: Policy, owner: AztecAddress, salts: Record<string, string>) {
  const make = (key: string, args: unknown[]) => getContractInstanceFromInstantiationParams(artifacts[key], { constructorArgs: args, salt: Fr.fromString(salts[key]), deployer: owner });
  const tokenInstance = await make('token', [owner, p.tokenName, p.tokenSymbol, p.decimals]);
  const token = p.token==='none' ? {...tokenInstance,address:AztecAddress.ZERO} : tokenInstance;
  const registry = await make('registry', [AztecAddress.ZERO]);
  const resolver = await make('resolver', [registry.address]);
  const args = [registry.address, token.address, AztecAddress.fromStringUnsafe(p.treasury), BigInt(p.annualPrice), ...(p.lengthPrices ? [BigInt(p.lengthPrices['3']), BigInt(p.lengthPrices['4'])] : []), p.priceVersion, ...(p.registrar==='launch'?[p.minPublicLength,p.initialPaused,BigInt(p.maxRenewAhead??'0')]:[])];
  const registrar = await make('registrar', args);
  return { values: { token, registry, resolver, registrar }, args: { token: [owner, p.tokenName, p.tokenSymbol, p.decimals], registry: [AztecAddress.ZERO], resolver: [registry.address], registrar: args } };
}
/** Only this public projection can enter deterministic dry-run address construction. */
export async function keyedAddresses(artifacts: Record<string, ContractArtifact>, p: Policy, keys: PublicKeys) {
  const prepared = await instances(artifacts, p, AztecAddress.fromStringUnsafe(keys.owner), keys.salts);
  return { owner: keys.owner, treasury: keys.treasury, ...Object.fromEntries(Object.entries(prepared.values).map(([name, value]) => [name, value.address.toString()])) };
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function buildInitialState(c: Config, pricing: Parameters<typeof makePolicy>[1], identity: V6State['identity'], manifestPath: string, sponsoredFpc: string, keys?: KeysFile, generate = randomKeys): Promise<V6State> {
  if (!keys && c.network === 'testnet-v6') throw new Error('Keys file required for testnet-v6; run --init-keys first');
  const k = keys ? { secret: Fr.fromString(keys.owner.secret), salt: Fr.fromString(keys.owner.salt), signingKey: Fq.fromString(keys.owner.signingKey) } : generate();
  const owner = keys?.owner.address ?? (await getSchnorrInitializerlessAccountContractAddress(k.signingKey, k.salt, k.secret)).toString();
  const p = makePolicy(c, pricing, c.treasury ?? keys?.treasury.address ?? owner);
  return { schema: 'ans-deploy-v6-state/1', toolchainVersion: '6.0.0', network: c.network, identity, config: p, configHash: configHash(p), keys: { owner: { secret: k.secret.toString(), salt: k.salt.toString(), signingKey: k.signingKey.toString() } }, salts: keys ? { ...keys.salts } : Object.fromEntries(['token', 'registry', 'resolver', 'registrar'].map(key => [key, Fr.random().toString()])), addresses: { owner, treasury: p.treasury, sponsoredFpc }, transactions: {}, done: [], checks: [], manifestPath };
}
export function assertCheckpointKeys(state: V6State, keys: KeysFile) {
  const equal = state.keys.owner.secret === keys.owner.secret && state.keys.owner.salt === keys.owner.salt && state.keys.owner.signingKey === keys.owner.signingKey && state.addresses.owner === keys.owner.address && state.config.treasury === keys.treasury.address && Object.keys(state.salts).length === 4 && Object.entries(keys.salts).every(([key, value]) => state.salts[key] === value);
  assert(equal, 'Checkpoint keys file mismatch');
}
export async function main(argv = process.argv.slice(2), dependencies = { createNode: createAztecNodeClient, randomKeys }) {
  if (argv.includes('--init-keys')) {
    await initKeys(parseInitKeysArgs(argv), { randomKeys: dependencies.randomKeys, randomSalt: () => Fr.random(), now: () => new Date() });
    return;
  }
  // Public key projection and confirmation are resolved before any network I/O.
  const options = parseOptions(argv);
  if(options.registrar==='launch') options.reservedLabels=loadReservedList(JSON.parse(await readFile(options.reservedList!,'utf8')));
  if (options.network === 'mainnet') {
    if (!options.dryRun) { assertMainnetReady(); throw new Error('Mainnet blocked: registration fee-token mode undecided; token-deploying flow refused'); }
    const info = await dependencies.createNode(options.nodeUrl, { maxBatchSize: 3 }).getNodeInfo();
    const identity = assertV6Network('mainnet', info, options.nodeUrl);
    console.log(`IDENTITY ${JSON.stringify(identity)}`);
    console.log(`Mainnet blocked: ${mainnetBlockers().join(', ')}`);
    return;
  }
  const keysPath = join(options.stateDir, 'keys.json');
  const publicKeys = await exists(keysPath) ? await readPublicKeys(keysPath, options.network) : undefined;
  const c = finalizeConfig(options, publicKeys?.treasury), used = new Set<string>();
  const paths = await privatePaths(c);
  if (c.network === 'testnet-v6' && !c.dryRun && !publicKeys && !await exists(join(paths.state, 'state.json'))) throw new Error('Keys file required for testnet-v6; run --init-keys first');
  const rawNode = dependencies.createNode(c.nodeUrl, { maxBatchSize: V6_PROFILES[c.network].maxBatchSize });
  const preflight = dryRunNode(rawNode, used);
  try {
    const info = await preflight.getNodeInfo(), identity = assertV6Network(c.network, info, c.nodeUrl);
    console.log(`IDENTITY ${JSON.stringify({ nodeVersion: info.nodeVersion, ...identity, realProofs: info.realProofs })}`);
    let fpc: Awaited<ReturnType<typeof sponsoredFpc>> | undefined;
    let publishedFpc: Awaited<ReturnType<typeof preflight.getContract>>;
    if (c.feePayment === 'sponsored') {
      fpc = await sponsoredFpc(); publishedFpc = await preflight.getContract(fpc.instance.address);
      const fpcStatus = assertV6Fpc(c.network, fpc.instance, (await getContractClassFromArtifact(fpc.artifact)).id.toString(), publishedFpc);
      console.log(`PASS SponsoredFPC ${fpc.instance.address} class ${fpc.instance.currentContractClassId} ${fpcStatus}`);
    } else assertV6FeeJuice(c.network, info);
    const { artifacts, classIds } = await v6Artifacts(c.token, c.registrar, c.registryVersion);
    console.log(`PASS frozen artifact classes ${JSON.stringify(classIds)}`);
    const pricing = JSON.parse(await readFile(c.pricing, 'utf8'));
    if (pricing.annualPriceStatus === 'provisional') console.log('WARNING annualPriceStatus=provisional; using unchanged pricing');
    // Path checks do not create anything, including in dry runs.
    if (c.dryRun) {
      const pending = 'pending: derived after formal local key generation';
      const p = makePolicy(c, pricing, c.treasury ?? pending);
      const a: Record<string, string> = { owner: pending, treasury: p.treasury, sponsoredFpc: (fpc?.instance.address.toString() ?? ''), token: pending, registry: pending, resolver: pending, registrar: pending };
      if (publicKeys) Object.assign(a, await keyedAddresses(artifacts, p, publicKeys));
      console.log(`DRY-RUN ${JSON.stringify(deploymentPlan(c, p, identity, a, classIds, publicKeys ? 'Addresses derived from keys file (public values only)' : undefined), null, 2)}`);
      return;
    }
    await mkdir(paths.state, { recursive: true, mode: 0o700 }); await chmod(paths.state, 0o700);
    const unlock = acquireTestnetLock(join(paths.state, 'runner.lock'));
    const onExit = () => unlock(); process.once('exit', onExit);
    let wallet: EmbeddedWallet | undefined;
    let state: V6State | undefined;
    let activeStep = '';
    let claimStep = '';
    let feeMethod: FeePaymentMethod | undefined;
    const path = join(paths.state, 'state.json');
    const save = async () => atomicJson(path, state);
    try {
      try { state = JSON.parse(await readFile(path, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Unable to read private deployment checkpoint'); }
      if (!state) {
        state = await buildInitialState(c, pricing, identity, paths.out, (fpc?.instance.address.toString() ?? ''), publicKeys ? await readKeys(keysPath, c.network as 'local' | 'testnet-v6') : undefined, dependencies.randomKeys);
        if (c.feePayment === 'fee-juice') state.feePayment = 'fee-juice';
        await save();
      }
      assert.equal(state.schema, 'ans-deploy-v6-state/1', 'Unknown deployment checkpoint schema');
      assert.equal(state.toolchainVersion, '6.0.0', 'Checkpoint toolchain mismatch');
      assert.equal(state.network, c.network, 'Checkpoint network mismatch');
      assert.equal(state.feePayment ?? 'sponsored', c.feePayment, 'Checkpoint fee mode mismatch');
      assert.deepEqual(state.identity, identity, 'Checkpoint identity mismatch');
      if (publicKeys) assertCheckpointKeys(state, await readKeys(keysPath, c.network as 'local' | 'testnet-v6'));
      const p = makePolicy(c, pricing, c.treasury ?? state.addresses.owner);
      assert.equal(state.configHash, configHash(p), 'Checkpoint configHash mismatch');
      assert.equal(state.configHash, configHash(state.config), 'Checkpoint policy integrity mismatch');
      assert.equal(state.manifestPath, paths.out, 'Checkpoint manifest path mismatch');
      const node = new Proxy(rawNode, { get(target, prop) {
        if (prop === 'sendTx') return async (tx: Tx) => {
          assert(activeStep && !state!.transactions[activeStep], 'Refusing duplicate or uncheckpointed broadcast');
          // Revalidate immediately before the only broadcasting boundary.
          assertV6Network(c.network, await rawNode.getNodeInfo(), c.nodeUrl);
          state!.transactions[activeStep] = tx.getTxHash().toString();
          if (claimStep === activeStep) state!.feeClaim = { usedBy: activeStep };
          await save();
          await target.sendTx(tx);
          console.log(`BROADCAST ${activeStep} ${state!.transactions[activeStep]}`);
        };
        const v = Reflect.get(target, prop); return typeof v === 'function' ? v.bind(target) : v;
      } }) as AztecNode;
      wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: info.realProofs, dataDirectory: join(paths.state, 'wallet') } });
      if (fpc) await wallet.registerContract(publishedFpc ?? fpc.instance, fpc.artifact);
      const k = state.keys.owner;
      const owner = (await wallet.createSchnorrInitializerlessAccount(Fr.fromString(k.secret), Fr.fromString(k.salt), Fq.fromString(k.signingKey))).address;
      assert.equal(owner.toString(), state.addresses.owner, 'Owner checkpoint mismatch');
      const prepared = await instances(artifacts, p, owner, state.salts);
      for (const [key, instance] of Object.entries(prepared.values)) {
        if (state.addresses[key]) assert.equal(state.addresses[key], instance.address.toString(), 'Deterministic address changed');
        state.addresses[key] = instance.address.toString();
      }
      await save();
      const assertions = acceptanceChecks(state.checks);
      const check = (name: string, value: unknown) => { assertions.check(name, value); console.log(`PASS ${name}`); };
      const bound = async () => {
        const reader = await RegistryReader.connect(node, prepared.values.registry.address);
        // Read raw module fields so an unbootstrapped zero binding is an absent effect, not an RPC failure.
        const snapshot = await reader.snapshot();
        const fields = await Promise.all([0n, 1n, 2n].map(async offset => (await node.getPublicStorageAt(BlockNumber(snapshot.blockNumber), reader.registry, new Fr(reader.slots.modules.slot.toBigInt() + offset))).toBigInt()));
        if (fields[0] === 0n && fields[1] === 0n && fields[2] === 0n) return false;
        assert.equal(fields[0], prepared.values.registrar.address.toBigInt(), 'Unexpected registrar binding');
        assert.equal(fields[1], prepared.values.resolver.address.toBigInt(), 'Unexpected resolver binding');
        return true;
      };
      const launch = NameRegistrarLaunchContract.at(prepared.values.registrar.address, wallet);
      const nodeReadReserved = async (nodeValue: bigint) => {
        const {deriveStorageSlotInMap}=await import('@aztec-labs/stdlib/hash');
        const slot=await deriveStorageSlotInMap(NameRegistrarLaunchContract.storage.reserved.slot,new Fr(nodeValue));
        return (await node.getPublicStorageAt('latest',launch.address,slot)).toBigInt()===1n;
      };
      const effect = async (name: string) => {
        if (name === 'bootstrap') return bound();
        if (name.startsWith('seed-reserved-')) {
          const batches=reservedBatches(await reservedNodes(p.reservedLabels??[]));
          const batch=batches[Number(name.slice('seed-reserved-'.length))];
          assert(batch,'Unknown reservation batch');
          await verifyReservations(batch.filter(n=>n!==0n).map(node=>({node,reserved:true})),async node=>(await nodeReadReserved(node)));
          return true;
        }
        const key = name.slice('deploy-'.length) as keyof typeof prepared.values;
        const found = await node.getContract(prepared.values[key].address);
        if (!found) return false;
        assert.equal(found.currentContractClassId.toString(), classIds[key], 'Published class mismatch');
        return true;
      };
      if (c.rebroadcast) {
        assert(!state.done.includes(c.rebroadcast) && state.transactions[c.rebroadcast], 'Rebroadcast requires a pending checkpoint');
        const { TxHash, TxStatus } = await import('@aztec-labs/aztec.js/tx');
        assert.equal((await node.getTxReceipt(TxHash.fromString(state.transactions[c.rebroadcast]))).status, TxStatus.DROPPED, 'Rebroadcast requires a dropped receipt');
        assert(!(await effect(c.rebroadcast)), 'Rebroadcast forbidden: chain effect exists');
        delete state.transactions[c.rebroadcast]; await save();
      }
      const firstUnfinished = deploymentTransactionSteps(c).find(step => !state!.done.includes(step));
      const claim = c.feePayment === 'fee-juice' ? await readBridgeClaim(paths.state, c.network, owner.toString()) : undefined;
      const fee = () => fpc ? fpc.fee.fee : feeMethod ? { paymentMethod: feeMethod } : undefined;
      const step = async (name: string, send: () => Promise<unknown>) => {
        activeStep = name;
        console.log(`${state!.done.includes(name) ? 'SKIP' : state!.transactions[name] ? 'RESUME' : 'STEP'} ${name}${state!.transactions[name] ? ` ${state!.transactions[name]}` : ''}`);
        await runCheckpointedStep(state!, name, async () => {
          feeMethod = undefined; claimStep = '';
          if (c.feePayment === 'fee-juice') {
            const balance = await readFeeJuiceBalance(node, owner);
            let selection;
            try { selection = selectFeeJuice(balance, c.minFeeJuice!, name === firstUnfinished ? claim : undefined, state!, name); }
            catch { throw new Error(`Deployer Fee Juice insufficient and no unconsumed claim; owner=${owner} balance=${balance}`); }
            if (selection === 'claim') {
              if (!await isL1ToL2MessageReady(node, Fr.fromString(claim!.messageHash!), 'proven')) throw new Error('Fee claim L1-to-L2 message is not ready at proven tip');
              claimStep = name;
              feeMethod = new FeeJuicePaymentMethodWithClaim(owner, { claimAmount: BigInt(claim!.amount), claimSecret: Fr.fromString(claim!.claimSecret), messageLeafIndex: BigInt(claim!.leafIndex!) });
            }
          }
          return send();
        }, async hash => {
          try { return await trackTx(node, hash, { waitFor: 'confirmed', timeoutMs: 30 * 60_000, pollMs: 1000 }); }
          catch (e) {
            if ((e as { code?: string }).code !== 'dropped') throw e;
            if (!(await effect(name))) throw new Error(`Pending ${name} dropped and effect absent; explicit --rebroadcast required`);
            console.log(`PASS ${name} published-without-receipt`);
            return { txHash: hash, state: 'published-without-receipt' };
          }
        }, async () => check(`${name} effect verified`, await effect(name)), save);
        console.log(`DONE ${name}`); activeStep = '';
      };
      for (const key of ['token', 'registry', 'resolver', 'registrar'] as const) {
        if(key==='token' && c.token==='none') continue;
        const deploy = Contract.deploy(wallet, artifacts[key], prepared.args[key], undefined, { salt: Fr.fromString(state.salts[key]), deployer: owner });
        await step(`deploy-${key}`, () => deploy.send({ from: owner, fee: fee(), wait: NO_WAIT }));
        await wallet.registerContract(prepared.values[key], artifacts[key]);
      }
      const core = (c.registryVersion === 7 ? NameRegistryV7Contract : NameRegistryV6Contract).at(prepared.values.registry.address, wallet);
      if(p.registrar==='launch') {
        const nodes=await reservedNodes(p.reservedLabels??[]),batches=reservedBatches(nodes);
        for(const [i,batch] of batches.entries()) await step(`seed-reserved-${i}`,()=>launch.methods.set_reserved(batch,true).send({from:owner,fee:fee(),wait:NO_WAIT}));
        await verifyReservations(nodes.map(node=>({node,reserved:true})),nodeReadReserved);
        check('reserved list verified before bootstrap',true);
        for(const name of ['seed-reserved','verify-reserved']) if(!state.done.includes(name))state.done.push(name);
        await save();
      }
      await step('bootstrap', () => core.methods.bootstrap(prepared.values.registrar.address, prepared.values.resolver.address).send({ from: owner, fee: fee(), wait: NO_WAIT }));
      const reader = await RegistryReader.connect(node, core.address), policy = await reader.getConfig(), modules = await reader.getModules();
      check('registry implementation version', Number((await core.methods.implementation_version().simulate({from:owner})).result) === c.registryVersion);
      check('registry class', reader.classId === classIds.registry);
      check('registrar binding', modules.registrar.equals(prepared.values.registrar.address));
      check('resolver binding', modules.resolver.equals(prepared.values.resolver.address));
      check('legacy zero', !(await reader.getLegacyRegistry()));
      check('annual price', policy.annualPrice === BigInt(p.annualPrice));
      check('price version', policy.priceVersion === p.priceVersion);
      check('fee token', policy.feeToken.equals(prepared.values.token.address));
      check('treasury', policy.treasury.toString() === p.treasury);
      if (p.lengthPrices) {
        check('three-character price', policy.lengthPrices?.three === BigInt(p.lengthPrices['3']));
        check('four-character price', policy.lengthPrices?.four === BigInt(p.lengthPrices['4']));
      } else check('flat policy has no tiers', !policy.lengthPrices);
      if(p.registrar==='launch') {
        check('launch minimum',policy.launch?.minPublicLength===p.minPublicLength);
        check('launch pause',policy.launch?.paused===p.initialPaused);
        check('launch renewal cap',policy.launch?.maxRenewAhead===BigInt(p.maxRenewAhead??'0'));
      }
      const tokenMeta = c.token==='none' ? {symbol:'FREE',decimals:18} : c.token === 'official' ? await readFeeTokenMetadata(reader, prepared.values.token.address) : await (async () => {
        const snap = await reader.snapshot();
        const instance = await node.getContract(prepared.values.token.address);
        assert.equal(instance?.currentContractClassId.toString(), classIds.token, 'Repository token class mismatch');
        const [symbol, decimals] = await Promise.all([6n, 10n].map(slot => node.getPublicStorageAt(BlockNumber(snap.blockNumber), prepared.values.token.address, new Fr(slot))));
        return { symbol: new TextDecoder().decode(symbol.toBuffer().filter(byte => byte !== 0)), decimals: Number(decimals.toBigInt()) };
      })();
      check('token symbol', tokenMeta.symbol === p.tokenSymbol); check('token decimals', tokenMeta.decimals === p.decimals);
      state.deployedAt ??= new Date().toISOString();
      const manifest = buildManifest(c, p, identity, state.addresses, classIds, state.transactions, state.deployedAt);
      assert.deepEqual(v6ManifestProblems(manifest, { expectNetwork: c.network }), [], 'Manifest self-validation failed');
      const publicJson = JSON.stringify(manifest);
      for (const value of [...Object.values(state.keys.owner), ...Object.values(state.salts)]) assert(!publicJson.includes(value), 'Private value in manifest');
      if (publicKeys) {
        const keys = await readKeys(keysPath, c.network as 'local' | 'testnet-v6');
        for (const value of [keys.treasury.secret, keys.treasury.salt, keys.treasury.signingKey]) assert(!publicJson.includes(value), 'Private value in manifest');
      }
      await mkdir(dirname(paths.out), { recursive: true }); await atomicJson(paths.out, manifest);
      delete state.lastError; await save();
      console.log(`MANIFEST ${paths.out}`);
    } catch (e) {
      if (state) { state.lastError = `Stopped at ${activeStep || 'setup'}; checkpoint retained`; await save(); }
      throw e;
    } finally { if (wallet) await wallet.stop(); process.removeListener('exit', onExit); unlock(); }
  } finally { if (c.dryRun) console.log(`DRY-RUN node methods used: ${JSON.stringify([...used])}`); }
}
export function deploymentError(error: unknown): string {
  return error instanceof assert.AssertionError ? error.message.split('\n')[0] : error instanceof Error && /^(Exact --confirm|Keys |Treasury |--init-keys|--|Unknown|A valid|Local |Invalid |V6 network|State |Legacy |Token |Manifest |Checkpoint |Pending |Rebroadcast |Unable to read|DRY-RUN|Mainnet blocked|Deployer Fee Juice|Fee )/.test(error.message) ? error.message.split('\n')[0] : 'V6 deployment stopped; inspect checkpoint status and network availability';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never serialize arbitrary node/wallet exceptions or their payloads.
    console.error(deploymentError(error));
    process.exitCode = 1;
  });
}
