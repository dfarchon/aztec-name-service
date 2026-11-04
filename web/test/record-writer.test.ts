import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { AnsContext, type RegistrationPlan, type RegistryReader } from '@ans/sdk';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { WalletProvider } from '@aztec-labs/wallet-sdk/manager';
import type { TestContext } from 'node:test';

// Vite provides import.meta.env in browsers; supply only a local fixture config in Node.
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\/config(?:\.ts)?$/.test(specifier) && context.parentURL?.includes('/web/src/'))
      return { url: 'data:text/javascript,export const config = ' + encodeURIComponent(JSON.stringify({
        network: 'local', feePayment: 'sponsored', nodeUrl: 'http://127.0.0.1:1',
      })), shortCircuit: true };
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
