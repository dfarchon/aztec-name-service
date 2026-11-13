import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { TokenContract } from '@aztec-labs/noir-contracts.js/Token';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import {
  AnsContext,
  AnsError,
  createRegistrationFlow,
  ExecutionQueue,
  FEE_TOKEN_CLASS_ID,
  getPrivateFeeBalance,
  connectAns,
  type RegistrationPlan,
  type RegistryReader,
  type RegistrationPlanStore,
} from '../src/index.js';

test('connection rejects unauthorized accounts and mismatched sponsor classes before registering artifacts', async () => {
  const account = AztecAddress.fromBigIntUnsafe(1n),
    registry = AztecAddress.fromBigIntUnsafe(2n);
  let registrations = 0,
    accounts = [{ item: account, alias: 'Authorized' }];
  const reader = {
    registry,
    deployment: { chainId: 31337n, rollupVersion: 1n },
    node: { getContract: async () => ({ currentContractClassId: Fr.ZERO }) },
  } as unknown as RegistryReader;
  const wallet = {
    getChainInfo: async () => ({ chainId: new Fr(31337), version: new Fr(1) }),
    getAccounts: async () => accounts,
    registerContract: async () => {
      registrations++;
    },
  } as unknown as Wallet;
  const options = {
    wallet,
    account,
    deployment: { registry: registry.toString(), chainId: '31337', rollupVersion: '1' },
    sponsoredFpc: AztecAddress.fromBigIntUnsafe(3n),
  };
  accounts = [];
  await assert.rejects(connectAns(reader, options), (e: AnsError) => e.code === 'invalid_argument');
  accounts = [{ item: account, alias: 'Authorized' }];
  await assert.rejects(connectAns(reader, options), (e: AnsError) => e.code === 'wrong_deployment');
  assert.equal(registrations, 0);
});

test('automatic private fee reads register a newly selected token and reject an unknown class before wallet use', async (t) => {
  assert.equal(
    FEE_TOKEN_CLASS_ID,
    (await getContractClassFromArtifact(TokenContract.artifact)).id.toString(),
  );
  const old = AztecAddress.fromBigIntUnsafe(1n),
    next = AztecAddress.fromBigIntUnsafe(2n);
  const registered = new Set([old.toString()]);
  let classId = Fr.fromString(FEE_TOKEN_CLASS_ID),
    reads = 0;
  const reader = {
    deployment: { chainId: 31337n, rollupVersion: 1n },
    node: {
      getContract: async (address: AztecAddress) => ({ address, currentContractClassId: classId }),
    },
  } as unknown as RegistryReader;
  const wallet = {
    getChainInfo: async () => ({ chainId: new Fr(31337), version: new Fr(1) }),
    registerContract: async (instance: { address: AztecAddress }) => {
      registered.add(instance.address.toString());
    },
  } as unknown as Wallet;
  const ctx = new AnsContext(reader, { wallet, account: old });
  t.mock.method(TokenContract, 'at', async (address: AztecAddress) => ({
    methods: {
      balance_of_private: () => ({
        simulate: async () => {
          assert.ok(registered.has(address.toString()));
          reads++;
          return { result: 7n };
        },
      }),
    },
  }));
  assert.equal(await getPrivateFeeBalance(ctx, next), 7n);
  assert.ok(registered.has(next.toString()));
  classId = Fr.ZERO;
  await assert.rejects(getPrivateFeeBalance(ctx, next), (e: AnsError) => e.code === 'unsupported');
  assert.equal(reads, 1);
});

