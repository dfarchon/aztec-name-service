import type { FogContext, RegistrationPlan, TxState } from 'fog-sdk';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { WalletProvider } from '@aztec-labs/wallet-sdk/manager';
import { FogError, RegistryReader, toFogError } from 'fog-sdk/read';
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';

import type { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec-labs/constants';
import { createLogger } from '@aztec-labs/foundation/log';

import type { ContractInstanceWithAddress } from '@aztec-labs/stdlib/contract';
import type { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { useSyncExternalStore } from 'react';

import { config } from './config';
import { canDeriveSponsor, identityMismatch } from './network-config';
import { createSessionNode, liveWritesAllowed, type ConnectionStatus } from './connection';
export { liveWritesAllowed } from './connection';
import metadata from './public-metadata.json';
import { retryDelay } from './usability';
import { deriveKeys, RecordStore } from './vault';
import sdkPackage from '../../sdk/package.json';

export { choosingAccount } from './account-state';

export type TxRecord = {
  id: string;
  label: string;
  txHash?: string;
  state: TxState;
  error?: string;
  at: number;
};

export type AccountKeys = { secret: string; salt: string; signingKey: string };

/** Everything the site remembers for one account, encrypted at rest. */
export type AccountRecords = {
  plans: RegistrationPlan[];
  txs: TxRecord[];
  names: string[];
  keys?: AccountKeys;
};
const emptyRecords = (): AccountRecords => ({ plans: [], txs: [], names: [] });

type Status = ConnectionStatus;

export type SessionState = {
  status: Status;
  pendingTxs: number;
  error?: string;
  node: AztecNode;
  reader?: RegistryReader;
  wallet?: Wallet;
  walletMode?: 'external' | 'embedded';
  accounts: { alias: string; address: AztecAddress }[];
  selectingAccount?: AztecAddress;
  ctx?: FogContext;
  records?: AccountRecords;
  connection?: { checkedAt: number; latencyMs: number; failures: number };
};

let state: SessionState = {
  status: 'booting',
  pendingTxs: 0,
  node: createSessionNode(config.nodeUrl, connectionUnavailable),
  accounts: [],
};
const listeners = new Set<() => void>();
const set = (patch: Partial<SessionState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
export const getSession = () => state;
export const useSession = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );

let recordStore: RecordStore<AccountRecords> | undefined;
let recordsKey: CryptoKey | undefined;
let releaseTabLock: (() => void) | undefined;
let embeddedWallet: EmbeddedWallet | undefined;
let externalProvider: WalletProvider | undefined;
let unsubscribeProvider: (() => void) | undefined;
let sessionEpoch = 0;
let saveQueue: Promise<void> = Promise.resolve();
let paymentMethod: SponsoredFeePaymentMethod | undefined;

async function verifySponsoredFpc(instance: ContractInstanceWithAddress) {
  if (!instance.currentContractClassId.equals(Fr.fromString(metadata.fpcClassId)))
    throw new Error('Configured fee sponsorship contract type does not match.');
}

/** Connects the wallet-free reader. Reading works without unlocking anything. */
let connecting: Promise<void> | undefined;
let connectionTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let watching = false;
let verifiedReader: RegistryReader | undefined;
let suspendedContext: { ctx: FogContext; epoch: number } | undefined;
let connectionRevision = 0;

function requireLiveNetwork() {
  if (!liveWritesAllowed(state.status) || !state.reader)
    throw new Error('Network not ready. Reconnect and retry.');
}

/** Withdraw live capabilities when the transport returns a read failure; saved hashes remain intact. */
function connectionUnavailable(error: unknown) {
  connectionRevision++;
  failures++;
  if (state.ctx) suspendedContext = { ctx: state.ctx, epoch: sessionEpoch };
  const err = toFogError(error);
  set({ reader: undefined, ctx: undefined,
    status: err.code === 'wrong_deployment' || state.status === 'misconfigured' ? 'misconfigured' : 'offline',
    error: err.message,
    connection: { latencyMs: state.connection?.latencyMs ?? 0, checkedAt: Date.now(), failures },
  });
  if (connectionTimer) clearTimeout(connectionTimer);
  if (watching && !connecting && state.status !== 'misconfigured')
    connectionTimer = setTimeout(() => void boot(), retryDelay(failures));
}

export function boot(): Promise<void> {
  if (connecting) return connecting;
  if (connectionTimer) clearTimeout(connectionTimer);
  connecting = (async () => {
    if (!config.registry) {
      connectionUnavailable(new FogError('wrong_deployment', 'Registry is not configured'));
      return;
    }
    const started = Date.now();
    const revision = connectionRevision;
    try {
      const reader = await RegistryReader.connect(state.node, config.registry, { allowRehearsalSuccessor: config.allowRehearsalSuccessor });
      if (identityMismatch({ chainId: config.expectedChainId, rollupVersion: config.expectedRollupVersion },
        verifiedReader?.deployment, reader.deployment)) {
        throw new FogError('wrong_deployment', 'Network identity changed');
      }
      // A concurrent final read failure supersedes an older successful health check.
      if (revision !== connectionRevision) return;
      failures = 0;
      verifiedReader ??= reader;
      const ctx = state.ctx ?? (suspendedContext?.epoch === sessionEpoch ? suspendedContext.ctx : undefined);
      suspendedContext = undefined;
      set({
        reader: verifiedReader,
        ctx,
        status: state.wallet ? 'ready' : state.status === 'unlocking' ? 'unlocking' : 'locked',
        error: ['offline', 'booting', 'misconfigured'].includes(state.status) ? undefined : state.error,
        connection: { checkedAt: Date.now(), latencyMs: Date.now() - started, failures },
      });
    } catch (e) {
      // The transport observer may already have withdrawn capabilities for this failed check.
      if (revision === connectionRevision || toFogError(e).code === 'wrong_deployment')
        connectionUnavailable(e);
      set({ connection: { checkedAt: Date.now(), latencyMs: Date.now() - started, failures } });
    }
  })().finally(() => {
    connecting = undefined;
    if (watching && state.status !== 'misconfigured') {
      connectionTimer = setTimeout(
        () => {
          if (!document.hidden) void boot();
          else
            connectionTimer = setTimeout(() => {
              if (!document.hidden) void boot();
            }, 30000);
        },
        failures ? retryDelay(failures) : 60000,
      );
    }
  });
  return connecting;
}

export function watchConnection() {
  if (watching) return;
  watching = true;
  const resume = () => {
    if (!document.hidden && state.status !== 'misconfigured') void boot();
  };
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', resume);
  void boot();
}

/** The OPFS stores allow one holder per origin; refuse a second tab instead of corrupting state. */
async function acquireTabLock(): Promise<void> {
  if (!navigator.locks) return;
  await new Promise<void>((resolve, reject) => {
    navigator.locks.request('fog-wallet', { ifAvailable: true }, (lock) => {
      if (!lock) {
        reject(new Error('Another tab is using the Fog wallet.'));
        return undefined;
      }
      resolve();
      return new Promise<void>((release) => (releaseTabLock = release));
    });
  });
}

export async function unlock(passphrase: string) {
  if (!config.developmentWallet) throw new Error('Developer wallet is disabled');
  requireLiveNetwork();
  set({ status: 'unlocking', error: undefined });
  let closeUnownedStores: (() => Promise<void>) | undefined;
  try {
    const info = await state.node.getNodeInfo();
    requireLiveNetwork();
    if (info.realProofs && !config.proverEnabled)
    {
      // Operator hint stays in the console; users see a plain message.
      console.warn('Fog: set VITE_PROVER_ENABLED=true for public networks.');
      throw new Error(
        'Public networks require real proofs, which this site build does not enable yet. Please try again later or contact the site maintainer.',
      );
    }
    let sponsor: { instance: ContractInstanceWithAddress; artifact: import('@aztec-labs/aztec.js/abi').ContractArtifact } | undefined;
    if (config.feePayment === 'sponsored') {
      const { getContractInstanceFromInstantiationParams } = await import('@aztec-labs/aztec.js/contracts');
      const { SponsoredFPCContractArtifact } = await import('@aztec-labs/noir-contracts.js/SponsoredFPC');
      const fpc = config.sponsoredFpc
        ? await state.node.getContract(config.sponsoredFpc)
        : canDeriveSponsor(info) ? await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) }) : undefined;
      if (!fpc) throw new Error('The shared network-fee sponsor is unavailable, so transactions cannot be sent right now. Please try again later.');
      await verifySponsoredFpc(fpc);
      sponsor = { instance: fpc, artifact: SponsoredFPCContractArtifact };
    }
    const { EmbeddedWallet } = await import('@aztec-labs/wallets/embedded');
    const { openEncryptedEmbeddedStores } =
      await import('@aztec-labs/wallets/embedded/store-encryption');
    await acquireTabLock();
    const keys = await deriveKeys(passphrase);
    const tag = info.l1ContractAddresses.rollupAddress.toString().slice(2, 12);
    const log = createLogger('fog-web');
    // Each store needs its own SAH-pool directory: a pool holds an exclusive lock on its directory.
    const { pxeStore, walletStore } = await openEncryptedEmbeddedStores(
      {
        pxe: {
          name: `fog-pxe-${tag}`,
          poolDirectory: `.aztec-kv-fog-pxe-${tag}`,
        },
        wallet: {
          name: `fog-wallet-${tag}`,
          poolDirectory: `.aztec-kv-fog-wallet-${tag}`,
        },
      },
      async () => keys.storeKey(),
      log,
    );
    closeUnownedStores = async () => {
      await Promise.allSettled([pxeStore.close(), walletStore.close()]);
    };
    const wallet = await EmbeddedWallet.create(state.node, {
      logger: log,
      pxe: { store: pxeStore, proverEnabled: config.proverEnabled },
      walletDb: { store: walletStore },
    });
    embeddedWallet = wallet;
    closeUnownedStores = undefined; // The wallet now owns both stores; lock() closes them on any later failure.
    if (sponsor) {
      requireLiveNetwork();
      const { SponsoredFeePaymentMethod } = await import('@aztec-labs/aztec.js/fee');
      await wallet.registerContract(sponsor.instance, sponsor.artifact);
      paymentMethod = new SponsoredFeePaymentMethod(sponsor.instance.address);
    }
    recordsKey = keys.recordsKey;
    const accounts = (await wallet.getAccounts()).map((a) => ({
      alias: a.alias,
      address: a.item,
    }));
    requireLiveNetwork();
    set({ wallet, walletMode: 'embedded', accounts, status: 'ready' });
    if (accounts.length === 1) await selectAccount(accounts[0].address);
  } catch (e) {
    await closeUnownedStores?.().catch(() => {});
    await lock();
    const msg =
      e instanceof Error && e.name === 'EmbeddedWalletEncryptionError'
        ? 'Incorrect passphrase. Unable to decrypt the local wallet.'
        : e instanceof Error
          ? e.message
          : String(e);
    set({ error: msg });
  }
}

