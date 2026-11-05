import assert from 'node:assert/strict';
import test from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { deserializePlan, serializePlan } from '@ans/sdk';
import config from '../launch-rehearsal.json' with { type: 'json' };
import { rehearsalPlan, type RehearsalConfig } from './launch-rehearsal-plan.js';
import { sendRehearsal, rehearsalSendDependencies } from './launch-rehearsal-send.js';
import { V6_PROFILES } from './v6-network.js';

/** All state and keys below are synthetic and stay in memory. No disk, RPC or proving. */
function fixture() {
  const c = config as RehearsalConfig;
  const owner = new AztecAddress(new Fr(1)),
    recipient = new AztecAddress(new Fr(2));
  const registry = new AztecAddress(new Fr(3)),
    resolver = new AztecAddress(new Fr(4));
  const registrar = new AztecAddress(new Fr(5)),
    custom = new AztecAddress(new Fr(6));
  const options = {
    stateDir: '/synthetic/private/rehearsal',
    nodeUrl: V6_PROFILES['testnet-v6'].nodeUrl,
  };
  const plan = rehearsalPlan(c, options.stateDir);
  let saved: any,
    writes = 0,
    counter = 0,
    paused = true,
    now = 100000n,
    selected = resolver;
  let preparedCount = 0,
    walletStops = 0,
    unlocks = 0,
    failAfter: string | undefined;
  let duplicate = false,
    outside = false,
    failSave = false;
  const broadcasts: string[] = [],
    tracked: string[] = [],
    events: string[] = [];
  const memory = (v: unknown) => JSON.parse(JSON.stringify(v));
  const tx = (action = () => {}) => {
    const hash = `0x${(++counter).toString(16).padStart(64, '0')}`;
    return { getTxHash: () => ({ toString: () => hash }), action };
  };
  const raw = {
    getNodeInfo: async () => {
      const p = V6_PROFILES['testnet-v6'];
      return {
        nodeVersion: '6.0.0',
        l1ChainId: 11155111,
        rollupVersion: 679261766,
        realProofs: true,
        l1ContractAddresses: {
          rollupAddress: p.rollup,
          feeJuicePortalAddress: p.feeJuicePortal,
          feeAssetHandlerAddress: p.feeAssetHandler,
        },
      };
    },
    sendTx: async (t: ReturnType<typeof tx>) => {
      const hash = t.getTxHash().toString();
      assert(
        Object.values(saved.transactions).includes(hash),
        'hash must be durable before broadcast',
      );
      broadcasts.push(hash);
      events.push(`broadcast:${hash}`);
      t.action();
    },
    getContractClass: async () => ({}),
    getContract: async () => ({ currentContractClassId: new Fr(42) }),
    getTxReceipt: async () => ({ transactionFee: 1n }),
    getBlock: async () => ({ header: { globalVariables: { timestamp: now } } }),
  };
  let node: any;
  const send = async (action = () => {}) => {
    const t = tx(action);
    await node.sendTx(t);
    if (duplicate) await node.sendTx(t);
  };
  const interaction = (action = () => {}) => ({ send: () => send(action) });
  const methods = {
    bootstrap: () => interaction(),
    set_reserved: () => interaction(),
    set_paused: (value: boolean) =>
      interaction(() => {
        paused = value;
      }),
    admin_commitment: (_r: unknown, _l: unknown, _n: unknown, _g: unknown, expiry: bigint) => ({
      simulate: async () => ({ result: new Fr(expiry) }),
    }),
    commit: () => interaction(),
    admin_register: () => interaction(),
    set_address: () => ({
      simulate: async () => {
        throw Error('unauthorized resolver');
      },
    }),
  };
  const reader = {
    snapshot: async () => ({ timestamp: now }),
    getConfig: async () => ({ launch: { paused } }),
    getModules: async () => ({ registrar }),
    isReserved: async () => true,
    getResolver: async () => selected,
    getAddress: async () => ({ addr: owner }),
    getTransfer: async () => ({ recipient }),
    getCommit: async () => ({ committedAt: now - 100n }),
  };
  class Context {
    account: AztecAddress;
    queue = { run: async (op: () => unknown) => op() };
    constructor(_reader: unknown, o: { account: AztecAddress }) {
      this.account = o.account;
    }
    as(account: AztecAddress) {
      return new Context(reader, { account });
    }
    ensureRegistered = async () => {};
    assertWalletNetwork = async () => {};
  }
  const key = (address: AztecAddress) => ({
    address: address.toString(),
    secret: '1',
    salt: '2',
    signingKey: '3',
  });
  const deps = {
    lstat: async () => ({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: process.getuid!(),
      mode: 0o700,
    }),
    acquireTestnetLock: () => () => {
      unlocks++;
    },
    readKeys: async () => ({
      owner: key(owner),
      treasury: key(recipient),
      salts: { registry: '1', resolver: '2', registrar: '3', token: '4' },
    }),
    open: async () => {
      if (!saved) throw Object.assign(Error('absent'), { code: 'ENOENT' });
      return {
        stat: async () => ({ isFile: () => true, uid: process.getuid!(), mode: 0o600 }),
        readFile: async () => JSON.stringify(saved),
        close: async () => {},
      };
    },
    savePrivateJson: async (path: string, value: any) => {
      if (failSave && Object.keys(value.transactions).length)
        throw Error('synthetic storage failure');
      if (path.endsWith('rehearsal-checkpoint.json')) {
        saved = memory(value);
        writes++;
        events.push('save');
      } else {
        assert(!('registration' in value));
        assert(!('mint' in value));
      }
    },
    trackTx: async (_node: unknown, hash: string) => {
      tracked.push(hash);
      events.push(`track:${hash}`);
      if (failAfter && saved.transactions[failAfter] === hash)
        throw Error('synthetic receipt timeout');
      return {};
    },
    createWallet: async (n: any) => {
      node = n;
      events.push('wallet');
      if (outside) await send();
      let accounts = 0;
      return {
        createSchnorrInitializerlessAccount: async () => ({
          address: accounts++ === 0 ? owner : recipient,
        }),
        stop: async () => {
          walletStops++;
        },
      };
    },
    readFeeJuiceBalance: async () => 1n,
    assertWalletNetwork: async () => {},
    v6Artifacts: async () => ({
      artifacts: { registry: {}, resolver: {}, registrar: {} },
      classIds: {
        registry: new Fr(42).toString(),
        resolver: new Fr(42).toString(),
        registrar: new Fr(42).toString(),
      },
    }),
    instances: async () => ({
      values: Object.fromEntries(
        Object.entries({ registry, resolver, registrar }).map(([k, address]) => [
          k,
          { address, currentContractClassId: new Fr(42) },
        ]),
      ),
      args: { registry: [], resolver: [], registrar: [] },
    }),
    getContractInstanceFromInstantiationParams: async () => ({ address: custom }),
    registryAt: () => ({ address: registry, methods }),
    registrarAt: () => ({ address: registrar, methods }),
    resolverAt: () => ({ address: custom, methods }),
    deploy: () => interaction(),
    connectReader: async () => reader,
    Context,
    prepareRegistration: async (_ctx: unknown, args: { name: string; acceptedQuote?: unknown }) => {
      const code =
        args.name === c.reservedLabels[0]
          ? 'name_reserved'
          : args.name === 'short'
            ? 'name_not_available_yet'
            : paused
              ? 'registration_paused'
              : undefined;
      if (code) throw Object.assign(Error(code), { code });
      if (!args.acceptedQuote) preparedCount++;
      return { name: args.name, quoteExpiry: now + 86400n };
    },
    getFeeQuote: async () => ({}),
    submitCommit: async () => send(),
    submitRegistration: async () => send(),
    waitUntilRegistrable: async () => {},
    inspectHolding: async () => ({
      isHolder: true,
      node: 1n,
      record: { generation: 1 },
      recordRevision: 0,
      snapshot: {},
    }),
    setResolver: async () =>
      send(() => {
        selected = custom;
      }),
    setAddress: async () => send(),
    offerTransfer: async () => send(),
    acceptTransfer: async () =>
      send(() => {
        selected = resolver;
      }),
  } as unknown as typeof rehearsalSendDependencies;
  return {
    run: () => sendRehearsal(options, c, plan, raw as unknown as AztecNode, deps),
    broadcasts,
    tracked,
    events,
    get state() {
      return saved;
    },
    get preparedCount() {
      return preparedCount;
    },
    get stopped() {
      return walletStops;
    },
    get unlocked() {
      return unlocks;
    },
    get writes() {
      return writes;
    },
    set failAfter(value: string | undefined) {
      failAfter = value;
    },
    set duplicate(value: boolean) {
      duplicate = value;
    },
    set outside(value: boolean) {
      outside = value;
    },
    set failSave(value: boolean) {
      failSave = value;
    },
    advance: () => {
      now += 172800n;
    },
    seedUnsent: () => {
      saved = {
        schema: 'ans-v7-rehearsal-checkpoint/1',
        binding: plan.configHash,
        owner: owner.toString(),
        recipient: recipient.toString(),
        transactions: {},
        done: [],
        fees: {},
        registration: serializePlan({ quoteExpiry: 1n } as any),
        mint: { expiry: '1', commitment: new Fr(1).toString(), secret: new Fr(2).toString() },
      };
    },
  };
}