async function fixture() {
  const registry = AztecAddress.fromBigIntUnsafe(2n),
    account = AztecAddress.fromBigIntUnsafe(1n);
  const snapshot = {
    timestamp: 1000n,
    blockNumber: 10,
    blockHash: 'block-10',
    finality: 'checkpointed',
  };
  const hash = TxHash.random().toString();
  let broadcasts = 0;
  const records = new Map<string, RegistrationPlan>();
  const history: RegistrationPlan[] = [];
  const store: RegistrationPlanStore = {
    load: async (key) => records.get(key),
    save: async (key, plan) => {
      history.push({ ...plan });
      records.set(key, { ...plan });
    },
  };
  const reader = {
    registry,
    deployment: { chainId: 31337n },
    modular: false,
    snapshot: async () => snapshot,
    getName: async () => ({ generation: 0, revision: 0, expiresAt: 0n, owner: AztecAddress.ZERO }),
    getCommit: async () => ({ committedAt: 0n, consumed: false }),
    getConfig: async () => ({
      feeToken: AztecAddress.ZERO,
      treasury: AztecAddress.ZERO,
      annualPrice: 0n,
      priceVersion: 1,
    }),
    node: {
      getTxReceipt: async () => ({
        status: TxStatus.CHECKPOINTED,
        blockNumber: 10,
        hasExecutionReverted: () => false,
      }),
    },
  } as unknown as RegistryReader;
  const interaction = {
    simulate: async () => {},
    send: async () => {
      assert.ok(records.size, 'secret must be durable before broadcast');
      broadcasts++;
      return { txHash: hash };
    },
  };
  const ctx = {
    reader,
    account,
    queue: new ExecutionQueue(),
    signer: {},
    assertWalletNetwork: async () => {},
    registrationContract: async () => ({ methods: { commit: () => interaction, register: () => interaction } }),
  } as unknown as AnsContext;
  const flow = createRegistrationFlow(ctx, store);
  const quote = await flow.quote(31536000n);
  const plan = await flow.prepare({ name: 'alice', acceptedQuote: quote });
  return { ctx, flow, store, records, history, plan, quote, interaction, broadcasts: () => broadcasts };
}

test('concurrent commits using an old plan copy broadcast once, including after creating a new flow', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.flow.commit(f.plan), f.flow.commit(f.plan)]);
  assert.equal(a.commitTx, b.commitTx);
  await createRegistrationFlow(f.ctx, f.store).commit(f.plan);
  assert.equal(f.broadcasts(), 1);
});

test('persistence failure after submission retains the hash in memory and blocks duplicate broadcasts', async () => {
  const f = await fixture();
  const original = f.store.save;
  f.store.save = async (key, plan) => {
    if (plan.commitTx) throw new Error('disk full');
    await original(key, plan);
  };
  await assert.rejects(
    f.flow.commit(f.plan),
    (e: AnsError) => e.code === 'unknown_tx_state' && !!e.txHash,
  );
  f.store.save = original;
  await f.flow.commit(f.plan);
  assert.ok([...f.records.values()][0].commitTx, 'recovery must repair the durable hash');
  assert.equal(f.broadcasts(), 1);
});

test('storage failure before submission and a changed accepted quote both prevent broadcasts', async () => {
  const f = await fixture();
  f.store.save = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(f.flow.commit(f.plan), /disk full/);
  await assert.rejects(
    f.flow.prepare({ name: 'bob', acceptedQuote: { ...f.quote, priceVersion: 99 } }),
    (e: AnsError) => e.code === 'fee_changed',
  );
  assert.equal(f.broadcasts(), 0);
});

test('wallet transport uncertainty without a hash survives a reload and cannot silently resend', async () => {
  const f = await fixture();
  let attempts = 0;
  f.interaction.send = async () => {
    attempts++;
    throw new AnsError('network', 'fetch failed');
  };
  await assert.rejects(f.flow.commit(f.plan), (e: AnsError) => e.code === 'network');
  await assert.rejects(
    createRegistrationFlow(f.ctx, f.store).commit(f.plan),
    (e: AnsError) => e.code === 'unknown_tx_state',
  );
  assert.equal(attempts, 1);
});

test('a failed wallet identity read before submission remains safely retryable without an unknown broadcast flag', async () => {
  const f = await fixture();
  f.ctx.assertWalletNetwork = async () => {
    throw new AnsError('network', 'cannot read wallet identity');
  };
  await assert.rejects(f.flow.commit(f.plan), (e: AnsError) => e.code === 'network');
  assert.equal([...f.records.values()][0].broadcastUnknown, undefined);
  assert.equal(f.broadcasts(), 0);
  f.ctx.assertWalletNetwork = async () => {};
  await f.flow.commit(f.plan);
  assert.equal(f.broadcasts(), 1);
});

test('receipt recovery clears only proven failures and stale plan copies cannot resurrect a failed hash', async () => {
  const f = await fixture();
  const sent = await f.flow.commit(f.plan);
  f.ctx.reader.node.getTxReceipt = async () =>
    ({ status: TxStatus.CHECKPOINTED, hasExecutionReverted: () => true }) as any;
  await assert.rejects(f.flow.recover(sent, 'commitTx'), (e: AnsError) => e.code === 'reverted');
  assert.equal([...f.records.values()][0].commitTx, undefined);
  f.ctx.reader.node.getTxReceipt = async () =>
    ({ status: TxStatus.CHECKPOINTED, hasExecutionReverted: () => false }) as any;
  await f.flow.commit(sent); // Old object still has the reverted hash.
  assert.equal(f.broadcasts(), 2);
});