export async function lock() {
  sessionEpoch++;
  suspendedContext = undefined;
  unsubscribeProvider?.();
  unsubscribeProvider = undefined;
  const provider = externalProvider;
  externalProvider = undefined;
  await provider?.disconnect().catch(() => {});
  await embeddedWallet?.stop().catch(() => {});
  embeddedWallet = undefined;
  releaseTabLock?.();
  recordStore = undefined;
  recordsKey = undefined;
  paymentMethod = undefined;
  set({
    status: state.status === 'misconfigured' ? 'misconfigured' : failures ? 'offline' : state.reader ? 'locked' : 'booting',
    wallet: undefined,
    walletMode: undefined,
    accounts: [],
    selectingAccount: undefined,
    ctx: undefined,
    records: undefined,
  });
}

export async function selectAccount(address: AztecAddress) {
  requireLiveNetwork();
  const epoch = ++sessionEpoch;
  set({ ctx: undefined, records: undefined, selectingAccount: address });
  try {
    const { wallet, reader } = state;
    if (!wallet || !reader || !recordsKey) return;
    const { FogContext } = await import('fog-sdk');
    const feeJuice = config.feePayment === 'fee-juice' ? await import('./fee-juice') : undefined;
    const ctx = new FogContext(reader, {
      wallet: feeJuice ? feeJuice.feeJuiceWallet(wallet, state.node) : wallet,
      // The SDK invokes this inside the shared wallet queue, including for already queued writes.
      beforeSend: async (account) => {
        requireLiveNetwork();
        if (feeJuice) await feeJuice.assertFeeJuiceFunded(reader.node, account);
        requireLiveNetwork();
      },
      // Users pay their own fees here: declare estimated gas so the required balance matches real usage.
      estimateGas: !!feeJuice,
      checkFee: feeJuice
        ? async (account, gas) => {
            requireLiveNetwork();
            await feeJuice.assertFeeJuice(reader.node, account, gas?.gasLimits);
            requireLiveNetwork();
          }
        : undefined,
      account: address,
      fee: paymentMethod ? { paymentMethod } : undefined,
    });
    // Fee reads belong to registration/renewal. A temporary quote failure must not block account management.
    await ctx.queue.run(() => {
      requireLiveNetwork();
      return ctx.ensureRegistered();
    });
    const store = new RecordStore(
      recordsKey,
      `fog:v2:${reader.deployment.chainId}:${reader.registry}:${address}`,
      emptyRecords,
    );
    await saveQueue.catch(() => {});
    const records = await store.load();
    if (epoch !== sessionEpoch) return;
    requireLiveNetwork();
    recordStore = store;
    set({ ctx, records });
  } finally {
    if (epoch === sessionEpoch) set({ selectingAccount: undefined });
  }
}

