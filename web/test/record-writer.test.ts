import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { AnsContext, runTx, type RegistrationPlan, type RegistryReader } from '@ans/sdk';
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts';
import { GasFees } from '@aztec-labs/stdlib/gas';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { WalletProvider } from '@aztec-labs/wallet-sdk/manager';
import type { TestContext } from 'node:test';

// Vite provides import.meta.env in browsers; supply only a local fixture config in Node.
const configUrl = 'data:text/javascript,export const config = ' + encodeURIComponent(JSON.stringify({
  network: 'local', feePayment: 'sponsored', nodeUrl: 'http://127.0.0.1:1',
  registry: '0x03', expectedChainId: '31337',
}));
const fixtureConfig = (await import(configUrl)).config;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\/config(?:\.ts)?$/.test(specifier) && context.parentURL?.includes('/web/src/'))
      return { url: configUrl, shortCircuit: true };
    return next(specifier, context);
  },
});
const session = await import('../src/session.ts');
hook.deregister();
const { RecordStore } = await import('../src/vault.ts');

async function fixture(t: TestContext) {
  const data = new Map<string, string>();
  const setGlobal = (name: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  };
  setGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } as Storage);
  setGlobal('crypto', webcrypto as Crypto);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  // Existing device key, so no database writes or real wallet stores are involved.
  setGlobal('indexedDB', {
    open: () => {
      const request = { result: {
        transaction: () => ({ objectStore: () => ({ get: () => {
          const q = { result: key, onsuccess: () => {} };
          queueMicrotask(() => q.onsuccess());
          return q;
        } }) }), close() {},
      }, onsuccess: () => {} };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  } as unknown as IDBFactory);
  t.mock.method(AnsContext.prototype, 'ensureRegistered', async () => {});
  const a = AztecAddress.fromBigIntUnsafe(1n), b = AztecAddress.fromBigIntUnsafe(2n);
  const registry = AztecAddress.fromBigIntUnsafe(3n);
  const reader = { registry, deployment: { chainId: 31337n, rollupVersion: 1n },
    node: {}, modular: false } as unknown as RegistryReader;
  session.getSession().reader = reader;
  const wallet = {
    getAccounts: async () => [{ item: a, alias: 'A' }, { item: b, alias: 'B' }],
    getChainInfo: async () => ({ chainId: new Fr(31337), version: new Fr(1) }),
  } as unknown as Wallet;
  await session.connectExternal(wallet, { disconnect: async () => {}, onDisconnect: () => () => {} } as unknown as WalletProvider);
  t.after(() => session.lock());
  await session.selectAccount(a);
  const ctx = session.getSession().ctx!;
  const plan = { account: a.toString(), registry: registry.toString(), chainId: 31337n,
    commitment: 1n, broadcastUnknown: 'registerTx' } as RegistrationPlan;
  await session.updateRecords((r) => ({ ...r, plans: [plan] }));
  const storeA = new RecordStore(key, `ans:v2:31337:${registry}:${a}`, () => ({ plans: [] as RegistrationPlan[], txs: [], names: [] }));
  return { a, b, ctx, plan, storeA, data };
}

test('originating account writer persists a late hash without changing account B or its visible records', async (t) => {
  const f = await fixture(t);
  const write = session.recordWriter(f.ctx);
  await session.selectAccount(f.b);
  const before = session.getSession().records;
  await write((r) => ({ ...r, plans: r.plans.map((p) => ({ ...p, registerTx: `0x${'a'.repeat(64)}`, broadcastUnknown: undefined })) }));
  assert.equal((await f.storeA.load()).plans[0].registerTx, `0x${'a'.repeat(64)}`);
  assert.equal(session.getSession().records, before);
  assert.deepEqual(session.getSession().records?.plans, []);
});