test('a reload keeps a cleared hash authoritative over an old caller copy', async () => {
  const f = await fixture(),
    sent = await f.flow.commit(f.plan);
  await f.store.save([...f.records.keys()][0], { ...sent, commitTx: undefined });
  await createRegistrationFlow(f.ctx, f.store).commit(sent);
  assert.equal(f.broadcasts(), 2);
});

test('receipt timeout and missing hashes never clear progress or broadcast', async () => {
  const f = await fixture(),
    sent = await f.flow.commit(f.plan);
  await assert.rejects(
    f.flow.recover(sent, 'commitTx', { timeoutMs: 0 }),
    (e: AnsError) => e.code === 'unknown_tx_state',
  );
  assert.equal([...f.records.values()][0].commitTx, sent.commitTx);
  await assert.rejects(
    f.flow.recover(sent, 'registerTx'),
    (e: AnsError) => e.code === 'unknown_tx_state',
  );
  assert.equal(f.broadcasts(), 1);
});

test('a wallet disconnect during commit records an unknown broadcast and blocks a silent resend', async () => {
  const f = await fixture();
  let attempts = 0;
  f.interaction.send = async () => {
    attempts++;
    throw new Error('Wallet disconnected');
  };
  await assert.rejects(f.flow.commit(f.plan), (e: AnsError) => e.code === 'unknown_tx_state');
  assert.equal([...f.records.values()][0].broadcastUnknown, 'commitTx');
  await assert.rejects(createRegistrationFlow(f.ctx, f.store).commit(f.plan), (e: AnsError) => e.code === 'unknown_tx_state');
  assert.equal(attempts, 1);
});

test('commit refuses to broadcast when the commitment exists or the name is taken', async () => {
  const f = await fixture();
  f.ctx.reader.getCommit = async () => ({ committedAt: 990n, consumed: false });
  await assert.rejects(f.flow.commit(f.plan), (e: AnsError) => e.code === 'conflict');
  f.ctx.reader.getCommit = async () => ({ committedAt: 0n, consumed: false });
  f.ctx.reader.getName = async () => ({ generation: 1, revision: 0, expiresAt: 10n ** 12n, owner: AztecAddress.ZERO });
  await assert.rejects(f.flow.commit(f.plan), (e: AnsError) => e.code === 'name_taken');
  assert.equal(f.broadcasts(), 0);
});

test('finishing an already consumed commitment reports commit_missing rather than waiting', async () => {
  const f = await fixture();
  f.ctx.reader.getCommit = async () => ({ committedAt: 900n, consumed: true });
  await assert.rejects(f.flow.finish(f.plan), (e: AnsError) => e.code === 'commit_missing');
});

test('a commit that reverts on first send clears its hash so one retry broadcasts again', async () => {
  const f = await fixture();
  f.ctx.reader.node.getTxReceipt = async () =>
    ({ status: TxStatus.CHECKPOINTED, hasExecutionReverted: () => true }) as any;
  await assert.rejects(f.flow.commit(f.plan), (e: AnsError) => e.code === 'reverted');
  assert.equal([...f.records.values()][0].commitTx, undefined);
  f.ctx.reader.node.getTxReceipt = async () =>
    ({ status: TxStatus.CHECKPOINTED, hasExecutionReverted: () => false }) as any;
  await f.flow.commit(f.plan);
  assert.equal(f.broadcasts(), 2);
});

test('registration flow: a call that cannot be encoded locally leaves no broadcast marker and the retry sends', async () => {
  const f = await fixture();
  let encodes = 0;
  Object.assign(f.interaction, {
    getFunctionCall: async () => {
      if (++encodes === 1) throw new TypeError('Failed to fetch');
      return {};
    },
  });
  await assert.rejects(f.flow.commit(f.plan), (e: AnsError) => e.code === 'network');
  assert.ok(f.history.every((p) => p.broadcastUnknown === undefined));
  assert.equal(f.broadcasts(), 0);
  await f.flow.commit(f.plan);
  assert.equal(encodes, 2);
  assert.equal(f.broadcasts(), 1);
});

