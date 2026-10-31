import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';

import {
  AnsContext,
  AnsError,
  connectAns,
  getPrivateFeeBalance,
  buildFeeAuthorization,
  readFeeTokenMetadata,
  runTx,
  type RegistryReader,
} from '../src/index.js';

function fixture() {
  const account = AztecAddress.fromBigIntUnsafe(1n),
    registry = AztecAddress.fromBigIntUnsafe(2n);
  const identity = { chainId: new Fr(31337), version: new Fr(1) };
  const calls = { accounts: 0, registrations: 0, signatures: 0, sends: 0 };
  const reader = {
    registry,
    modular: false,
    deployment: { chainId: 31337n, rollupVersion: 1n },
    node: {
      getTxReceipt: async () => ({
        status: TxStatus.CHECKPOINTED,
        hasExecutionReverted: () => false,
      }),
    },
  } as unknown as RegistryReader;
  const wallet = {
    getChainInfo: async () => identity,
    getAccounts: async () => {
      calls.accounts++;
      return [{ item: account, alias: 'Authorized' }];
    },
    registerContract: async () => {
      calls.registrations++;
    },
    createAuthWit: async () => {
      calls.signatures++;
    },
  } as unknown as Wallet;
  const ctx = new AnsContext(reader, { wallet, account });
  const interaction = {
    send: async () => {
      calls.sends++;
      return { txHash: TxHash.random() };
    },
  } as unknown as ContractFunctionInteraction;
  return { identity, calls, reader, wallet, ctx, interaction, account, registry };
}

test('connection rejects a mismatched chain or rollup before requesting accounts or registering artifacts', async () => {
  for (const field of ['chainId', 'version'] as const) {
    const f = fixture();
    f.identity[field] = new Fr(999);
    await assert.rejects(
      connectAns(f.reader, {
        wallet: f.wallet,
        account: f.account,
        deployment: { registry: f.registry.toString(), chainId: '31337', rollupVersion: '1' },
      }),
      (e: AnsError) => e.code === 'wrong_deployment',
    );
    assert.deepEqual(f.calls, { accounts: 0, registrations: 0, signatures: 0, sends: 0 });
  }
});

test('a wallet network change prevents submission even for an existing legacy context', async () => {
  const f = fixture();
  assert.equal((await runTx(f.ctx, f.interaction)).state, 'confirmed');
  f.identity.version = new Fr(2);
  await assert.rejects(runTx(f.ctx, f.interaction), (e: AnsError) => e.code === 'wrong_deployment');
  assert.equal(f.calls.sends, 1);
});

test('network mismatch blocks private balance reads, fee authorization and artifact registration', async () => {
  const f = fixture();
  f.identity.chainId = new Fr(1);
  await assert.rejects(
    getPrivateFeeBalance(f.ctx, f.registry),
    (e: AnsError) => e.code === 'wrong_deployment',
  );
  await assert.rejects(
    buildFeeAuthorization(f.ctx, {
      feeToken: f.registry,
      treasury: f.account,
      fee: 1n,
      feeNonce: 2n,
    }),
    (e: AnsError) => e.code === 'wrong_deployment',
  );
  await assert.rejects(f.ctx.ensureRegistered(), (e: AnsError) => e.code === 'wrong_deployment');
  assert.deepEqual(f.calls, { accounts: 0, registrations: 0, signatures: 0, sends: 0 });
});

test('unavailable wallet identity is a network error and never reaches submission', async () => {
  const f = fixture();
  f.wallet.getChainInfo = async () => {
    throw new Error('RPC temporarily unavailable');
  };
  await assert.rejects(runTx(f.ctx, f.interaction), (e: AnsError) => e.code === 'network');
  assert.equal(f.calls.sends, 0);
});

test('fee metadata transport failures use stable SDK errors instead of raw RPC exceptions', async () => {
  const f = fixture();
  f.reader.node.getContract = async () => {
    throw new Error('RPC temporarily unavailable');
  };
  const snapshot = {
    blockNumber: 10,
    blockHash: 'block-10',
    timestamp: 100n,
    finality: 'proposed' as const,
  };
  await assert.rejects(
    readFeeTokenMetadata(f.reader, f.registry, snapshot),
    (e: AnsError) => e.code === 'network' && e.cause instanceof Error,
  );
  f.reader.node.getContract = async () => undefined;
  await assert.rejects(
    readFeeTokenMetadata(f.reader, f.registry, snapshot),
    (e: AnsError) => e.code === 'unsupported',
  );
});

test('deferred module selection runs only inside the shared wallet queue after network validation', async () => {
  const f = fixture();
  let selections = 0;
  let release!: () => void;
  const gate = f.ctx.queue.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const pending = runTx(f.ctx, () => {
    selections++;
    return f.interaction;
  });
  assert.equal(selections, 0);
  f.identity.version = new Fr(99);
  release();
  await gate;
  await assert.rejects(pending, (e: AnsError) => e.code === 'wrong_deployment');
  assert.equal(selections, 0);
  assert.equal(f.calls.sends, 0);
  f.identity.version = new Fr(1);
  await runTx(f.ctx, () => {
    selections++;
    return f.interaction;
  });
  assert.equal(selections, 1);
  assert.equal(f.calls.sends, 1);
});

test('a module selection failure before send emits no unknown broadcast and can be retried', async () => {
  const f = fixture(),
    updates: string[] = [];
  await assert.rejects(
    runTx(
      f.ctx,
      () => {
        throw new AnsError('network', 'module unavailable');
      },
      {
        onUpdate: (update) => updates.push(update.state),
      },
    ),
    (e: AnsError) => e.code === 'network',
  );
  assert.deepEqual(updates, []);
  assert.equal(f.calls.sends, 0);
  await runTx(f.ctx, () => f.interaction);
  assert.equal(f.calls.sends, 1);
});