test('sendRehearsal saves each hash before fake-wallet broadcast and completed resume is track-only', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.broadcasts.length, 17);
  assert.equal(new Set(f.broadcasts).size, f.broadcasts.length);
  assert.equal(f.state.done.length, f.broadcasts.length);
  const hashes = [...f.broadcasts],
    eventOffset = f.events.length,
    trackedOffset = f.tracked.length;
  await f.run();
  assert.deepEqual(f.broadcasts, hashes);
  assert.deepEqual(f.tracked.slice(trackedOffset, trackedOffset + hashes.length), hashes);
  assert(f.events.indexOf('wallet', eventOffset) > eventOffset + hashes.length - 1);
  assert.equal(f.preparedCount, 1);
  assert.equal(f.stopped, 2);
  assert.equal(f.unlocked, 2);
});

test('sendRehearsal rejects duplicate fake-wallet sends and uncheckpointed sends', async () => {
  const duplicate = fixture();
  duplicate.duplicate = true;
  await assert.rejects(duplicate.run(), /Duplicate transaction prohibited/);
  assert.equal(duplicate.broadcasts.length, 1);
  assert.equal(duplicate.state.transactions['deploy-registry'], duplicate.broadcasts[0]);
  assert.equal(duplicate.unlocked, 1);
  const outside = fixture();
  outside.outside = true;
  await assert.rejects(outside.run(), /Uncheckpointed broadcast prohibited/);
  assert.equal(outside.broadcasts.length, 0);
  assert.equal(outside.unlocked, 1);
});

