import assert from 'node:assert/strict';
import test from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { RegistryReader } from '../src/client/reader.js';
import { registerCommitment } from '../src/core/hash.js';
import { normalizeName } from '../src/core/label.js';
import { nodeOf } from '../src/core/hash.js';
import { checkRegistration, prepareRegistration, submitRegistration } from '../src/transactions/registration.js';
import { NameRegistryV5Contract } from '../src/artifacts/NameRegistryV5.js';
import { NameRegistryV3Contract } from '../src/artifacts/NameRegistryV3.js';
import { NameRegistrarContract } from '../src/artifacts/NameRegistrar.js';
import { NameRegistrarTieredContract } from '../src/artifacts/NameRegistrarTiered.js';
import { NameResolverContract } from '../src/artifacts/NameResolver.js';
import { RegistryUpgradeTestContract } from '../src/artifacts/RegistryUpgradeTest.js';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import pinned from './fixtures/classids-6.0.0.json' with { type: 'json' };
import legacy from '../src/artifacts/read-metadata.json' with { type: 'json' };
import { NameRegistryV6Contract } from '../src/artifacts/NameRegistryV6.js';
import { registryProtocol } from '../src/core/registry-protocol.js';
import metadata from '../src/artifacts/modular-metadata.json' with { type: 'json' };

const addr = (n: number) => AztecAddress.fromBigIntUnsafe(BigInt(n));
const snap = { blockNumber: 10, blockHash: 'block-10', timestamp: 1000n, finality: 'checkpointed' as const };
function chain() {
  const registry = addr(1), first = addr(2), resolver = addr(3), second = addr(4);
  const classes = new Map([[registry.toString(), metadata.registry.classId], [first.toString(), metadata.registrar.classId], [second.toString(), metadata.registrar.classId], [resolver.toString(), metadata.resolver.classId]]);
  const state = new Map<string, bigint>();
  const write = (address: AztecAddress, slot: string, values: bigint[]) => values.forEach((v,i) => state.set(`${address}:${BigInt(slot)+BigInt(i)}`, v));
  write(registry, metadata.registry.storage.modules, [2n,3n,1n]);
  write(first, metadata.registrar.storage.registry, [1n]);
  write(second, metadata.registrar.storage.registry, [1n]);
  write(resolver, metadata.resolver.storage.registry, [1n]);
  write(first, metadata.registrar.storage.config, [9n,8n,100n,1n]);
  write(second, metadata.registrar.storage.config, [9n,8n,200n,2n]);
  let reads = 0;
  const node = {
    getNodeInfo: async () => ({ l1ChainId: 11155111, rollupVersion: 1821665230 }),
    getContract: async (address: AztecAddress) => classes.has(address.toString()) ? { currentContractClassId: Fr.fromString(classes.get(address.toString())!) } : undefined,
    getPublicStorageAt: async (_block: unknown, address: AztecAddress, slot: Fr) => { reads++; return new Fr(state.get(`${address}:${slot.toBigInt()}`) ?? 0n); },
    getBlockData: async () => ({ blockHash: 'block-10', header: { globalVariables: { blockNumber: 10, timestamp: 1000 } } }),
  } as any;
  return { registry, first, second, classes, state, write, node, reads:()=>reads };
}

test('all modular class IDs and layouts match the generated artifacts', async () => {
  for (const [key, contract] of Object.entries({registry:NameRegistryV3Contract,registrar:NameRegistrarContract,registrarTiered:NameRegistrarTieredContract,resolver:NameResolverContract,upgradeTest:RegistryUpgradeTestContract,current:NameRegistryV5Contract})) {
    const m = metadata[key as keyof typeof metadata];
    assert.equal(m.classId, (await getContractClassFromArtifact(contract.artifact)).id.toString());
    assert.deepEqual(m.storage, Object.fromEntries(Object.entries(contract.storage).map(([k,v])=>[k,v.slot.toString()])));
  }
  assert.deepEqual(metadata.registry.storage,metadata.upgradeTest.storage);
});