test('registration flow: a read failure before sendTx does not set broadcastUnknown and the retry sends', async () => {
  const f = await fixture();
  const original = f.interaction.send;
  let calls = 0;
  f.interaction.send = async () => {
    calls++;
    if (calls === 1) throw new Error('Request timeout on the free plan', {
      cause: { code: 30, message: 'Request timeout on the free plan', rpcMethods: ['aztec_getPublicDataWitness'] },
    });
    return original();
  };
  await assert.rejects(f.flow.commit(f.plan), (e: AnsError) => e.code === 'network');
  assert.equal([...f.records.values()][0].broadcastUnknown, undefined);
  await f.flow.commit(f.plan);
  assert.equal(calls, 2);
  assert.equal(f.broadcasts(), 1);
});

for (const kind of ['commitTx', 'registerTx'] as const) {
  test(`${kind} recovery preserves its hash when a progress observer throws`, async () => {
    const f = await fixture();
    const hash = TxHash.random().toString();
    const saved = { ...f.plan, [kind]: hash };
    await f.store.save([...f.records.keys()][0], saved);
    const flow = createRegistrationFlow(f.ctx, f.store);
    for (const failure of [
      new Error('render failed'),
      new AnsError('reverted', 'observer failed without a receipt'),
      new AnsError('dropped', 'failure for another transaction', undefined, TxHash.random().toString()),
    ]) {
      f.ctx.reader.node.getTxReceipt = async () =>
        ({ status: TxStatus.PROPOSED, hasExecutionReverted: () => false }) as any;
      await assert.rejects(
        flow.recover(f.plan, kind, { onUpdate: () => { throw failure; } }),
        (error: unknown) => error === failure,
      );
      assert.equal([...f.records.values()][0][kind], hash, 'observer failure is not a terminal receipt');
      // A new flow and stale caller must recover the saved hash, never send again.
      f.ctx.reader.node.getTxReceipt = async () =>
        ({ status: TxStatus.CHECKPOINTED, hasExecutionReverted: () => false }) as any;
      const reloaded = createRegistrationFlow(f.ctx, f.store);
      const recovered = await (kind === 'commitTx' ? reloaded.commit(f.plan) : reloaded.finish(f.plan));
      assert.equal(recovered[kind], hash);
      assert.equal(f.broadcasts(), 0);
    }
  });

  test(`${kind} recovery retains an uncertain hash but clears a verified drop without broadcasting`, async (t) => {
    const f = await fixture();
    const hash = TxHash.random().toString();
    await f.store.save([...f.records.keys()][0], { ...f.plan, [kind]: hash });
    const flow = createRegistrationFlow(f.ctx, f.store);
    f.ctx.reader.node.getTxReceipt = async () => { throw new Error('RPC unavailable'); };
    await assert.rejects(
      flow.recover(f.plan, kind, { timeoutMs: 10, pollMs: 1 }),
      (e: AnsError) => e.code === 'unknown_tx_state' && e.txHash === hash,
    );
    assert.equal([...f.records.values()][0][kind], hash);
    // Advance the propagation grace period without a ten-second real-time wait.
    let now = 0;
    t.mock.method(Date, 'now', () => (now += 7000));
    f.ctx.reader.node.getTxReceipt = async () => ({ status: TxStatus.DROPPED }) as any;
    await assert.rejects(
      flow.recover(f.plan, kind, { timeoutMs: 120000, pollMs: 1 }),
      (e: AnsError) => e.code === 'dropped' && e.txHash === hash,
    );
    assert.equal([...f.records.values()][0][kind], undefined);
    assert.equal(f.broadcasts(), 0);
  });
}

test('a wallet disconnect during finish persists registerTx uncertainty and blocks payment retries after reload', async () => {
  const f = await fixture();
  f.ctx.reader.getCommit = async () => ({ committedAt: 900n, consumed: false });
  let attempts = 0;
  f.interaction.send = async () => {
    attempts++;
    throw new Error('Wallet disconnected');
  };
  await assert.rejects(f.flow.finish(f.plan), (e: AnsError) => e.code === 'unknown_tx_state');
  const saved = [...f.records.values()][0];
  assert.equal(saved.registerTx, undefined);
  assert.equal(saved.broadcastUnknown, 'registerTx');
  const reloaded = createRegistrationFlow(f.ctx, f.store);
  await assert.rejects(reloaded.recover(f.plan, 'registerTx'), (e: AnsError) => e.code === 'unknown_tx_state');
  await assert.rejects(reloaded.finish(f.plan), (e: AnsError) => e.code === 'unknown_tx_state');
  assert.equal(attempts, 1);
});

