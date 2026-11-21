import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNetworkConfig, canDeriveSponsor } from '../src/network-config.js';
import {
  FeeJuiceInsufficientError,
  feeJuiceError,
  insufficientFeeJuice,
} from '../src/fee-juice-error.js';
import {
  assertFeeJuice,
  assertFeeJuiceFunded,
  feeJuiceWallet,
  readFeeJuiceBalance,
  requiredFeeJuice,
} from '../src/fee-juice.js';
import { errorMessage } from '../src/format.js';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { Gas, GasFees } from '@aztec-labs/stdlib/gas';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
const account = new AztecAddress(new Fr(42));
test('public config requires explicit network and fee mode; local DEV defaults sponsored', () => {
  assert.deepEqual(parseNetworkConfig({ DEV: true }), {
    network: 'local',
    feePayment: 'sponsored',
    allowRehearsalSuccessor: false,
  });
  for (const env of [
    {},
    { VITE_NETWORK: 'wrong' },
    { VITE_NETWORK: 'testnet-v6' },
    { VITE_NETWORK: 'mainnet', VITE_FEE_PAYMENT: 'sponsored' },
    { VITE_NETWORK: 'testnet-v6', VITE_FEE_PAYMENT: 'wrong' },
  ])
    assert.throws(() => parseNetworkConfig(env));
  assert.equal(
    parseNetworkConfig({ VITE_NETWORK: 'mainnet', VITE_FEE_PAYMENT: 'fee-juice' }).feePayment,
    'fee-juice',
  );
});
test('FPC derivation is confined to proof-disabled local chain identity', () => {
  assert(canDeriveSponsor({ l1ChainId: 31337, realProofs: false }));
  for (const info of [
    { l1ChainId: 1, realProofs: true },
    { l1ChainId: 11155111, realProofs: false },
    { l1ChainId: 31337, realProofs: true },
  ])
    assert(!canDeriveSponsor(info));
});
test('Fee Juice pre-send check uses the wallet fee padding and the estimated gas when given', async () => {
  let value = 0n;
  const node = {
    getPublicStorageAt: async () => new Fr(value),
    getCurrentMinFees: async () => new GasFees(2n, 3n),
    getNodeInfo: async () => ({ txsLimits: { gas: { daGas: 10, l2Gas: 20 } } }),
  } as unknown as AztecNode;
  // No estimate: the whole per-transaction limit at min fees + 50% = 10 * 3 + 20 * 4.
  await assert.rejects(
    assertFeeJuice(node, account),
    (e) => e instanceof FeeJuiceInsufficientError && e.balance === 0n && e.required === 110n,
  );
  value = 109n;
  await assert.rejects(assertFeeJuice(node, account), FeeJuiceInsufficientError);
  value = 110n;
  await assertFeeJuice(node, account);
  assert.equal(await readFeeJuiceBalance(node, account), 110n);
  // An estimate of 2 DA and 5 L2 gas needs only 2 * 3 + 5 * 4.
  value = 26n;
  await assertFeeJuice(node, account, new Gas(2, 5));
  value = 25n;
  await assert.rejects(
    assertFeeJuice(node, account, new Gas(2, 5)),
    (e) => e instanceof FeeJuiceInsufficientError && e.required === 26n,
  );
});
test('predicted fees take precedence; an empty account fails the fast check before simulation', async () => {
  const node = {
    getPublicStorageAt: async () => new Fr(0n),
    getCurrentMinFees: async () => new GasFees(1n, 1n),
    getPredictedMinFees: async () => [new GasFees(2n, 2n), new GasFees(4n, 4n)],
    getNodeInfo: async () => ({ txsLimits: { gas: { daGas: 1, l2Gas: 1 } } }),
  } as unknown as AztecNode;
  assert.equal(await requiredFeeJuice(node, new Gas(1, 1)), 12n);
  await assert.rejects(assertFeeJuiceFunded(node, account), FeeJuiceInsufficientError);
});
test('simulation insufficient fee payer balance maps to same typed error; ordinary failures remain unchanged', async () => {
  const node = { getPublicStorageAt: async () => new Fr(1) } as unknown as AztecNode;
  let failure = new Error('fee payer balance too low');
  const wallet = {
    sendTx: async () => {
      throw failure;
    },
  } as unknown as Wallet;
  const guarded = feeJuiceWallet(wallet, node);
  assert.equal(feeJuiceWallet(wallet, node), guarded);
  await assert.rejects(
    (guarded.sendTx as any)({}, { from: account }),
    (e: unknown) =>
      e instanceof FeeJuiceInsufficientError &&
      e.account === account.toString() &&
      e.balance === 1n,
  );
  failure = new Error('network unavailable');
  await assert.rejects((guarded.sendTx as any)({}, { from: account }), (e) => e === failure);
  assert(insufficientFeeJuice({ cause: new Error('Insufficient fee payer balance') }));
});
test('insufficient message preserves the public account and balance and explains funding', () => {
  const err = new FeeJuiceInsufficientError(account.toString(), 12n);
  assert.equal(feeJuiceError({ cause: err }), err);
  const message = errorMessage({ cause: err });
  assert(message.includes(account.toString()));
  assert.match(message, /12 wei.*L1.*registration token/);
});
test('a wallet that picks the fee payer gets no public balance read and a wallet-side funding message', async () => {
  let reads = 0;
  const node = {
    getPublicStorageAt: async () => {
      reads++;
      return new Fr(0n);
    },
  } as unknown as AztecNode;
  const wallet = {
    sendTx: async () => {
      throw new Error('Insufficient fee payer balance');
    },
  } as unknown as Wallet;
  const guarded = feeJuiceWallet(wallet, node, { walletPicksPayer: true });
  await assert.rejects(
    (guarded.sendTx as any)({}, { from: account }),
    (e: unknown) =>
      e instanceof FeeJuiceInsufficientError && e.account === account.toString() && e.balance === undefined,
  );
  assert.equal(reads, 0);
  const message = errorMessage(new FeeJuiceInsufficientError(account.toString()));
  assert(message.includes(account.toString()));
  assert.match(message, /wallet.*private.*registration token/);
  assert.doesNotMatch(message, /wei|Bridge/);
});
