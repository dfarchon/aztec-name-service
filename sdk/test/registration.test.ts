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
