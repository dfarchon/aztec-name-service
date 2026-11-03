import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosingAccount } from '../src/account-state.ts';

type AccountState = Parameters<typeof choosingAccount>[0];
const wallet = {} as NonNullable<AccountState['wallet']>;
const address = {} as NonNullable<AccountState['selectingAccount']>;
const account = { alias: 'Fixture', address };

test('one authorized account does not require a choice', () => {
  assert.equal(choosingAccount({ wallet, accounts: [account] }), false);
});

test('several authorized accounts require an explicit choice', () => {
  assert.equal(choosingAccount({ wallet, accounts: [account, account] }), true);
});

test('an account selection in progress does not prompt for another choice', () => {
  assert.equal(
    choosingAccount({ wallet, accounts: [account, account], selectingAccount: address }),
    false,
  );
});

test('a disconnected wallet does not require an account choice', () => {
  assert.equal(choosingAccount({ accounts: [account, account] }), false);
});

test('an active account does not require another choice', () => {
  const ctx = {} as NonNullable<AccountState['ctx']>;
  assert.equal(choosingAccount({ wallet, accounts: [account, account], ctx }), false);
});
