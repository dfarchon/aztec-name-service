import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';

import {
  FogContext,
  FogError,
  connectFog,
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
  const ctx = new FogContext(reader, { wallet, account });
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
      connectFog(f.reader, {
        wallet: f.wallet,
        account: f.account,
        deployment: { registry: f.registry.toString(), chainId: '31337', rollupVersion: '1' },
      }),
      (e: FogError) => e.code === 'wrong_deployment',
    );
    assert.deepEqual(f.calls, { accounts: 0, registrations: 0, signatures: 0, sends: 0 });
  }
});

test('connection passes gas estimation and the fee check to the returned context', async () => {
  const f = fixture();
  // The legacy registry artifact is registered against the node's instance.
  Object.assign(f.reader.node, { getContract: async () => ({}) });
  const checkFee = async () => {};
  const deployment = { registry: f.registry.toString(), chainId: '31337', rollupVersion: '1' };
  const ctx = await connectFog(f.reader, { wallet: f.wallet, account: f.account, deployment, estimateGas: true, checkFee });
  assert.equal(ctx.signer.estimateGas, true);
  assert.equal(ctx.signer.checkFee, checkFee);
  const plain = await connectFog(f.reader, { wallet: f.wallet, account: f.account, deployment });
  assert.equal(plain.signer.estimateGas, undefined);
  assert.equal(plain.signer.checkFee, undefined);
});

test('a wallet network change prevents submission even for an existing legacy context', async () => {
  const f = fixture();
  assert.equal((await runTx(f.ctx, f.interaction)).state, 'confirmed');
  f.identity.version = new Fr(2);
  await assert.rejects(runTx(f.ctx, f.interaction), (e: FogError) => e.code === 'wrong_deployment');
  assert.equal(f.calls.sends, 1);
});

test('network mismatch blocks private balance reads, fee authorization and artifact registration', async () => {
  const f = fixture();
  f.identity.chainId = new Fr(1);
  await assert.rejects(
    getPrivateFeeBalance(f.ctx, f.registry),
    (e: FogError) => e.code === 'wrong_deployment',
  );
  await assert.rejects(
    buildFeeAuthorization(f.ctx, {
      feeToken: f.registry,
      treasury: f.account,
      fee: 1n,
      feeNonce: 2n,
    }),
    (e: FogError) => e.code === 'wrong_deployment',
  );
  await assert.rejects(f.ctx.ensureRegistered(), (e: FogError) => e.code === 'wrong_deployment');
  assert.deepEqual(f.calls, { accounts: 0, registrations: 0, signatures: 0, sends: 0 });
});

test('unavailable wallet identity is a network error and never reaches submission', async () => {
  const f = fixture();
  f.wallet.getChainInfo = async () => {
    throw new Error('RPC temporarily unavailable');
  };
  await assert.rejects(runTx(f.ctx, f.interaction), (e: FogError) => e.code === 'network');
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
    (e: FogError) => e.code === 'network' && e.cause instanceof Error,
  );
  f.reader.node.getContract = async () => undefined;
  await assert.rejects(
    readFeeTokenMetadata(f.reader, f.registry, snapshot),
    (e: FogError) => e.code === 'unsupported',
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
  await assert.rejects(pending, (e: FogError) => e.code === 'wrong_deployment');
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
        throw new FogError('network', 'module unavailable');
      },
      {
        onUpdate: (update) => updates.push(update.state),
      },
    ),
    (e: FogError) => e.code === 'network',
  );
  assert.deepEqual(updates, []);
  assert.equal(f.calls.sends, 0);
  await runTx(f.ctx, () => f.interaction);
  assert.equal(f.calls.sends, 1);
});

test('fee authorization asks the wallet for the exact transfer as a call intent bound to the registry', async () => {
  const { computeInnerAuthWitHash, computeInnerAuthWitHashFromAction } = await import('@aztec-labs/aztec.js/authorization');
  const { FunctionSelector } = await import('@aztec-labs/aztec.js/abi');
  const { computeVarArgsHash } = await import('@aztec-labs/stdlib/hash');
  const { FEE_TOKEN_CLASS_ID, TRANSFER_IN_PRIVATE_SIGNATURE } = await import('../src/index.js');
  const f = fixture();
  const token = AztecAddress.fromBigIntUnsafe(7n), treasury = AztecAddress.fromBigIntUnsafe(8n);
  (f.reader.node as any).getContract = async () => ({ currentContractClassId: Fr.fromString(FEE_TOKEN_CLASS_ID) });
  let intent: any;
  f.wallet.createAuthWit = (async (_from: AztecAddress, i: unknown) => { intent = i; return 'witness'; }) as any;
  const witness = await buildFeeAuthorization(f.ctx, { feeToken: token, treasury, fee: 5n, feeNonce: 9n });
  assert.equal(witness, 'witness');
  assert.ok(intent.caller.equals(f.registry));
  assert.ok(intent.call.to.equals(token));
  assert.equal(intent.call.name, 'transfer_in_private');
  const expected = await computeInnerAuthWitHash([
    f.registry.toField(),
    (await FunctionSelector.fromSignature(TRANSFER_IN_PRIVATE_SIGNATURE)).toField(),
    await computeVarArgsHash([f.account.toField(), treasury.toField(), new Fr(5n), new Fr(9n)]),
  ]);
  assert.ok((await computeInnerAuthWitHashFromAction(intent.caller, intent.call)).equals(expected));
});

test('fee token class lookup uses the supplied snapshot rather than latest', async () => {
  const { FEE_TOKEN_CLASS_ID } = await import('../src/client/fee-token.js');
  const address = AztecAddress.fromBigIntUnsafe(987n), blocks: unknown[] = [];
  const snapshot = { blockNumber: 10, blockHash: 'canonical-N', timestamp: 1000n, finality: 'proposed' as const };
  const reader = { node: {
    getContract: async (_address: AztecAddress, block: unknown) => { blocks.push(block); return { currentContractClassId: block === 10 ? FEE_TOKEN_CLASS_ID : Fr.ZERO.toString() }; },
    getPublicStorageAt: async (block: unknown, _address: AztecAddress, slot: Fr) => {
      assert.equal(block, 10); return slot.toBigInt() === 10n ? new Fr(18n) : new Fr(BigInt('0x544f4b'));
    },
  } } as any;
  const result = await readFeeTokenMetadata(reader, address, snapshot);
  assert.equal(result.decimals, 18); assert.equal(result.symbol, 'TOK'); assert.deepEqual(blocks, [10]);
});