for (const kind of ['commitTx', 'registerTx'] as const) {
  async function sendingFixture() {
    const f = await fixture();
    if (kind === 'registerTx')
      f.ctx.reader.getCommit = async () => ({ committedAt: 900n, consumed: false });
    const send = (options = {}) => kind === 'commitTx'
      ? f.flow.commit(f.plan, options) : f.flow.finish(f.plan, options);
    return { ...f, send };
  }

  test(`${kind}: durable marker blocks a reloaded flow while wallet send is unresolved`, async () => {
    const f = await sendingFixture();
    let entered!: () => void, release!: () => void, attempts = 0;
    const started = new Promise<void>((r) => { entered = r; });
    const pending = new Promise<void>((r) => { release = r; });
    f.interaction.send = async () => {
      attempts++;
      if (attempts > 1) throw new Error('duplicate send');
      entered();
      await pending;
      return { txHash: TxHash.random().toString() };
    };
    const first = f.send();
    try {
      await started;
      assert.equal([...f.records.values()][0].broadcastUnknown, kind);
      const reloaded = createRegistrationFlow(f.ctx, f.store);
      await assert.rejects(kind === 'commitTx' ? reloaded.commit(f.plan) : reloaded.finish(f.plan),
        (e: AnsError) => e.code === 'unknown_tx_state');
      assert.equal(attempts, 1);
    } finally { release(); await first; }
  });

  for (const failure of ['identity', 'artifacts', 'beforeSend', 'preflight', 'balance', 'chain check'] as const) {
    test(`${kind}: ${failure} failure never saves a broadcast marker`, async () => {
      const f = await sendingFixture();
      const fail = async () => { throw new AnsError('network', 'synthetic validation failure'); };
      if (failure === 'identity') f.ctx.assertWalletNetwork = fail;
      if (failure === 'artifacts') {
        Object.assign(f.ctx.reader, { modular: true });
        // Keep module validation valid until the queued ensureRegistered check.
        f.ctx.reader.getModules = async () => ({ registrar: AztecAddress.ZERO }) as any;
        f.ctx.ensureRegistered = fail;
      }
      if (failure === 'beforeSend') f.ctx.signer.beforeSend = fail;
      if (failure === 'preflight') f.interaction.simulate = fail;
      if (failure === 'balance') {
        f.plan.fee = 1n; // zero token balance, checked before submission
        await f.store.save([...f.records.keys()][0], f.plan);
      }
      if (failure === 'chain check') f.ctx.reader.getCommit = fail;
      await assert.rejects(f.send({ preflight: failure === 'preflight' }));
      assert.ok(f.history.every((p) => p.broadcastUnknown === undefined));
      assert.equal(f.broadcasts(), 0);
    });
  }

  for (const failure of [new AnsError('wallet_rejected', 'cancelled'), new Error('SimulationError: assertion failed')]) {
    test(`${kind}: ${failure.message} clears the marker and permits retry`, async () => {
      const f = await sendingFixture();
      const original = f.interaction.send;
      f.interaction.send = async () => { throw failure; };
      await assert.rejects(f.send());
      assert.ok(f.history.some((p) => p.broadcastUnknown === kind));
      assert.equal([...f.records.values()][0].broadcastUnknown, undefined);
      f.interaction.send = original;
      await f.send();
      assert.equal(f.broadcasts(), 1);
    });
  }

  test(`${kind}: returned hash replaces the durable marker`, async () => {
    const f = await sendingFixture();
    await f.send();
    assert.ok(f.history.some((p) => p.broadcastUnknown === kind));
    assert.ok([...f.records.values()][0][kind]);
    assert.equal([...f.records.values()][0].broadcastUnknown, undefined);
  });

  test(`${kind}: marker persistence failure prevents wallet send`, async () => {
    const f = await sendingFixture();
    const save = f.store.save;
    f.store.save = async (key, plan) => {
      if (plan.broadcastUnknown) throw new Error('marker storage failed');
      await save(key, plan);
    };
    await assert.rejects(f.send(), /marker storage failed/);
    assert.equal(f.broadcasts(), 0);
  });

  test(`${kind}: a failed marker clear preserves the original wallet error and durable uncertainty`, async () => {
    const f = await sendingFixture();
    const save = f.store.save;
    let marked = false;
    f.store.save = async (key, plan) => {
      if (marked && !plan.broadcastUnknown) throw new Error('clear storage failed');
      marked ||= !!plan.broadcastUnknown;
      await save(key, plan);
    };
    const rejected = new AnsError('wallet_rejected', 'cancelled');
    f.interaction.send = async () => { throw rejected; };
    await assert.rejects(f.send(), (e) => e === rejected);
    assert.equal([...f.records.values()][0].broadcastUnknown, kind);
  });
}
