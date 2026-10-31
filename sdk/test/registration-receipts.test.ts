import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';
import {
  createRegistrationFlow,
  ExecutionQueue,
  AnsError,
  type AnsContext,
  type RegistryReader,
  type RegistrationPlan,
  type RegistrationPlanStore,
  type RegistrationTxKind,
  type TxOptions,
  type TxUpdate,
} from '../src/index.js';

// Promoted from the independent review's 34 cases; retains its failing same-hash scenarios.
const otherKind = (kind: RegistrationTxKind): RegistrationTxKind =>
  kind === 'commitTx' ? 'registerTx' : 'commitTx';
const receipt = (status = TxStatus.CHECKPOINTED, reverted = false) => ({
  status,
  blockNumber: 12,
  hasExecutionReverted: () => reverted,
  ...(reverted ? { error: 'synthetic terminal execution revert' } : {}),
});

// All wallets, receipts, state, and persistence below are local synthetic objects.
// No RPC client, wallet implementation, signatures, or payment witness is constructed.
async function fixture(kind: RegistrationTxKind) {
  const records = new Map<string, RegistrationPlan>();
  const sent: string[] = [];
  const queried: string[] = [];
  let nextReceipt = receipt();
  const store: RegistrationPlanStore = {
    load: async (key) => records.get(key),
    save: async (key, value) => {
      records.set(key, { ...value });
    },
  };
  const reader = {
    registry: AztecAddress.fromBigIntUnsafe(12n),
    deployment: { chainId: 31337n },
    modular: false,
    snapshot: async () => ({
      timestamp: 1000n,
      blockNumber: 11,
      blockHash: 'synthetic',
      finality: 'checkpointed',
    }),
    getName: async () => ({ generation: 0, revision: 0, expiresAt: 0n, owner: AztecAddress.ZERO }),
    getCommit: async () => ({ committedAt: kind === 'registerTx' ? 900n : 0n, consumed: false }),
    getConfig: async () => ({
      feeToken: AztecAddress.ZERO,
      treasury: AztecAddress.ZERO,
      annualPrice: 0n,
      priceVersion: 1,
    }),
    node: {
      getTxReceipt: async (hash: TxHash) => {
        queried.push(hash.toString());
        return nextReceipt;
      },
    },
  } as unknown as RegistryReader;
  const interaction = {
    send: async () => {
      assert.equal(records.size, 1);
      const txHash = TxHash.random();
      sent.push(txHash.toString());
      return { txHash };
    },
  };
  const ctx = {
    reader,
    account: AztecAddress.fromBigIntUnsafe(11n),
    queue: new ExecutionQueue(),
    signer: {},
    assertWalletNetwork: async () => {},
    registrationContract: async () => ({
      methods: { commit: () => interaction, register: () => interaction },
    }),
  } as unknown as AnsContext;
  const fresh = () => {
    const flow = createRegistrationFlow(ctx, store);
    const bounded = (options: TxOptions = {}) => ({ timeoutMs: 1000, pollMs: 1, ...options });
    return {
      ...flow,
      recover: (input: RegistrationPlan, step: RegistrationTxKind, options?: TxOptions) =>
        flow.recover(input, step, bounded(options)),
      commit: (input: RegistrationPlan, options?: TxOptions) =>
        flow.commit(input, bounded(options)),
      finish: (input: RegistrationPlan, options?: TxOptions) =>
        flow.finish(input, bounded(options)),
    };
  };
  const initial = fresh();
  const quote = await initial.quote(31536000n);
  const plan = await initial.prepare({ name: 'reviewer', acceptedQuote: quote });
  const key = [...records.keys()][0];
  return {
    ctx,
    store,
    plan,
    fresh,
    sent,
    queried,
    read: () => records.get(key)!,
    save: (patch: Partial<RegistrationPlan>) => store.save(key, { ...plan, ...patch }),
    setReceipt: (value: ReturnType<typeof receipt>) => {
      nextReceipt = value;
    },
    invoke: (flow: ReturnType<typeof fresh>, input = plan, options: TxOptions = {}) =>
      kind === 'commitTx' ? flow.commit(input, options) : flow.finish(input, options),
  };
}