test('detached registration reader loads the latest originating plan after an account switch', async (t) => {
  const f = await fixture(t);
  const { registrationFlow } = await import('../src/registration.ts');
  // Calling recover with no hash must reach the SDK's missing-hash guard after current() loads A.
  const flow = registrationFlow(f.ctx);
  await session.selectAccount(f.b);
  await assert.rejects(flow.recover(f.plan, 'registerTx'), (e: { code?: string }) => e.code === 'unknown_tx_state');
});

test('switching back waits for detached writes and shows the saved hash with payment retry blocked', async (t) => {
  const f = await fixture(t);
  const write = session.recordWriter(f.ctx);
  await session.selectAccount(f.b);
  const saving = write((r) => ({ ...r, plans: r.plans.map((p) => ({ ...p, registerTx: `0x${'b'.repeat(64)}`, broadcastUnknown: undefined })) }));
  await session.selectAccount(f.a);
  await saving;
  const saved = session.getSession().records!.plans[0];
  assert.equal(saved.registerTx, `0x${'b'.repeat(64)}`);
  const canFinish = !saved.registerTx && saved.broadcastUnknown !== 'registerTx';
  assert.equal(canFinish, false);
});

test('boot withdraws stale reader/context on outage and identity mismatch, then restores only after verification', async (t) => {
  const f = await fixture(t);
  const { RegistryReader } = await import('@ans/sdk/read');
  const reader = f.ctx.reader;
  let failure: Error | undefined;
  let deployment = reader.deployment;
  t.mock.method(RegistryReader, 'connect', async () => {
    if (failure) throw failure;
    return { ...reader, deployment } as RegistryReader;
  });
  await session.boot();
  const verified = session.getSession().reader;
  failure = new TypeError('Failed to fetch');
  await session.boot();
  assert.equal(session.getSession().status, 'offline');
  assert.equal(session.getSession().reader, undefined);
  assert.equal(session.getSession().ctx, undefined);
  assert.equal(session.getSession().records?.plans[0].broadcastUnknown, 'registerTx');
  await assert.rejects(session.selectAccount(f.b), /Network not ready/);
  await assert.rejects(session.connectExternal({} as Wallet, { disconnect: async () => {} } as WalletProvider), /not ready/);
  failure = undefined;
  await session.boot();
  assert.equal(session.getSession().status, 'ready');
  assert.equal(session.getSession().reader, verified);
  assert.equal(session.getSession().ctx, f.ctx);
  assert.equal(session.getSession().error, undefined);
  // The previous verified identity must survive even while the public reader is absent.
  for (const wrong of [{ ...reader.deployment, chainId: 1n }, { ...reader.deployment, rollupVersion: 2n }]) {
    deployment = wrong;
    await session.boot();
    assert.equal(session.getSession().status, 'misconfigured');
    assert.equal(session.getSession().reader, undefined);
    assert.equal(session.getSession().ctx, undefined);
    deployment = reader.deployment;
    await session.boot();
    assert.equal(session.getSession().status, 'ready');
    assert.equal(session.getSession().ctx, f.ctx);
  }
  failure = new TypeError('Failed to fetch');
  await session.boot();
  await session.lock();
  failure = undefined;
  await session.boot();
  assert.equal(session.getSession().status, 'locked');
  assert.equal(session.getSession().ctx, undefined, 'locking during outage cannot revive an old account context');
});

test('account setup waiting in the shared wallet queue is refused after an outage', async (t) => {
  const f = await fixture(t);
  const { RegistryReader } = await import('@ans/sdk/read');
  let offline = true, registrations = 0;
  t.mock.method(RegistryReader, 'connect', async () => {
    if (offline) throw new TypeError('Failed to fetch');
    return f.ctx.reader;
  });
  t.mock.method(AnsContext.prototype, 'ensureRegistered', async () => { registrations++; });
  let release!: () => void, queued!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const signal = new Promise<void>(resolve => { queued = resolve; });
  const pending = f.ctx.queue.run(() => gate);
  const run = f.ctx.queue.run.bind(f.ctx.queue);
  t.mock.method(f.ctx.queue, 'run', <T>(fn: () => Promise<T>) => { queued(); return run(fn); });
  const selecting = session.selectAccount(f.b).then(() => undefined, e => e);
  try {
    await signal;
    await session.boot();
  } finally { release(); }
  await pending;
  assert.match((await selecting).message, /Network not ready/);
  assert.equal(registrations, 0);
  assert.equal(session.getSession().status, 'offline');
  assert.equal(session.getSession().ctx, undefined);
  offline = false;
  await session.boot();
});