test('sendRehearsal storage failure prevents broadcast', async () => {
  const f = fixture();
  f.seedUnsent();
  f.failSave = true;
  await assert.rejects(f.run(), /storage failure/);
  assert.equal(f.broadcasts.length, 0);
});

test('resume-final hash saved before receipt timeout skips paused probe and never rebroadcasts', async () => {
  const f = fixture();
  f.failAfter = 'resume-final';
  await assert.rejects(f.run(), /receipt timeout/);
  assert(f.state.transactions['resume-final']);
  assert(!f.state.done.includes('resume-final'));
  const hashes = [...f.broadcasts],
    registration = f.state.registration,
    mint = { ...f.state.mint };
  f.failAfter = undefined;
  await f.run();
  assert.deepEqual(f.broadcasts, hashes);
  assert(f.state.done.includes('resume-final'));
  assert.equal(f.state.registration, registration);
  assert.deepEqual(f.state.mint, mint);
});

test('unsent registration and mint plans refresh stale expiry before their first commitments', async () => {
  const f = fixture();
  f.seedUnsent();
  f.advance();
  await f.run();
  assert(deserializePlan(f.state.registration).quoteExpiry > 172800n);
  assert(BigInt(f.state.mint.expiry) > 172800n);
  assert.equal(f.preparedCount, 1);
});

test('a saved commitment is retained on ambiguous receipts even after expiry', async () => {
  const f = fixture();
  f.failAfter = 'commit';
  await assert.rejects(f.run(), /receipt timeout/);
  const plan = f.state.registration,
    hashes = [...f.broadcasts];
  f.advance();
  await assert.rejects(f.run(), /receipt timeout/);
  assert.equal(f.state.registration, plan);
  assert.deepEqual(f.broadcasts, hashes);
});

test('admin commitment hash pins its mint expiry across an ambiguous resume', async () => {
  const f = fixture();
  f.failAfter = 'admin-commit';
  await assert.rejects(f.run(), /receipt timeout/);
  const mint = { ...f.state.mint },
    hashes = [...f.broadcasts];
  f.advance();
  await assert.rejects(f.run(), /receipt timeout/);
  assert.deepEqual(f.state.mint, mint);
  assert.deepEqual(f.broadcasts, hashes);
});
