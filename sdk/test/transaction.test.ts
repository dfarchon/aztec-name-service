import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnsError, runTx, trackTx, type AnsContext, type TxUpdate } from '../src/index.js';
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { NameRegistrarTieredContract } from '../src/artifacts/NameRegistrarTiered.js';
import { normalizeName, nodeOf, renew } from '../src/index.js';

const hash = TxHash.random().toString();
const nodeWithReceipt = (statuses: string[], reverted = false) => {
  let i = 0;
  return { getTxReceipt: async () => ({
    status: statuses[Math.min(i++, statuses.length - 1)],
    blockNumber: 10,
    hasExecutionReverted: () => reverted,
  }) } as unknown as AztecNode;
};

for (const [kind, classInstance] of [
  ['registrar', false],
  ['registrarTiered', true],
  ['registrarTiered', false],
  ['registry', false],
] as const) {
  test(`renew arguments: ${kind}, ${classInstance ? 'class instance' : 'generic object'}`, async (t) => {
    const account = AztecAddress.fromBigIntUnsafe(1n);
    const registrar = AztecAddress.fromBigIntUnsafe(2n);
    const label = normalizeName('alice');
    const duration = 31536000n;
    const generation = 3, revision = 4;
    const snapshot = { timestamp: 100n };
    const config = {
      registrar: kind === 'registry' ? undefined : registrar,
      feeToken: AztecAddress.ZERO, treasury: account, annualPrice: 0n, priceVersion: 1,
      ...(kind === 'registrarTiered' ? { lengthPrices: { three: 0n, four: 0n } } : {}),
    };
    const call = t.mock.fn(() => ({ send: async () => ({ txHash: hash }) }));
    // A prototype-backed instance exercises the old instanceof branch without a wallet.
    // The generic object matches the shape returned by the generated .at() wrapper.
    const contract = Object.assign(classInstance ? Object.create(NameRegistrarTieredContract.prototype) : {}, {
      methods: { renew: call },
    });
    assert.equal(contract instanceof NameRegistrarTieredContract, classInstance);
    const select = t.mock.fn(async (expected?: string) => {
      assert.equal(expected, config.registrar?.toString());
      return { kind, contract };
    });
    const ctx = {
      account, signer: {}, queue: { run: (f: () => Promise<unknown>) => f() },
      assertWalletNetwork: async () => {}, ensureRegistered: async () => {},
      reader: {
        modular: kind !== 'registry', node: nodeWithReceipt([TxStatus.CHECKPOINTED]),
        snapshot: async () => snapshot, getConfig: async () => config,
        getName: async () => ({ owner: account, generation, revision, expiresAt: 1000n }),
        getPublishedLabel: async () => ({ present: true }),
      },
      registrationTarget: select,
      registrationContract: async (expected?: string) => (await select(expected)).contract,
    } as unknown as AnsContext;
    const { quote } = await renew(ctx, { name: label, duration });
    assert.equal(select.mock.callCount(), 1);
    assert.equal(call.mock.callCount(), 1);
    const args = call.mock.calls[0].arguments as unknown[];
    assert.equal(args.length, kind === 'registrarTiered' ? 8 : 7);
    const prefix = kind === 'registrarTiered' ? [label.bytes, label.len] : [await nodeOf(label)];
    assert.deepEqual(args.slice(0, -1), [...prefix, generation, revision, duration, quote.maxFee, quote.quoteExpiry]);
    assert.equal(typeof args.at(-1), 'bigint');
  });
}

test('unknown receipt statuses never count as a successful transaction', async () => {
  const updates: TxUpdate[] = [];
  await assert.rejects(trackTx(nodeWithReceipt(['unexpected-status']), hash, {
    timeoutMs: 10, pollMs: 1, onUpdate: u => updates.push(u),
  }), (e: AnsError) => e.code === 'unknown_tx_state' && e.txHash === hash);
  assert.ok(!updates.some(u => ['included', 'confirmed', 'proven'].includes(u.state)));
});

test('tracking detects reorgs, then resumes confirmation without resending', async () => {
  const updates: TxUpdate[] = [];
  const result = await trackTx(nodeWithReceipt([TxStatus.PROPOSED, TxStatus.PENDING, TxStatus.CHECKPOINTED]), hash, {
    timeoutMs: 1000, pollMs: 1, onUpdate: u => updates.push(u),
  });
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(updates.map(u => u.state), ['included', 'reorged', 'confirmed']);
});