test('V3 fees follow the current registrar instead of a permanent configuration cache', async () => {
  const c=chain(); const reader=await RegistryReader.connect(c.node,c.registry);
  assert.equal(reader.deployment.protocolVersion,3);
  assert.equal((await reader.getConfig(snap)).annualPrice,100n);
  c.write(c.registry,metadata.registry.storage.modules,[4n,3n,2n]);
  const next=await reader.getConfig(snap);
  assert.equal(next.annualPrice,200n);assert.equal(next.registrar?.toString(),c.second.toString());
});

test('a tiered registrar exposes length prices and quotes each name by its length', async () => {
  const {getFeeQuote}=await import('../src/transactions/fees.js');
  const c=chain(),tiered=addr(6);
  c.classes.set(tiered.toString(),metadata.registrarTiered.classId);
  c.write(tiered,metadata.registrarTiered.storage.registry,[1n]);
  c.write(tiered,metadata.registrarTiered.storage.config,[9n,8n,1n,3n]);
  c.write(tiered,metadata.registrarTiered.storage.length_prices,[128n,32n]);
  c.write(c.registry,metadata.registry.storage.modules,[6n,3n,2n]);
  const reader=await RegistryReader.connect(c.node,c.registry);
  assert.deepEqual((await reader.getConfig(snap)).lengthPrices,{three:128n,four:32n});
  const year=31536000n,quote=(labelLength?:number)=>getFeeQuote(reader,{operation:'register',duration:year,labelLength,snapshot:snap});
  assert.deepEqual([(await quote(3)).fee,(await quote(4)).fee,(await quote(5)).fee],[128n,32n,1n]);
  assert.equal((await quote(3)).annualPrice,128n);assert.equal((await quote(3)).labelLength,3);
  await assert.rejects(quote(),(e:any)=>e.code==='invalid_argument');
  // Same fee, different name length: an accepted quote is still bound to the length it was shown for.
  const {assertAcceptedQuote}=await import('../src/transactions/fees.js');
  const six=await quote(6),five=await quote(5);
  assert.throws(()=>assertAcceptedQuote(six,five),(e:any)=>e.code==='fee_changed');
  assertAcceptedQuote(await quote(5),await quote(5));
});

test('a stale reader fails closed after an unknown core upgrade, before storage reads', async () => {
  const c=chain(); const reader=await RegistryReader.connect(c.node,c.registry);
  c.classes.set(c.registry.toString(),Fr.ZERO.toString());
  await assert.rejects(reader.snapshot(),(e:any)=>e.code==='wrong_deployment');
  await assert.rejects(reader.getConfig(snap),(e:any)=>e.code==='wrong_deployment');
  assert.equal(c.reads(),0);
});

test('a known compatible upgrade keeps the reader and selects its exact class', async () => {
  const c=chain(); const reader=await RegistryReader.connect(c.node,c.registry);
  c.classes.set(c.registry.toString(),metadata.upgradeTest.classId);
  await reader.snapshot();
  assert.equal(reader.classId,metadata.upgradeTest.classId);
  assert.equal((await reader.getConfig(snap)).annualPrice,100n);
});

test('unknown registrar classes and cross-registry modules are rejected', async () => {
  const c=chain(); const reader=await RegistryReader.connect(c.node,c.registry);
  c.classes.set(c.first.toString(),metadata.resolver.classId);
  await assert.rejects(reader.getConfig(snap),(e:any)=>e.code==='wrong_deployment');
  c.classes.set(c.first.toString(),metadata.registrar.classId);
  c.write(c.first,metadata.registrar.storage.registry,[123n]);
  await assert.rejects(reader.getConfig(snap),(e:any)=>e.code==='wrong_deployment');
});