export async function createAccount(alias: string, imported?: AccountKeys) {
  requireLiveNetwork();
  const wallet = embeddedWallet;
  if (!wallet || state.walletMode !== 'embedded') return;
  const keys = imported ?? {
    secret: Fr.random().toString(),
    salt: Fr.random().toString(),
    signingKey: Fq.random().toString(),
  };
  const manager = await wallet.createSchnorrInitializerlessAccount(
    Fr.fromString(keys.secret),
    Fr.fromString(keys.salt),
    Fq.fromString(keys.signingKey),
    alias,
  );
  const address = manager.address;
  set({
    accounts: [...state.accounts.filter((a) => !a.address.equals(address)), { alias, address }],
  });
  await selectAccount(address);
  await updateRecords((r) => ({ ...r, keys }));
  return address;
}

export async function updateRecords(
  fn: (r: AccountRecords) => AccountRecords,
  epoch = sessionEpoch,
) {
  const store = recordStore;
  if (!store || !state.records || epoch !== sessionEpoch)
    throw new Error('Wallet account changed. Try the action again.');
  return queueRecordSave(() => saveCurrentRecords(store, fn, epoch));
}

function queueRecordSave(work: () => Promise<void>) {
  const save = saveQueue.catch(() => {}).then(work);
  saveQueue = save;
  return save;
}