test('a transaction removed after a reorg eventually becomes dropped instead of waiting forever', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 7000));
  await assert.rejects(trackTx(nodeWithReceipt([TxStatus.PROPOSED, TxStatus.DROPPED]), hash, {
    timeoutMs: 120000, pollMs: 1,
  }), (e: AnsError) => e.code === 'dropped' && e.txHash === hash);
});

test('mined execution reverts are failures at every finality level', async () => {
  for (const status of [TxStatus.PROPOSED, TxStatus.CHECKPOINTED, TxStatus.PROVEN, TxStatus.FINALIZED]) {
    await assert.rejects(trackTx(nodeWithReceipt([status], true), hash),
      (e: AnsError) => e.code === 'reverted' && e.txHash === hash);
  }
  assert.equal((await trackTx(nodeWithReceipt([TxStatus.FINALIZED]), hash, { waitFor: 'proven' })).state, 'proven');
});

test('a wallet transport failure cannot be reported as a reverted transaction', async () => {
  const updates: TxUpdate[] = [];
  const ctx = { reader: { modular: false }, account: {}, signer: {}, assertWalletNetwork: async () => {}, queue: {run: (f: () => Promise<unknown>) => f()} } as unknown as AnsContext;
  const interaction = { send: async () => { throw new AnsError('network', 'fetch failed', undefined, 'known-hash'); } } as unknown as ContractFunctionInteraction;
  await assert.rejects(runTx(ctx, interaction, { onUpdate: u => updates.push(u) }), /fetch failed/);
  assert.equal(updates.at(-1)?.state, 'unknown');
  assert.equal(updates.at(-1)?.txHash, 'known-hash');
});

test('wallet rejection is cancellation rather than an unknown broadcast', async () => {
  const updates: TxUpdate[] = [];
  const ctx = { reader: { modular: false }, account: {}, signer: {}, assertWalletNetwork: async () => {}, queue: {run: (f: () => Promise<unknown>) => f()} } as unknown as AnsContext;
  const interaction = { send: async () => { throw new Error('User rejected the request'); } } as unknown as ContractFunctionInteraction;
  await assert.rejects(runTx(ctx, interaction, { onUpdate: u => updates.push(u) }));
  assert.equal(updates.at(-1)?.state, 'cancelled');
});

test('an optional preflight transport failure cannot imply an unknown broadcast before send', async () => {
  let sends = 0;
  const updates: TxUpdate[] = [];
  const ctx = { reader: { modular: false }, account: {}, signer: {}, assertWalletNetwork: async () => {}, queue: {run: (f: () => Promise<unknown>) => f()} } as unknown as AnsContext;
  const interaction = {
    simulate: async () => { throw new AnsError('network', 'simulation unavailable'); },
    send: async () => { sends++; throw new Error('must not send'); },
  } as unknown as ContractFunctionInteraction;
  await assert.rejects(runTx(ctx, interaction, { preflight: true, onUpdate: u => updates.push(u) }),
    (e: AnsError) => e.code === 'network');
  assert.equal(sends, 0);
  assert.ok(!updates.some(u => u.state === 'unknown' || u.state === 'submitted'));
});


test('modular writes refresh wallet metadata and fail closed before signing an unknown upgrade', async () => {
  let sends=0, refreshes=0;
  const ctx={account:{},signer:{},reader:{modular:true,node:nodeWithReceipt([TxStatus.CHECKPOINTED])},queue:{run:(f:()=>Promise<unknown>)=>f()},ensureRegistered:async()=>{refreshes++;}} as unknown as AnsContext;
  const interaction={send:async()=>{sends++;assert.equal(refreshes,1);return {txHash:hash};}} as unknown as ContractFunctionInteraction;
  await runTx(ctx,interaction);assert.equal(sends,1);
  ctx.ensureRegistered=async()=>{throw new AnsError('wrong_deployment','unsupported class');};
  await assert.rejects(runTx(ctx,interaction),(e:AnsError)=>e.code==='wrong_deployment');assert.equal(sends,1);
});