test('otherwise identical commitments differ across registrar policies',async()=>{
  const i={chainId:1n,registry:addr(1),node:await nodeOf(normalizeName('alice')),expectedGeneration:0,owner:addr(5),duration:31536000n,feeToken:addr(9),treasury:addr(8),priceVersion:1,maxFee:100n,quoteExpiry:9000n,secret:123n};
  const legacy=await registerCommitment(i),a=await registerCommitment({...i,registrar:addr(2)}),b=await registerCommitment({...i,registrar:addr(4)});
  assert.notEqual(a,b);assert.notEqual(a,legacy);
});

test('a retired registration plan cannot ask a wallet for another payment, while completed plans remain completed',async()=>{
  const c=chain(); const reader=await RegistryReader.connect(c.node,c.registry);
  const account=addr(5);const ctx={reader,account,registrationContract:async()=>{throw new Error('must not call wallet');}} as any;
  const plan=await prepareRegistration(ctx,{name:'alice',duration:31536000n});
  assert.equal(plan.v,3); assert.equal(plan.registrar,c.first.toString());
  let consumed=false;
  reader.getCommit=async()=>({committedAt:900n,consumed});
  c.write(c.registry,metadata.registry.storage.modules,[4n,3n,2n]);
  assert.equal((await checkRegistration(reader,plan)).state,'policy_changed');
  await assert.rejects(submitRegistration(ctx,plan),(e:any)=>e.code==='fee_changed');
  consumed=true;assert.equal((await checkRegistration(reader,plan)).state,'registered');
});

test('a registrar change with the same price still invalidates a displayed quote before preparing payment', async()=>{
  const {getFeeQuote}=await import('../src/transactions/fees.js');
  const c=chain(), reader=await RegistryReader.connect(c.node,c.registry);
  const acceptedQuote=await getFeeQuote(reader,{operation:'register',duration:31536000n});
  c.write(c.second,metadata.registrar.storage.config,[9n,8n,100n,1n]);
  c.write(c.registry,metadata.registry.storage.modules,[4n,3n,2n]);
  await assert.rejects(prepareRegistration({reader,account:addr(5)} as any,{name:'alice',duration:31536000n,acceptedQuote}),(e:any)=>e.code==='fee_changed');
});

test('renewal rejects a changed displayed policy before requesting an AuthWit', async()=>{
  const {getFeeQuote}=await import('../src/transactions/fees.js'),{renew}=await import('../src/transactions/holder.js');
  const c=chain(),reader=await RegistryReader.connect(c.node,c.registry),account=addr(5);
  reader.getName=async()=>({generation:1,revision:0,expiresAt:9999n,owner:account});
  const acceptedQuote=await getFeeQuote(reader,{operation:'renew',duration:31536000n});
  c.write(c.second,metadata.registrar.storage.config,[9n,8n,100n,1n]);c.write(c.registry,metadata.registry.storage.modules,[4n,3n,2n]);
  let signatures=0;const ctx={reader,account,wallet:{createAuthWit:async()=>{signatures++;}}} as any;
  await assert.rejects(renew(ctx,{name:'alice',duration:31536000n,acceptedQuote}),(e:any)=>e.code==='fee_changed');assert.equal(signatures,0);
});

test('V5 selects its layout and exposes direct configuration without deferred execution or implementation upgrades', async () => {
  const c = chain();
  c.classes.set(c.registry.toString(), metadata.current.classId);
  c.write(c.registry, metadata.current.storage.modules, [2n,3n,1n]);
  c.write(c.registry, metadata.current.storage.legacy, [7n]);
  c.write(c.registry, metadata.current.storage.administrator, [8n]);
  const reader = await RegistryReader.connect(c.node, c.registry);
  assert.equal(reader.deployment.protocolVersion, 5);
  assert.equal((await reader.getConfig(snap)).annualPrice, 100n);
  assert.equal((await reader.getLegacyRegistry(snap))?.toString(), addr(7).toString());
  const names = [...NameRegistryV5Contract.artifact.functions, ...NameRegistryV5Contract.artifact.nonDispatchPublicFunctions].map(fn => fn.name);
  assert(names.includes('bootstrap'));
  assert(names.includes('configure_modules')); assert(names.includes('set_administrator'));
  assert.equal((await reader.getAdministrator(snap))?.toString(), addr(8).toString());
  assert(!names.some(name => /governance|schedule|execute|cancel_module|cancel_upgrade|upgrade|approve_resolver/.test(name)));
  const api = await import('../src/index.js');
  assert(!('NameRegistryV3Contract' in api)); assert(!('NameRegistryV4Contract' in api));
  assert.equal(typeof api.configureModules, 'function');
  assert.equal(typeof api.setAdministrator, 'function');
  assert(!('scheduleModule' in api)); assert(!('scheduleUpgrade' in api));
});

