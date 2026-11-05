import assert from "node:assert/strict";
import { test } from "node:test";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import {
  AnsError, checkRegistration, prepareRegistration, submitCommit, submitRegistration,
  type AnsContext, type RegistryReader,
} from "../src/index.js";

async function fixture() {
  const registry = AztecAddress.fromBigIntUnsafe(2n);
  const account = AztecAddress.fromBigIntUnsafe(1n);
  const snapshot = { timestamp: 1000n, blockNumber: 10, blockHash: "block-10", finality: "checkpointed" };
  const commit = { committedAt: 900n, consumed: false };
  const reader = {
    registry, deployment: { chainId: 31337n },
    snapshot: async () => snapshot,
    getName: async () => ({ generation: 0, revision: 0, expiresAt: 0n, owner: AztecAddress.ZERO }),
    getCommit: async () => commit,
    getConfig: async () => ({ feeToken: AztecAddress.ZERO, treasury: AztecAddress.ZERO, annualPrice: 0n, priceVersion: 1 }),
  } as unknown as RegistryReader;
  const ctx = { reader, account, contract: () => { throw new Error("must not invoke wallet"); } } as unknown as AnsContext;
  const plan = await prepareRegistration(ctx, { name: "alice", duration: 31536000n });
  return { reader, ctx, plan, commit, snapshot };
}

test("registration rejects another deployment before reading chain state", async () => {
  const { reader, plan } = await fixture();
  reader.snapshot = async () => { throw new Error("must not read wrong chain"); };
  await assert.rejects(checkRegistration(reader, { ...plan, chainId: 1n }),
    (e: AnsError) => e.code === "wrong_deployment");
});

test("a corrupted plan cannot be committed or shown as registered", async () => {
  const { reader, ctx, plan, commit } = await fixture();
  commit.consumed = true;
  for (const changed of [
    { ...plan, node: plan.node + 1n },
    { ...plan, label: "bob" },
    { ...plan, maxFee: 1n },
    { ...plan, commitment: plan.commitment + 1n },
  ]) {
    await assert.rejects(checkRegistration(reader, changed), (e: AnsError) => e.code === "corrupt_data");
    await assert.rejects(submitCommit(ctx, changed), (e: AnsError) => e.code === "corrupt_data");
  }
});

test("an uncommitted plan still expires, while a consumed plan remains completed", async () => {
  const { reader, ctx, plan, commit, snapshot } = await fixture();
  commit.committedAt = 0n;
  snapshot.timestamp = plan.quoteExpiry + 1n;
  assert.equal((await checkRegistration(reader, plan)).state, "quote_expired");
  await assert.rejects(submitCommit(ctx, plan), (e: AnsError) => e.code === "quote_expired");
  commit.consumed = true;
  assert.equal((await checkRegistration(reader, plan)).state, "registered");
});

test("a known registration transaction must be checked before a second payment attempt", async () => {
  const { ctx, plan } = await fixture();
  await assert.rejects(submitRegistration(ctx, { ...plan, registerTx: "known-hash" }),
    (e: AnsError) => e.code === "unknown_tx_state" && e.txHash === "known-hash");
});

test("fee data outside the commitment is checked before asking the wallet for authorization", async () => {
  const { ctx } = await fixture();
  const plan = await prepareRegistration(ctx, { name: "alice", duration: 31536000n, maxFee: 1n });
  await assert.rejects(submitRegistration(ctx, { ...plan, fee: 1n }),
    (e: AnsError) => e.code === "corrupt_data");
});

test('L-03 commit at quote expiry minus 90 is rejected before wallet submission', async () => {
  const { ctx, plan, snapshot } = await fixture();
  snapshot.timestamp = plan.quoteExpiry - 90n;
  await assert.rejects(submitCommit(ctx, plan), (e: AnsError) => e.code === 'quote_expired');
});

test('L-03 exactly 300 seconds permits commit and remains revealable after the minimum age', async () => {
  const { ctx, reader, plan, commit, snapshot } = await fixture();
  const { TxHash, TxStatus } = await import('@aztec-labs/aztec.js/tx');
  const hash = TxHash.random(); let sends = 0;
  Object.assign(ctx, {
    signer: {}, queue: { run: async (fn: () => unknown) => fn() }, assertWalletNetwork: async () => {},
    registrationContract: async () => ({ methods: { commit: () => ({ send: async () => { sends++; return { txHash: hash }; } }) } }),
  });
  Object.assign(reader, { node: { getTxReceipt: async () => ({ status: TxStatus.CHECKPOINTED, blockNumber: 10, hasExecutionReverted: () => false }) } });
  snapshot.timestamp = plan.quoteExpiry - 300n;
  await submitCommit(ctx, plan);
  assert.equal(sends, 1);
  commit.committedAt = snapshot.timestamp;
  snapshot.timestamp += 60n;
  assert.equal((await checkRegistration(reader, plan)).state, 'ready_to_register');
});

test('L-03 audit boundary: an old commit made at expiry minus 90 cannot reveal 60 seconds later', async () => {
  const { reader, plan, commit, snapshot } = await fixture();
  commit.committedAt = plan.quoteExpiry - 90n;
  snapshot.timestamp = commit.committedAt + 60n;
  assert.equal((await checkRegistration(reader, plan)).state, 'quote_expired');
});

test('L-03 plan creation rejects insufficient quote lifetime and accepts exactly 300 seconds', async () => {
  const { ctx } = await fixture();
  await assert.rejects(prepareRegistration(ctx, { name: 'alice', duration: 31536000n, quoteValiditySeconds: 299n }), (e: AnsError) => e.code === 'quote_expired');
  const plan = await prepareRegistration(ctx, { name: 'alice', duration: 31536000n, quoteValiditySeconds: 300n });
  assert.equal(plan.quoteExpiry, 1300n);
});

for (const remaining of [179n, 180n, 299n]) {
  test(`L-03 commit with ${remaining} seconds left is rejected before wallet submission`, async () => {
    const { ctx, plan, snapshot } = await fixture();
    snapshot.timestamp = plan.quoteExpiry - remaining;
    await assert.rejects(submitCommit(ctx, plan), (e: AnsError) => e.code === 'quote_expired');
    await assert.rejects(prepareRegistration(ctx, { name: 'alice', duration: 31536000n, quoteValiditySeconds: remaining }), (e: AnsError) => e.code === 'quote_expired');
  });
}