test('a wallet that disconnects mid-send reports an unknown broadcast, not a revert', async () => {
  const updates: TxUpdate[] = [];
  const ctx = { reader: { modular: false }, account: {}, signer: {}, assertWalletNetwork: async () => {}, queue: {run: (f: () => Promise<unknown>) => f()} } as unknown as AnsContext;
  const interaction = { send: async () => { throw new Error('Wallet disconnected'); } } as unknown as ContractFunctionInteraction;
  await assert.rejects(runTx(ctx, interaction, { onUpdate: u => updates.push(u) }), (e: AnsError) => e.code === 'unknown_tx_state');
  assert.equal(updates.at(-1)?.state, 'unknown');
});

test('wallet simulation and contract failures before broadcast remain plain failures', async () => {
  class SimulationError extends Error {}
  const ctx = { reader: { modular: false }, account: {}, signer: {}, assertWalletNetwork: async () => {}, queue: {run: (f: () => Promise<unknown>) => f()} } as unknown as AnsContext;
  for (const thrown of [new SimulationError('Balance of 1 below 2'), new Error('Assertion failed: Balance too low'), new Error('name not available')]) {
    const updates: TxUpdate[] = [];
    const interaction = { send: async () => { throw thrown; } } as unknown as ContractFunctionInteraction;
    await assert.rejects(runTx(ctx, interaction, { onUpdate: u => updates.push(u) }), (e: AnsError) => e.code !== 'unknown_tx_state');
    assert.equal(updates.at(-1)?.state, 'reverted');
  }
});

const taggedReadError = () => new Error('Request timeout on the free plan', {
  cause: { code: 30, message: 'Request timeout on the free plan', rpcMethods: ['aztec_getPublicDataWitness'] },
});
async function failedSend(error: unknown) {
  const updates: TxUpdate[] = [];
  const ctx = { reader: { modular: false }, account: {}, signer: {}, assertWalletNetwork: async () => {}, queue: { run: (fn: () => Promise<unknown>) => fn() } } as unknown as AnsContext;
  const interaction = { send: async () => { throw error; } } as unknown as ContractFunctionInteraction;
  await assert.rejects(runTx(ctx, interaction, { onUpdate: (u) => updates.push(u) }), (e: AnsError) => e.code === 'network');
  return updates;
}
test('runTx: a node read failure tagged without aztec_sendTx is a retryable network error, not unknown', async () => {
  assert.ok(!(await failedSend(taggedReadError())).some((u) => u.state === 'unknown'));
});
test('runTx: a failure whose request carried aztec_sendTx stays unknown', async () => {
  const error = new Error('Failed to fetch', { cause: { data: { rpcMethods: ['aztec_getBlockNumber', 'aztec_sendTx'] } } });
  assert.ok((await failedSend(error)).some((u) => u.state === 'unknown'));
});
test('runTx: an untagged network failure stays unknown', async () => {
  assert.ok((await failedSend(new TypeError('Failed to fetch'))).some((u) => u.state === 'unknown'));
});
test('runTx: all nested markers must be nonempty reads, including cyclic aggregate errors', async () => {
  for (const rpcMethods of [[], ['aztec_sendTx'], [null]]) {
    const error = taggedReadError();
    Object.assign(error.cause!, { data: { errors: [error, { rpcMethods }] } });
    assert.ok((await failedSend(error)).some((u) => u.state === 'unknown'));
  }
  const error = new Error('Failed to fetch');
  Object.assign(error, { errors: [error, taggedReadError()] });
  assert.ok(!(await failedSend(error)).some((u) => u.state === 'unknown'));
});

test('host beforeSend validation runs inside shared queue after identity and cannot mark unknown broadcast', async () => {
  const order: string[] = [], updates: TxUpdate[] = [];
  const failure = new Error('Fee Juice validation failed');
  const ctx = {
    account: AztecAddress.fromBigIntUnsafe(1n),
    signer: { beforeSend: async (account: AztecAddress) => { assert.equal(account.toBigInt(), 1n); order.push('fee-check'); throw failure; } },
    reader: { modular: false },
    assertWalletNetwork: async () => { order.push('identity'); },
    queue: { run: async (f: () => Promise<unknown>) => { order.push('queue'); return f(); } },
  } as unknown as AnsContext;
  const call = { send: async () => { order.push('send'); throw new Error('must not send'); } } as unknown as ContractFunctionInteraction;
  await assert.rejects(runTx(ctx, call, { onUpdate: u => updates.push(u) }), (e: AnsError) => e.cause === failure);
  assert.deepEqual(order, ['queue', 'identity', 'fee-check']);
  assert.equal(updates.length, 0);
});