test('configuration authorization and module identity fail before requesting the wallet', async () => {
  const {configureModules} = await import('../src/transactions/modules.js');
  const c=chain(); c.classes.set(c.registry.toString(),metadata.current.classId);
  c.write(c.registry,metadata.current.storage.modules,[2n,3n,1n]);
  c.write(c.registry,metadata.current.storage.administrator,[8n]);
  const reader=await RegistryReader.connect(c.node,c.registry);
  let walletRequests=0;
  const ctx={reader,account:addr(5),get wallet(){walletRequests++;throw new Error('must not request wallet');}} as any;
  await assert.rejects(configureModules(ctx,{registrar:c.first,resolver:addr(3)}),(e:any)=>e.code==='not_administrator');
  ctx.account=addr(8);
  await assert.rejects(configureModules(ctx,{registrar:addr(3),resolver:addr(3)}),(e:any)=>e.code==='wrong_deployment');
  assert.equal(walletRequests,0);
});

test('a recognized class from another storage family is rejected before reading slots', async () => {
  for (const [initial, replacement] of [[metadata.registry.classId,metadata.current.classId],[metadata.current.classId,metadata.extended.classId]]) {
    const c=chain();c.classes.set(c.registry.toString(),initial);
    const reader=await RegistryReader.connect(c.node,c.registry);
    c.classes.set(c.registry.toString(),replacement);
    await assert.rejects(reader.getConfig(snap),(e:any)=>e.code==='wrong_deployment');
    assert.equal(c.reads(),0);
  }
});

test('initial connection rejects an incompatible known class applied to legacy storage', async () => {
  const c=chain(), getContract=c.node.getContract;
  c.node.getContract=async(address:AztecAddress)=>address.equals(c.registry)
    ? {...await getContract(address),currentContractClassId:Fr.fromString(metadata.current.classId),originalContractClassId:Fr.fromString(metadata.registry.classId)}
    : getContract(address);
  await assert.rejects(RegistryReader.connect(c.node,c.registry),(e:any)=>e.code==='wrong_deployment');
  assert.equal(c.reads(),0);
});

test('legacy layouts do not expose configuration authority through the administrator API', async () => {
  const c=chain(),reader=await RegistryReader.connect(c.node,c.registry);
  assert.equal(await reader.getAdministrator(snap),undefined);
  assert.equal(c.reads(),0);
});


test('6.0.0 class identities are pinned independently of generated metadata', async () => {
  assert.equal(legacy.classId, pinned.classIds.legacy);
  for (const [key, value] of Object.entries(metadata))
    assert.equal(value.classId, pinned.classIds[key as keyof typeof pinned.classIds], key);
  assert.equal((await getContractClassFromArtifact(NameRegistryV6Contract.artifact)).id.toString(), pinned.classIds.v6);
});

test('5.2.1 archive registry identities are rejected by the 6.0.0 SDK', async () => {
  const { default: archive } = await import('../../scripts/fixtures/aztec5-final-metadata.json', { with: { type: 'json' } });
  for (const key of ['registry', 'extended', 'current', 'upgradeTest'] as const)
    assert.throws(() => registryProtocol(archive.modular[key].classId), /does not match/);
});
