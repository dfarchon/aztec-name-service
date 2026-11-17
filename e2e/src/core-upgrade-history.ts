/** Read-only, receipt-block history verification of every observed name and primary at actual class boundaries. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { BlockNumber } from '@aztec-labs/aztec.js/fields';
import { getPublicEvents } from '@aztec-labs/aztec.js/events';
import { RegistryReader, type Snapshot } from '@ans/sdk/read';
import { NameRegistryV8Contract } from '@ans/sdk/contracts/v8';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
const url = process.env.NODE_URL ?? 'http://127.0.0.1:8082'; assert.equal(new URL(url).hostname, '127.0.0.1');
assert(process.env.ANS_V8_LOCAL_PUBLIC_STATE);
const addresses = JSON.parse(await readFile(process.env.ANS_V8_LOCAL_PUBLIC_STATE, 'utf8'));
const node = createAztecNodeClient(url, { maxBatchSize: 20 }), info = await node.getNodeInfo(); assert.equal(info.realProofs, false); assert.equal(Number(info.l1ChainId), 31337);
const registry = AztecAddress.fromStringUnsafe(addresses.registry), reader = await RegistryReader.connect(node, registry, { allowRehearsalSuccessor: true });
const tip = await reader.snapshot();
const eventRange = { contractAddress: registry, fromBlock: BlockNumber(1), toBlock: BlockNumber(tip.blockNumber + 1) };
const [registered, children, primary] = await Promise.all([
  getPublicEvents<{ node: bigint }>(node, NameRegistryV8Contract.events.NameRegisteredV3, eventRange),
  getPublicEvents<{ node: bigint }>(node, NameRegistryV8Contract.events.SubnameIssued, eventRange),
  getPublicEvents<{ address: AztecAddress }>(node, NameRegistryV8Contract.events.PrimaryChangedV3, eventRange),
]);
assert(!registered.nextCursor && !children.nextCursor && !primary.nextCursor, 'bounded local history must be complete');
const ids = [...new Set([...registered.events, ...children.events].map(row => String(row.event.node)))].map(BigInt).sort((a, b) => a < b ? -1 : 1);
const accounts = [...new Map(primary.events.map(row => [String(row.event.address), row.event.address])).values()].sort((a, b) => String(a).localeCompare(String(b)));
assert(ids.length >= 5 && accounts.length >= 2, 'include admin mint, B registration, child and both primary accounts');
const timeline: { snapshot: Snapshot; classId: string }[] = [];
for (let start = 1; start <= tip.blockNumber; start += 20) {
  const rows = await Promise.all(Array.from({ length: Math.min(20, tip.blockNumber - start + 1) }, async (_, offset) => {
    const number = BlockNumber(start + offset), header = await node.getBlockData(number); assert(header);
    const instance = await node.getContract(registry, number); if (!instance) return;
    return { classId: String(instance.currentContractClassId), snapshot: { blockNumber: Number(number), blockHash: String(header.blockHash), timestamp: BigInt(header.header.globalVariables.timestamp), finality: 'proposed' as const } };
  }));
  timeline.push(...rows.filter((row): row is NonNullable<typeof row> => !!row));
}
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item);
const snapshot = async (s: Snapshot) => {
  const upgrade = await reader.getCoreUpgradeState(s);
  const names = await Promise.all(ids.map(async id => {
    const name = await reader.getName(id, s), generation = name.generation;
    return { node: String(id), name, address: await reader.getAddress(id, generation, s), revision: await reader.getRecordRevision(id, generation, s), parent: await reader.getParent(id, s), published: await reader.getPublishedLabel(id, s), manager: await reader.getManager(id, generation, s), transfer: await reader.getTransfer(id, generation, s), text: await reader.getTextRecords(id, generation, s) };
  }));
  const primaries = await Promise.all(accounts.map(async account => ({ account: String(account), record: await reader.getPrimary(account, s) })));
  const modules = await reader.getModules(s); assert(await reader.isCanonical(s));
  return { snapshot: s, upgrade, business: { names, primaries, modules } };
};
const boundaries = [];
for (let i = 1; i < timeline.length; i++) {
  const previous = timeline[i - 1], current = timeline[i]; if (previous.classId === current.classId) continue;
  assert([metadata.v8.classId, metadata.v8Rehearsal.classId].includes(previous.classId) && [metadata.v8.classId, metadata.v8Rehearsal.classId].includes(current.classId), 'no unreviewed active class history');
  const [before, after] = await Promise.all([snapshot(previous.snapshot), snapshot(current.snapshot)]);
  assert.equal(json(before.business), json(after.business), 'every observed business record is unchanged at class activation');
  assert(before.snapshot.timestamp < after.upgrade.protocol.activationAt && after.snapshot.timestamp >= after.upgrade.protocol.activationAt, 'protocol activation is bracketed by actual canonical class samples');
  if (previous.classId === metadata.v8.classId) {
    assert.equal(after.snapshot.timestamp, after.upgrade.protocol.activationAt, 'forward activation has included evidence at exact T');
    assert.equal(before.snapshot.timestamp, after.snapshot.timestamp - 72n, 'forward preceding included sample is exact T-72');
  }
  boundaries.push({ before, after });
  console.log(`PASS ${boundaries.length}: actual ${previous.classId} -> ${current.classId} preserves ${ids.length} observed names and ${accounts.length} primary records, including B-created registration and B primary writes`);
}
assert.equal(boundaries.length, 2, 'one actual forward activation and one actual compatible rollback');
if (process.env.ANS_V8_LOCAL_HISTORY_EVIDENCE) await writeFile(process.env.ANS_V8_LOCAL_HISTORY_EVIDENCE, json({ realProofs: false, observedNames: ids.length, primaryAccounts: accounts.length, boundaries }) + '\n', { mode: 0o600 });
console.log('ALL 2 V8 FULL HISTORY SNAPSHOT CHECKS PASSED; read-only follow-up, no transactions');