async function saveCurrentRecords(
  store: RecordStore<AccountRecords>,
  fn: (r: AccountRecords) => AccountRecords,
  epoch: number,
) {
  if (epoch !== sessionEpoch || !state.records)
    throw new Error('Wallet account changed. Try the action again.');
      const before = state.records;
      const next = fn(before);
      // Persist before publishing success; callers must not send a commit if persistence failed.
      await store.save(next);
      if (epoch === sessionEpoch && state.records) {
        const previousPlans = new Map(before.plans.map((p) => [p.commitment, p]));
        const currentPlans = new Map(state.records.plans.map((p) => [p.commitment, p]));
        // A broadcast can happen while encryption is in progress. An older save must not erase its newer hash.
        const plans = next.plans.map((p) => {
          const previous = previousPlans.get(p.commitment);
          const current = currentPlans.get(p.commitment);
          if (!previous || !current) return p;
          return {
            ...p,
            commitTx: current.commitTx !== previous.commitTx ? current.commitTx : p.commitTx,
            registerTx:
              current.registerTx !== previous.registerTx ? current.registerTx : p.registerTx,
            broadcastUnknown:
              current.broadcastUnknown !== previous.broadcastUnknown
                ? current.broadcastUnknown
                : p.broadcastUnknown,
          };
        });
        set({ records: { ...next, plans } });
      }
}