for (const feePayment of ['sponsored', 'fee-juice']) {
  for (const status of ['offline', 'misconfigured']) {
    for (const stage of ['queued', 'in-progress']) {
      test(`${feePayment} ${stage} transaction rejects ${status} before broadcast`, async (t) => {
        fixtureConfig.feePayment = feePayment;
        t.after(() => { fixtureConfig.feePayment = 'sponsored'; });
        const f = await fixture(t);
        const { RegistryReader } = await import('@ans/sdk/read');
        let healthy = true;
        t.mock.method(RegistryReader, 'connect', async () => {
          if (healthy) return f.ctx.reader;
          if (status === 'offline') throw new TypeError('Failed to fetch');
          return { ...f.ctx.reader, deployment: { ...f.ctx.reader.deployment, chainId: 1n } } as RegistryReader;
        });
        let release!: () => void, started!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const signal = new Promise<void>(resolve => { started = resolve; });
        const blocker = stage === 'queued' ? f.ctx.queue.run(() => gate) : undefined;
        if (stage === 'queued') {
          const run = f.ctx.queue.run.bind(f.ctx.queue);
          t.mock.method(f.ctx.queue, 'run', <T>(fn: () => Promise<T>) => { started(); return run(fn); });
        } else {
          // The write has entered the SDK queue and is awaiting a wallet identity read.
          t.mock.method(f.ctx, 'assertWalletNetwork', async () => { started(); await gate; });
        }
        let sends = 0, unknownMarkers = 0, feeReads = 0;
        Object.assign(f.ctx.reader.node, {
          getPublicStorageAt: async () => { feeReads++; return new Fr(1000); },
          getCurrentMinFees: async () => new GasFees(2n, 3n),
          getNodeInfo: async () => ({ txsLimits: { gas: { daGas: 10, l2Gas: 20 } } }),
        });
        const call = { send: async () => { sends++; throw new Error('Unexpected broadcast'); } } as unknown as ContractFunctionInteraction;
        const opts = { preflight: false, beforeBroadcast: async () => { unknownMarkers++; } };
        const result = runTx(f.ctx, call, opts).then(() => undefined, e => e);
        await signal;
        healthy = false;
        await session.boot();
        assert.equal(session.getSession().status, status);
        assert.equal(session.getSession().ctx, undefined);
        release();
        await blocker;
        assert.match((await result).message, /Network not ready/);
        assert.equal(sends, 0);
        assert.equal(unknownMarkers, 0, 'validation failure never reaches the durable broadcast marker');
        assert.equal(feeReads, 0, 'unavailable writes fail before fee admission reads');
        // Restoring a verified session permits the hook again, preserving fee-juice admission.
        healthy = true;
        await session.boot();
        await f.ctx.queue.run(() => f.ctx.signer.beforeSend!(f.ctx.account));
        assert.equal(feeReads, feePayment === 'fee-juice' ? 1 : 0);
        assert.equal(sends, 0);
      });
    }
  }
}