for (const kind of ['commitTx', 'registerTx'] as const) {
  for (const code of ['reverted', 'dropped'] as const) {
    test(`${kind} ignores a same-hash terminal error thrown by the RPC`, async () => {
      const f = await fixture(kind),
        hash = TxHash.random().toString();
      await f.save({ [kind]: hash });
      const original = f.ctx.reader.node.getTxReceipt;
      f.ctx.reader.node.getTxReceipt = async () => {
        throw new AnsError(code, 'RPC error, not a receipt', undefined, hash);
      };
      await assert.rejects(
        f.fresh().recover(f.plan, kind, { timeoutMs: 15, pollMs: 1 }),
        (e) => e instanceof AnsError && e.code === 'unknown_tx_state',
      );
      assert.equal(f.read()[kind], hash);
      f.ctx.reader.node.getTxReceipt = original;
      await f.invoke(f.fresh());
      assert.equal(f.sent.length, 0);
    });

    for (const origin of ['recover', 'send'] as const) {
      test(`${kind} ${origin} genuine ${code} receipt survives a throwing callback without swallowing it`, async (t) => {
        const f = await fixture(kind),
          opposite = TxHash.random().toString();
        await f.save({
          [otherKind(kind)]: opposite,
          ...(origin === 'recover' ? { [kind]: TxHash.random().toString() } : {}),
        });
        f.setReceipt(
          code === 'reverted' ? receipt(TxStatus.CHECKPOINTED, true) : receipt(TxStatus.DROPPED),
        );
        if (code === 'dropped') {
          let now = 0;
          t.mock.method(Date, 'now', () => (now += 7000));
        }
        const failure = new Error('observer failed after an actual terminal receipt');
        const options: TxOptions = {
          timeoutMs: 120000,
          pollMs: 1,
          onUpdate(update) {
            if (update.state === code) throw failure;
          },
        };
        const flow = f.fresh();
        await assert.rejects(
          origin === 'recover'
            ? flow.recover(f.plan, kind, options)
            : f.invoke(flow, f.plan, options),
          (e) => e === failure,
        );
        assert.equal(f.read()[kind], undefined, 'actual terminal evidence permits clearing');
        assert.equal(f.read()[otherKind(kind)], opposite);
        assert.equal(f.sent.length, origin === 'recover' ? 0 : 1);
      });
    }
  }

  test(`${kind} preserves a falsy callback exception and the submitted hash`, async () => {
    const f = await fixture(kind);
    let rejected = false;
    try {
      await f.invoke(f.fresh(), f.plan, {
        onUpdate(update) {
          if (update.state === 'submitted') throw undefined;
        },
      });
    } catch (error) {
      rejected = true;
      assert.equal(error, undefined);
    }
    assert.equal(rejected, true);
    assert.equal(f.read()[kind], f.sent[0]);
    await f.invoke(f.fresh());
    assert.equal(f.sent.length, 1);
  });

  for (const settled of ['confirmed', 'reverted', 'dropped'] as const) {
    for (const changed of ['target', 'other-step'] as const) {
      test(`${kind} delayed ${settled} recovery preserves newer ${changed} progress`, async (t) => {
        const f = await fixture(kind),
          h1 = TxHash.random().toString(),
          h2 = TxHash.random().toString();
        await f.save({ [kind]: h1 });
        let release!: (value: ReturnType<typeof receipt>) => void;
        let reading!: () => void;
        const entered = new Promise<void>((resolve) => {
          reading = resolve;
        });
        const pending = new Promise<ReturnType<typeof receipt>>((resolve) => {
          release = resolve;
        });
        const original = f.ctx.reader.node.getTxReceipt;
        f.ctx.reader.node.getTxReceipt = async () => {
          reading();
          return pending as any;
        };
        if (settled === 'dropped') {
          let now = 0;
          t.mock.method(Date, 'now', () => (now += 7000));
        }
        const flow = f.fresh();
        const recovering = flow.recover(f.plan, kind, { timeoutMs: 120000, pollMs: 1 });
        await entered;
        const newer = {
          ...f.plan,
          [kind]: h1,
          [changed === 'target' ? kind : otherKind(kind)]: h2,
          broadcastUnknown: otherKind(kind),
        };
        await f.save(newer);
        release(
          receipt(
            settled === 'dropped' ? TxStatus.DROPPED : TxStatus.CHECKPOINTED,
            settled === 'reverted',
          ),
        );
        if (settled === 'confirmed') await recovering;
        else await assert.rejects(recovering, (e) => e instanceof AnsError && e.code === settled);
        assert.equal(
          f.read()[kind],
          changed === 'target' ? h2 : settled === 'confirmed' ? h1 : undefined,
        );
        assert.equal(f.read()[otherKind(kind)], changed === 'other-step' ? h2 : undefined);
        assert.equal(f.read().broadcastUnknown, otherKind(kind));
        assert.equal(f.sent.length, 0);
        if (changed === 'target') {
          t.mock.restoreAll();
          f.ctx.reader.node.getTxReceipt = original;
          // The same flow must stop preferring its old in-memory h1 as well.
          await flow.recover(f.plan, kind);
          assert.deepEqual(f.queried, [h2]);
        }
      });
    }
  }
}

