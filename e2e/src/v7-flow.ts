/** V7 regressions on an isolated proof-disabled loopback node, preserving the historical modular checks. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadContractArtifact } from '@aztec-labs/aztec.js/abi';
import { Contract, type InteractionFeeOptions } from '@aztec-labs/aztec.js/contracts';
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { AztecAddress as Address } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import type { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client';
import { AnsContext, RegistryReader, NameRegistrarLaunchContract, NameResolverContract, prepareRegistration, submitCommit, submitRegistration, checkRegistration, inspectHolding, setAddress, setResolver, setManager, setTextRecord, offerTransfer, acceptTransfer, setPrimary, resolveAddress, resolvePrimary, renew, normalizeName, nodeOf } from '@ans/sdk';
import { NameRegistryV7Contract } from '@ans/sdk/contracts/v7';
import { exerciseExtensions } from './extensions.js';

type Debug = ReturnType<typeof createAztecNodeDebugClient>;
export async function exerciseV7Flow(node: AztecNode, debug: Debug, wallet: EmbeddedWallet, admin: AztecAddress, alice: AztecAddress, bob: AztecAddress, fee: InteractionFeeOptions, warp: (seconds: number) => Promise<unknown>, check: (label: string, value: unknown) => void) {
  const info = await node.getNodeInfo();
  assert.equal(info.realProofs, false); assert.equal(Number(info.l1ChainId), 31337);
  const YEAR = 31536000n;
  const { contract: core } = await NameRegistryV7Contract.deploy(wallet, Address.ZERO).send({ from: admin, fee });
  const { contract: resolver } = await NameResolverContract.deploy(wallet, core.address).send({ from: admin, fee });
  const { contract: registrar } = await NameRegistrarLaunchContract.deploy(wallet, core.address, Address.ZERO, admin, 0n, 0n, 0n, 1, 7, false, YEAR).send({ from: admin, fee });
  await core.methods.bootstrap(registrar.address, resolver.address).send({ from: admin, fee });
  const reader = await RegistryReader.connect(node, core.address), owner = new AnsContext(reader, { wallet, account: alice, fee }), buyer = owner.as(bob);
  await owner.ensureRegistered();
  check('V7 recognized with zero legacy and frozen launch/resolver modules', reader.deployment.protocolVersion === 7 && !(await reader.getLegacyRegistry()) && (await reader.getConfig()).launch?.maxRenewAhead === YEAR);
  const register = async (name: string) => {
    let plan = await prepareRegistration(owner, { name, duration: YEAR });
    ({ plan } = await submitCommit(owner, plan)); await debug.warpL2TimeAtLeastBy(70);
    assert.equal((await checkRegistration(reader, plan)).state, 'ready_to_register');
    await submitRegistration(owner, plan); return plan;
  };
  const name = 'v7-transfer'; await register(name);
  const artifact = loadContractArtifact(JSON.parse(await readFile(new URL('../../contracts/target/evil_resolver_test-EvilResolverTest.json', import.meta.url), 'utf8')));
  const { contract: evil } = await Contract.deploy(wallet, artifact, [core.address]).send({ from: admin, fee });
  const chooseEvil = async () => {
    const h = await inspectHolding(owner, name);
    await core.methods.set_resolver(h.node, h.record.generation, h.record.revision, evil.address).send({ from: alice, fee });
  };
  const writeEvil = async () => {
    const h = await inspectHolding(owner, name);
    await evil.methods.write(h.node, h.record.generation, h.recordRevision, alice.toField(), true, bob).send({ from: bob, fee });
  };
  await chooseEvil(); await writeEvil();
  check('V7 chosen malicious resolver is surfaced as untrusted before transfer', (await resolveAddress(reader, name)).status === 'untrusted_resolver');
  const malicious = await inspectHolding(owner, name);
  await core.methods.set_primary(malicious.node, malicious.record.generation, (await reader.getAddress(malicious.node, malicious.record.generation, malicious.snapshot)).bindingVersion).send({ from: bob, fee });
  check('V7 malicious resolver cannot produce a verified reverse name', (await resolvePrimary(reader, bob)).status === 'stale');
  for (let i = 0; i < 3; i++) await writeEvil();
  await setResolver(owner, { name, resolver: resolver.address });
  check('V7 holder resets a pumping resolver using an unchanged holder revision', (await reader.getResolver(malicious.node, malicious.record.generation)).equals(resolver.address));
  await chooseEvil(); await setManager(owner, { name, manager: bob }); await offerTransfer(owner, { name, recipient: bob });
  const before = await inspectHolding(owner, name);
  await writeEvil(); await setTextRecord(buyer, { name, key: 'description', value: 'editor write between offer and acceptance' });
  const edited = await inspectHolding(owner, name);
  check('V7 resolver/editor writes advance only the record revision', edited.record.revision === before.record.revision && edited.recordRevision > before.recordRevision);
  const accepted = await acceptTransfer(buyer, { name });
  const after = await inspectHolding(buyer, name);
  check('V7 transfer succeeds with the holder revision and resets the resolver', accepted.resolverReset && after.record.generation === before.record.generation + 1 && (await reader.getResolver(after.node, after.record.generation)).equals(resolver.address));
  check('V7 transferred generation starts with empty address and record revision zero', !(await reader.getAddress(after.node, after.record.generation, after.snapshot)).present && after.recordRevision === 0);
  await assert.rejects(evil.methods.write(after.node, after.record.generation, 0, bob.toField(), true, alice).send({ from: alice, fee }));
  check('V7 previous malicious resolver cannot write for the new owner', true);
  await setAddress(buyer, { name, address: bob }); await setPrimary(buyer, { name });
  check('V7 buyer writes through frozen default resolver and confirms primary', (await resolveAddress(reader, name)).status === 'resolved' && (await resolvePrimary(reader, bob)).status === 'verified');
  await renew(buyer, { name, duration: YEAR });
  await assert.rejects(renew(buyer, { name, duration: YEAR }), (error: any) => error.code === 'renewal_too_early');
  check('V7 frozen launch renews with holder revision and enforces one-year horizon', true);
  const label = normalizeName('v7minted'), expiry = (await reader.snapshot()).timestamp + 86400n, secret = Fr.random();
  const commitment = (await registrar.methods.admin_commitment(bob, label.bytes, label.len, 0, expiry, secret).simulate({ from: admin })).result;
  await registrar.methods.commit(commitment).send({ from: admin, fee }); await debug.warpL2TimeAtLeastBy(70);
  await registrar.methods.admin_register(label.bytes, label.len, bob, 0, expiry, secret).send({ from: admin, fee });
  check('V7 frozen launch admin mint reads current administrator', (await reader.getName(await nodeOf(label), await reader.snapshot())).owner.equals(bob));
  if (process.env.ANS_EXTENSIONS === '1') {
    await register('modular-name');
    await exerciseExtensions(owner, buyer, warp, check, 'V7');
  }
  await core.methods.nominate_administrator(bob).send({ from: admin, fee });
  await core.methods.accept_administrator().send({ from: bob, fee });
  check('V7 administrator handoff keeps nomination and acceptance', (await reader.getAdministrator())?.equals(bob));
}