test('fee-juice admission rejects an outage arising during its balance check before send', async (t) => {
  fixtureConfig.feePayment = 'fee-juice';
  t.after(() => { fixtureConfig.feePayment = 'sponsored'; });
  const f = await fixture(t);
  const { RegistryReader } = await import('@ans/sdk/read');
  let healthy = false, sends = 0;
  t.mock.method(RegistryReader, 'connect', async () => {
    if (!healthy) throw new TypeError('Failed to fetch');
    return f.ctx.reader;
  });
  Object.assign(f.ctx.reader.node, {
    getPublicStorageAt: async () => { await session.boot(); return new Fr(1000); },
    getCurrentMinFees: async () => new GasFees(2n, 3n),
    getNodeInfo: async () => ({ txsLimits: { gas: { daGas: 10, l2Gas: 20 } } }),
  });
  const call = { send: async () => { sends++; throw new Error('Unexpected broadcast'); } } as unknown as ContractFunctionInteraction;
  await assert.rejects(runTx(f.ctx, call), /Network not ready/);
  assert.equal(sends, 0);
  healthy = true;
  await session.boot();
});

test('a provider acquired before an outage during wallet lock is disconnected on failure', async (t) => {
  const f = await fixture(t);
  const { RegistryReader } = await import('@ans/sdk/read');
  let healthy = false, disconnected = 0, accountReads = 0;
  t.mock.method(RegistryReader, 'connect', async () => {
    if (!healthy) throw new TypeError('Failed to fetch');
    return f.ctx.reader;
  });
  const oldProvider = { disconnect: async () => {}, onDisconnect: () => () => {} } as unknown as WalletProvider;
  // First install the old connection, then have its asynchronous disconnect observe an outage.
  await session.connectExternal(f.ctx.wallet, oldProvider);
  t.mock.method(oldProvider, 'disconnect', () => session.boot());
  const provider = { disconnect: async () => { disconnected++; } } as WalletProvider;
  await assert.rejects(session.connectExternal({ getAccounts: async () => { accountReads++; return []; } } as unknown as Wallet, provider), /Network not ready/);
  assert.equal(disconnected, 1);
  assert.equal(accountReads, 0);
  assert.equal(session.getSession().status, 'offline');
  assert.equal(session.getSession().wallet, undefined);
  healthy = true;
  await session.boot();
});

test('late registration hash updates suspended account memory without restoring live writes', async (t) => {
  const f = await fixture(t);
  const write = session.recordWriter(f.ctx);
  let release!: () => void, saving!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const signal = new Promise<void>(resolve => { saving = resolve; });
  const save = RecordStore.prototype.save;
  t.mock.method(RecordStore.prototype, 'save', async function (value: unknown) {
    saving();
    await gate;
    return save.call(this, value);
  });
  const pending = write(r => ({ ...r, names: ['alice'] }));
  await signal;
  const { RegistryReader } = await import('@ans/sdk/read');
  let healthy = false;
  t.mock.method(RegistryReader, 'connect', async () => {
    if (!healthy) throw new TypeError('Failed to fetch');
    return f.ctx.reader;
  });
  await session.boot();
  const hash = `0x${'c'.repeat(64)}`;
  session.rememberRegistrationProgress(f.ctx, { ...f.plan, registerTx: hash, broadcastUnknown: undefined });
  assert.equal(session.getSession().records!.plans[0].registerTx, hash);
  assert.equal(session.getSession().records!.plans[0].broadcastUnknown, undefined);
  release();
  await pending;
  assert.equal(session.getSession().records!.plans[0].registerTx, hash, 'an older encrypted save cannot erase a late in-memory hash');
  assert.equal(session.getSession().status, 'offline');
  assert.equal(session.getSession().ctx, undefined);
  await assert.rejects(f.ctx.queue.run(() => f.ctx.signer.beforeSend!(f.ctx.account)), /Network not ready/);
  await session.lock();
  healthy = true;
  await session.boot();
  await session.connectExternal(f.ctx.wallet, { disconnect: async () => {}, onDisconnect: () => () => {} } as unknown as WalletProvider);
  await session.selectAccount(f.a);
  const before = session.getSession().records;
  session.rememberRegistrationProgress(f.ctx, { ...f.plan, registerTx: hash });
  assert.equal(session.getSession().records, before, 'a locked context cannot update a later session');
});