test('receipt outcomes remain internal while the public throwing API stays available', async () => {
  const api = await import('../src/index.js');
  for (const name of [
    'runTxOutcome',
    'trackTxOutcome',
    'unwrapTxOutcome',
    'submitCommitOutcome',
    'submitRegistrationOutcome',
  ])
    assert.equal(name in api, false, name);
  assert.equal(typeof api.trackTx, 'function');
  assert.equal(typeof api.runTx, 'function');
});

for (const kind of ['commitTx', 'registerTx'] as const) {
  for (const scenario of [
    'ordinary',
    'terminal-without-hash',
    'stale-hash',
    'opposite-step-hash',
  ]) {
    test(`CONTROL ${kind} preserves both hashes for ${scenario} observer error`, async () => {
      const f = await fixture(kind);
      const hash = TxHash.random().toString(),
        opposite = TxHash.random().toString();
      await f.save({ [kind]: hash, [otherKind(kind)]: opposite });
      const failure =
        scenario === 'ordinary'
          ? new Error('observer')
          : new AnsError(
              'reverted',
              'observer',
              undefined,
              scenario === 'terminal-without-hash'
                ? undefined
                : scenario === 'opposite-step-hash'
                  ? opposite
                  : TxHash.random().toString(),
            );
      f.setReceipt(receipt(TxStatus.PROPOSED));
      await assert.rejects(
        f.fresh().recover(f.plan, kind, {
          onUpdate() {
            throw failure;
          },
        }),
        (e) => e === failure,
      );
      assert.equal(f.read()[kind], hash);
      assert.equal(f.read()[otherKind(kind)], opposite);
      f.setReceipt(receipt());
      await f.invoke(f.fresh());
      assert.equal(f.sent.length, 0);
    });
  }

  test(`CONTROL ${kind} stale caller recovers durable current hash`, async () => {
    const f = await fixture(kind);
    const latest = TxHash.random().toString(),
      stale = TxHash.random().toString();
    await f.save({ [kind]: latest });
    await f.fresh().recover({ ...f.plan, [kind]: stale }, kind);
    assert.deepEqual(f.queried, [latest]);
    assert.equal(f.read()[kind], latest);
    assert.equal(f.sent.length, 0);
  });

  test(`CONTROL ${kind} missing step never substitutes other-step hash`, async () => {
    const f = await fixture(kind);
    const opposite = TxHash.random().toString();
    await f.save({ [otherKind(kind)]: opposite });
    await assert.rejects(
      f.fresh().recover(f.plan, kind),
      (e) => e instanceof AnsError && e.code === 'unknown_tx_state',
    );
    assert.equal(f.read()[otherKind(kind)], opposite);
    assert.equal(f.queried.length, 0);
    assert.equal(f.sent.length, 0);
  });

  for (const stage of ['submitted', 'included']) {
    test(`CONTROL ${kind} first-send ${stage} ordinary observer error permits recovery only`, async () => {
      const f = await fixture(kind);
      const failure = new Error('observer');
      f.setReceipt(receipt(TxStatus.PROPOSED));
      await assert.rejects(
        f.invoke(f.fresh(), f.plan, {
          onUpdate(u) {
            if (u.state === stage) throw failure;
          },
        }),
        (e) => e === failure,
      );
      assert.equal(f.read()[kind], f.sent[0]);
      assert.equal(f.sent.length, 1);
      f.setReceipt(receipt());
      const reloaded = f.fresh();
      await Promise.all([f.invoke(reloaded), f.invoke(reloaded)]);
      assert.equal(f.sent.length, 1);
    });
  }

  test(`CONTROL ${kind} terminal reverted receipt clears only target then one queued retry sends`, async () => {
    const f = await fixture(kind);
    const hash = TxHash.random().toString(),
      opposite = TxHash.random().toString();
    await f.save({ [kind]: hash, [otherKind(kind)]: opposite });
    f.setReceipt(receipt(TxStatus.CHECKPOINTED, true));
    const updates: TxUpdate[] = [];
    await assert.rejects(
      f.fresh().recover(f.plan, kind, { onUpdate: (u) => updates.push(u) }),
      (e) =>
        e instanceof AnsError &&
        e.code === 'reverted' &&
        e.txHash === hash &&
        e === updates[0].error,
    );
    assert.equal(updates[0].state, 'reverted');
    assert.equal(f.read()[kind], undefined);
    assert.equal(f.read()[otherKind(kind)], opposite);
    assert.equal(f.sent.length, 0);
    f.setReceipt(receipt());
    const reloaded = f.fresh();
    await Promise.all([f.invoke(reloaded), f.invoke(reloaded)]);
    assert.equal(f.sent.length, 1);
  });

  test(`CONTROL ${kind} terminal dropped receipt clears only target without sending`, async (t) => {
    const f = await fixture(kind);
    const hash = TxHash.random().toString(),
      opposite = TxHash.random().toString();
    await f.save({ [kind]: hash, [otherKind(kind)]: opposite });
    f.setReceipt(receipt(TxStatus.DROPPED));
    let now = 0;
    t.mock.method(Date, 'now', () => (now += 7000));
    await assert.rejects(
      f.fresh().recover(f.plan, kind, { timeoutMs: 120000, pollMs: 1 }),
      (e) => e instanceof AnsError && e.code === 'dropped' && e.txHash === hash,
    );
    assert.equal(f.read()[kind], undefined);
    assert.equal(f.read()[otherKind(kind)], opposite);
    assert.equal(f.sent.length, 0);
  });

  test(`CONTROL ${kind} RPC timeout retains hash and retry only tracks`, async () => {
    const f = await fixture(kind);
    const hash = TxHash.random().toString();
    await f.save({ [kind]: hash });
    const original = f.ctx.reader.node.getTxReceipt;
    f.ctx.reader.node.getTxReceipt = async () => {
      throw new Error('offline');
    };
    await assert.rejects(
      f.fresh().recover(f.plan, kind, { timeoutMs: 15, pollMs: 1 }),
      (e) => e instanceof AnsError && e.code === 'unknown_tx_state' && e.txHash === hash,
    );
    assert.equal(f.read()[kind], hash);
    f.ctx.reader.node.getTxReceipt = original;
    await f.invoke(f.fresh());
    assert.equal(f.sent.length, 0);
  });

  for (const code of ['reverted', 'dropped'] as const) {
    for (const origin of ['recover', 'send-submitted', 'send-included']) {
      test(`REGRESSION ${kind} ${origin} same-hash ${code} observer must not erase hash or resend`, async () => {
        const f = await fixture(kind);
        let trackedHash: string | undefined;
        if (origin === 'recover') {
          trackedHash = TxHash.random().toString();
          await f.save({ [kind]: trackedHash });
        }
        f.setReceipt(receipt(TxStatus.PROPOSED, false));
        const options: TxOptions = {
          onUpdate(u) {
            if (u.state === (origin === 'send-submitted' ? 'submitted' : 'included')) {
              trackedHash = u.txHash;
              throw new AnsError(
                code,
                'observer has no terminal receipt evidence',
                undefined,
                u.txHash,
              );
            }
          },
        };
        const flow = f.fresh();
        await assert.rejects(
          origin === 'recover'
            ? flow.recover(f.plan, kind, options)
            : f.invoke(flow, f.plan, options),
          (e) => e instanceof AnsError && e.code === code && e.txHash === trackedHash,
        );
        const preserved = f.read()[kind] === trackedHash;
        const beforeRetry = f.sent.length;
        const readsBeforeRetry = f.queried.length;
        f.setReceipt(receipt());
        const reloaded = f.fresh();
        await Promise.all([f.invoke(reloaded), f.invoke(reloaded)]);
        const observation = {
          kind,
          origin,
          code,
          receipt: 'PROPOSED; hasExecutionReverted=false',
          readsBeforeRetry,
          hashPreserved: preserved,
          sendsBeforeRetry: beforeRetry,
          sendsAfterRetry: f.sent.length,
          additionalSends: f.sent.length - beforeRetry,
        };
        assert.deepEqual(
          { hashPreserved: preserved, additionalSends: observation.additionalSends },
          { hashPreserved: true, additionalSends: 0 },
          'Observer failure must not authorize a replacement transaction',
        );
      });
    }
  }
}
