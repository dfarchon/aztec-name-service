import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNetworkConfig, canDeriveSponsor } from '../src/network-config.js';
import {
  FeeJuiceInsufficientError,
  feeJuiceError,
  insufficientFeeJuice,
} from '../src/fee-juice-error.js';
import { assertFeeJuice, feeJuiceWallet, readFeeJuiceBalance } from '../src/fee-juice.js';
import { errorMessage } from '../src/format.js';
import { setLocale } from '../src/i18n.js';
import { zhCN } from '../src/locales/zh-CN.js';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { GasFees } from '@aztec-labs/stdlib/gas';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
const account = new AztecAddress(new Fr(42));
test('public config requires explicit network and fee mode; local DEV defaults sponsored', () => {
  assert.deepEqual(parseNetworkConfig({ DEV: true }), {
    network: 'local',
    feePayment: 'sponsored',
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
test('Fee Juice pre-send check rejects zero and insufficient estimate, accepts funded account', async () => {
  let value = 0n;
  const node = {
    getPublicStorageAt: async () => new Fr(value),
    getCurrentMinFees: async () => new GasFees(2n, 3n),
    getNodeInfo: async () => ({ txsLimits: { gas: { daGas: 10, l2Gas: 20 } } }),
  } as unknown as AztecNode;
  await assert.rejects(
    assertFeeJuice(node, account),
    (e) => e instanceof FeeJuiceInsufficientError && e.balance === 0n && e.required === 80n,
  );
  value = 79n;
  await assert.rejects(assertFeeJuice(node, account), FeeJuiceInsufficientError);
  value = 80n;
  await assertFeeJuice(node, account);
  assert.equal(await readFeeJuiceBalance(node, account), 80n);
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
test('zh/en insufficient message preserves public account/balance and explains L1 and registration token', () => {
  const err = new FeeJuiceInsufficientError(account.toString(), 12n);
  assert.equal(feeJuiceError({ cause: err }), err);
  try {
    setLocale('en');
    const en = errorMessage({ cause: err });
    assert(en.includes(account.toString()));
    assert.match(en, /12 wei.*L1.*registration token/);
    setLocale('zh-CN');
    const zh = errorMessage({ cause: err });
    assert(zh.includes(account.toString()));
    assert.match(zh, /12 wei.*L1.*注册费代币/);
    assert(zhCN["Network fees are paid from this account's Fee Juice."]);
  } finally {
    setLocale('en');
  }
});