async function saveDetached(
  store: Pick<RecordStore<AccountRecords>, 'load' | 'save'>,
  fn: (r: AccountRecords) => AccountRecords,
) {
  await store.save(fn(await store.load()));
}

/** Serialize a write to an originating account without publishing it to the active session. */
export function writeDetached(
  store: Pick<RecordStore<AccountRecords>, 'load' | 'save'>,
  fn: (r: AccountRecords) => AccountRecords,
) {
  return queueRecordSave(() => saveDetached(store, fn));
}

/** Account selection is disabled while registration wallet work or receipt recovery is pending. */
export async function withPendingTx<T>(run: () => Promise<T>): Promise<T> {
  set({ pendingTxs: state.pendingTxs + 1 });
  try { return await run(); }
  finally { set({ pendingTxs: state.pendingTxs - 1 }); }
}

/** Per-device non-extractable key, separate from all existing embedded-wallet keys. */
async function deviceRecordsKey(): Promise<CryptoKey> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const q = indexedDB.open('fog-registration-progress-v2', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('keys');
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
  try {
    const old = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const q = db.transaction('keys').objectStore('keys').get('records');
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    if (old) return old;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    // add (not put) prevents two first-time tabs from overwriting one another's key.
    try {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction('keys', 'readwrite');
        t.objectStore('keys').add(key, 'records');
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
      return key;
    } catch {
      return await new Promise<CryptoKey>((resolve, reject) => {
        const q = db.transaction('keys').objectStore('keys').get('records');
        q.onsuccess = () =>
          q.result
            ? resolve(q.result)
            : reject(new Error('Cannot save the registration progress key'));
        q.onerror = () => reject(q.error);
      });
    }
  } finally {
    db.close();
  }
}

/** Names the connection step that failed; wallet errors otherwise reach the page without any context. */
export class WalletStepError extends Error {
  constructor(readonly step: string, readonly cause: unknown) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'WalletStepError';
  }
}
const walletStep = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
  console.info(`[Fog wallet] ${step}`);
  try {
    return await run();
  } catch (e) {
    console.error(`[Fog wallet] ${step} failed`, e);
    throw new WalletStepError(step, e);
  }
};

