/** Explicit local fixtures: exact reviewed C cancellation, and deliberately changed protocol delay. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Contract, getContractClassFromArtifact } from '@aztec-labs/aztec.js/contracts';
import { publishContractClass } from '@aztec-labs/aztec.js/deployment';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { loadContractArtifact } from '@aztec-labs/stdlib/abi';
import { NameRegistryV8RehearsalContract } from '@ans/sdk/contracts/v8';
import type { AnsContext } from '@ans/sdk';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };

export async function exerciseV8Fixtures(ctx: AnsContext, fixtureDirectory: string, warp: (timestamp: bigint) => Promise<void>, check: (label: string, value: unknown) => Promise<void>) {
  const { node } = ctx.reader, wallet = ctx.wallet, admin = ctx.account, fee = ctx.signer.fee;
  const info = await node.getNodeInfo(); assert.equal(info.realProofs, false); assert.equal(Number(info.l1ChainId), 31337);
  const readArtifact = async (file: string) => loadContractArtifact(JSON.parse(await readFile(`${fixtureDirectory}/target/${file}.json`, 'utf8')));
  const next = await readArtifact('v8_next_fixture-NameRegistryV8NextFixture');
  const delay = await readArtifact('v8_delay_fixture-NameRegistryV8DelayFixture');
  assert.deepEqual(next.storageLayout, NameRegistryV8RehearsalContract.artifact.storageLayout, 'C fixture keeps actual V8 layout exactly');
  assert.deepEqual(delay.storageLayout, next.storageLayout, 'delay fixture changes no storage');
  const C = (await getContractClassFromArtifact(next)).id;
  const F = (await getContractClassFromArtifact(delay)).id;
  const B = Fr.fromString(metadata.v8Rehearsal.classId);
  const core = NameRegistryV8RehearsalContract.at(ctx.reader.registry, wallet);
  const read = async (address: AztecAddress, slot: bigint, count: number) => {
    const header = await node.getBlockData('latest'); assert(header);
    const number = header.header.globalVariables.blockNumber;
    const [values, instance] = await Promise.all([Promise.all(Array.from({ length: count }, (_, i) => node.getPublicStorageAt(number, address, new Fr(slot + BigInt(i))).then(v => v.toBigInt()))), node.getContract(address, number)]);
    assert.equal(String((await node.getBlockData(number))!.blockHash), String(header.blockHash));
    return { values, instance, timestamp: BigInt(header.header.globalVariables.timestamp) };
  };
  const slots = metadata.v8.storage;
  const raw = async (contract: any, method: string, ...args: unknown[]) => {
    const nonce = (await read(contract.address, BigInt(slots.upgrade_nonce), 1)).values[0];
    return contract.methods[method](nonce, ...args).send({ from: admin, fee });
  };
  await (await publishContractClass(wallet, next)).send({ from: admin, fee });
  await raw(core, 'approve_release', C, 0x414e535f434f5245n, 3);
  await raw(core, 'approve_edge_pair', B, C);
  await raw(core, 'propose_upgrade', B, C);
  await assert.rejects(ctx.reader.getCoreUpgradeState(), /unknown directed upgrade edge/);
  await check('explicit local C fixture is not silently accepted by the SDK rehearsal profile', true);
  const pending = (await read(core.address, BigInt(slots.pending), 7)).values;
  await warp(pending[6]); await raw(core, 'execute_upgrade', B, C);
  const schedule = (await read(core.address, BigInt(slots.scheduled), 6)).values;
  await warp(schedule[5] - 145n);
  const cancelled = await raw(core, 'cancel_scheduled_upgrade');
  const receipt = cancelled.receipt ?? cancelled;
  const actual = await node.getBlockData(receipt.blockNumber!); assert(actual);
  await check('current B pending C cancellation is included strictly before activation using runtime B', BigInt(actual.header.globalVariables.timestamp) === schedule[5] - 72n && (await node.getContract(core.address, receipt.blockNumber!))!.currentContractClassId.equals(B));
  await warp(schedule[5] + 72n);
  await check('B pending C cancellation keeps non-original B past the former T', (await ctx.reader.getCoreUpgradeState()).currentClass === String(B));
  await raw(core, 'revoke_release', C);

  // This fixture alone exposes a delay setter. Production V8 has no such method.
  const { contract: fixture } = await Contract.deploy(wallet, delay, [AztecAddress.ZERO, F]).send({ from: admin, fee });
  await raw(fixture, 'approve_release', B, 0x414e535f434f5245n, 2);
  await raw(fixture, 'approve_edge_pair', F, B);
  await fixture.methods.fixture_set_protocol_delay(600n).send({ from: admin, fee });
  await raw(fixture, 'propose_upgrade', F, B);
  const proposal = (await read(fixture.address, BigInt(slots.pending), 7)).values;
  await warp(proposal[6]);
  const nonce = (await read(fixture.address, BigInt(slots.upgrade_nonce), 1)).values[0];
  await assert.rejects(raw(fixture, 'execute_upgrade', F, B), /protocol delay mismatch/);
  const after = await read(fixture.address, BigInt(slots.pending), 7);
  await check('clearly labelled delay-setter fixture rejects protocol 600 and preserves pending/nonce atomically', after.values[0] === 1n && (await read(fixture.address, BigInt(slots.upgrade_nonce), 1)).values[0] === nonce);
}
