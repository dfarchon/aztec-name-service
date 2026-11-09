/** Actual independent V8 reads plus wrong-network wallet fixtures. No wallet keys or transactions. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AnsContext, RegistryReader, prepareRegistration, createRegistrationFlow, type RegistrationPlan } from '@ans/sdk';
const url = process.env.NODE_URL ?? 'http://127.0.0.1:8082';
assert.equal(new URL(url).hostname, '127.0.0.1');
assert(process.env.ANS_V8_LOCAL_PUBLIC_STATE, 'explicit local public-state path required');
const publicState = JSON.parse(await readFile(process.env.ANS_V8_LOCAL_PUBLIC_STATE, 'utf8'));
const node = createAztecNodeClient(url), info = await node.getNodeInfo();
assert.equal(info.realProofs, false); assert.equal(Number(info.l1ChainId), 31337);
const reader = await RegistryReader.connect(node, AztecAddress.fromStringUnsafe(publicState.registry), { allowRehearsalSuccessor: true });
let count = 0;
for (const wrong of ['chain', 'rollup'] as const) {
  let registrations = 0, sends = 0, stored: RegistrationPlan | undefined;
  const wallet = {
    getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId + (wrong === 'chain' ? 1n : 0n) }, version: { toBigInt: () => reader.deployment.rollupVersion + (wrong === 'rollup' ? 1n : 0n) } }),
    registerContract: async () => { registrations++; }, sendTx: async () => { sends++; throw new Error('must never send'); },
  } as unknown as Wallet;
  const ctx = new AnsContext(reader, { wallet, account: AztecAddress.fromStringUnsafe(publicState.administrator) });
  const plan = await prepareRegistration(ctx, { name: `wrong-${wrong}-v8`, duration: 31536000n });
  const flow = createRegistrationFlow(ctx, { load: async () => stored, save: async (_key, value) => { stored = structuredClone(value); } });
  await assert.rejects(flow.commit(plan), (error: any) => error.code === 'wrong_deployment');
  assert.equal(registrations, 0); assert.equal(sends, 0);
  console.log(`PASS ${++count}: actual V8 ${wrong} mismatch rejects before artifact registration and send`);
  assert(!stored?.commitTx && !stored?.broadcastUnknown);
  console.log(`PASS ${++count}: ${wrong} mismatch leaves registration recovery retryable without unknown-broadcast marker`);
}
console.log(`ALL ${count} V8 WRONG-NETWORK CHECKS PASSED; no broadcasts`);