export async function connectExternal(connected: Wallet, provider: WalletProvider) {
  if (!state.reader) {
    await provider.disconnect().catch(() => {});
    throw new Error('Node or registry is not ready.');
  }
  let wallet = connected;
  try {
    await lock();
    requireLiveNetwork();
    const reader = state.reader;
    if (!reader) throw new Error('Node or registry is not ready.');
    await acquireTabLock();
    recordsKey = await deviceRecordsKey();
    let granted;
    // Aztec 6 wallets refuse account and contract calls until Fog holds matching capabilities.
    // Test doubles without capability negotiation skip it; real wallet-sdk wallets always implement it.
    if (typeof (connected as Partial<Wallet>).requestCapabilities === 'function') {
      const { requestFogCapabilities } = await import('fog-sdk');
      const result = await walletStep('authorize accounts and Fog contracts', () =>
        requestFogCapabilities(reader, connected, {
          app: { name: 'Fog Names', version: sdkPackage.version, url: location.origin },
          sponsoredFpc: config.feePayment === 'sponsored' ? config.sponsoredFpc : undefined,
        }),
      );
      wallet = result.wallet;
      granted = result.accounts;
    }
    const accounts = (
      granted ?? (await walletStep('read accounts', () => wallet.getAccounts()))
    ).map((a) => ({
      alias: a.alias,
      address: a.item,
    }));
    if (!accounts.length)
      throw new Error('No account authorized. Authorize an account in your wallet and retry.');
    if (config.feePayment === 'sponsored' && config.sponsoredFpc) {
      const { SponsoredFPCContractArtifact } =
        await import('@aztec-labs/noir-contracts.js/SponsoredFPC');
      const { SponsoredFeePaymentMethod } = await import('@aztec-labs/aztec.js/fee');
      const fpc = await state.node.getContract(config.sponsoredFpc);
      if (!fpc) throw new Error('Configured fee sponsorship contract is unavailable.');
      await verifySponsoredFpc(fpc);
      requireLiveNetwork();
      await walletStep('register fee sponsor', () => wallet.registerContract(fpc, SponsoredFPCContractArtifact));
      paymentMethod = new SponsoredFeePaymentMethod(fpc.address);
    }
    requireLiveNetwork();
    externalProvider = provider;
    unsubscribeProvider = provider.onDisconnect(() => {
      void lock();
    });
    set({
      wallet,
      walletMode: 'external',
      accounts,
      status: 'ready',
      error: undefined,
    });
    // A wallet can retain older account grants when the user adds a fresh account.
    // Do not silently pick the first grant and perform actions on an older account.
    const needsAccountSelection = accounts.length > 1;
    if (!needsAccountSelection)
      await walletStep('register Fog contracts', () => selectAccount(accounts[0].address));
    return { needsAccountSelection };
  } catch (e) {
    await lock();
    await provider.disconnect().catch(() => {});
    throw e;
  }
}

/** Tx history entry that follows SDK status updates. */
export function txRecorder(label: string) {
  const epoch = sessionEpoch;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return (u: { state: TxState; txHash?: string; error?: { message: string } }) =>
    void updateRecords((r) => {
      const prev = r.txs.find((t) => t.id === id);
      const entry: TxRecord = {
        id,
        label,
        at: prev?.at ?? Date.now(),
        txHash: u.txHash ?? prev?.txHash,
        state: u.state,
        error: u.error?.message,
      };
      return {
        ...r,
        txs: [entry, ...r.txs.filter((t) => t.id !== id)].slice(0, 100),
      };
    }, epoch).catch((e) => {
      if (epoch === sessionEpoch) set({ error: e instanceof Error ? e.message : String(e) });
    });
}

/** Preserve receipt hashes and transport uncertainty while the encrypted write completes. */
export function rememberRegistrationProgress(ctx: FogContext, plan: RegistrationPlan) {
  const current = ctx === state.ctx ||
    (ctx === suspendedContext?.ctx && suspendedContext.epoch === sessionEpoch);
  if (!current || !state.records) return;
  // Do not publish a new secret before storage succeeds; only update already persisted plans here.
  set({
    records: {
      ...state.records,
      plans: state.records.plans.map((p) =>
        p.commitment === plan.commitment
          ? {
              ...p,
              commitTx: plan.commitTx,
              registerTx: plan.registerTx,
              broadcastUnknown: plan.broadcastUnknown,
            }
          : p,
      ),
    },
  });
}

/** Bind a multi-step action to the account that started it. */
export function recordWriter(ctx: FogContext) {
  if (ctx !== state.ctx || !recordStore) throw new Error('Wallet account changed. Try the action again.');
  const epoch = sessionEpoch;
  const store = recordStore;
  return (fn: (records: AccountRecords) => AccountRecords) => queueRecordSave(() =>
    epoch === sessionEpoch
      ? saveCurrentRecords(store, fn, epoch)
      : saveDetached(store, fn),
  );
}

/** Read current memory while selected; after a switch, read the captured account's durable records. */
export function recordReader(ctx: FogContext) {
  if (ctx !== state.ctx || !recordStore) throw new Error('Wallet account changed. Try the action again.');
  const epoch = sessionEpoch;
  const store = recordStore;
  return async () => {
    if (epoch === sessionEpoch && state.records) return state.records;
    await saveQueue.catch(() => {});
    return store.load();
  };
}
