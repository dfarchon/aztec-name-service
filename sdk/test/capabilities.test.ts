import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { AppCapabilities, Wallet, WalletCapabilities } from '@aztec-labs/aztec.js/wallet';

import {
  AnsError,
  ansCapabilityManifest,
  requestAnsCapabilities,
  scopeAnsWallet,
  type RegistryReader,
} from '../src/index.js';

const addr = (n: bigint) => AztecAddress.fromBigIntUnsafe(n);
const account = addr(100n);
const app = { name: 'ANS test', version: '0.7.0', url: 'https://ans.example' };
const rejected = (e: unknown) => e instanceof AnsError && e.code === 'wallet_rejected';

/** Grants exactly what was asked, like a wallet whose user approves every prompt. */
function fakeWallet(
  opts: {
    omitAccountList?: boolean;
    grant?: (m: AppCapabilities) => WalletCapabilities['granted'];
  } = {},
) {
  const requests: AppCapabilities[] = [];
  const registered: string[] = [];
  let accounts = [{ alias: 'Main', item: account }];
  const wallet = {
    getChainInfo: async () => ({ chainId: new Fr(31337), version: new Fr(1) }),
    getAccounts: async () => accounts,
    requestCapabilities: async (manifest: AppCapabilities) => {
      requests.push(manifest);
      const granted =
        opts.grant?.(manifest) ??
        manifest.capabilities.map((c) =>
          c.type === 'accounts' ? { ...c, ...(opts.omitAccountList ? {} : { accounts }) } : c,
        );
      return { version: '1.0', granted, wallet: { name: 'Fake', version: '1' } } as WalletCapabilities;
    },
    registerContract: async (instance: { address: AztecAddress }) => {
      registered.push(instance.address.toString());
    },
  } as unknown as Wallet;
  return { wallet, requests, registered, setAccounts: (a: typeof accounts) => (accounts = a) };
}

const contractsOf = (m: AppCapabilities) =>
  m.capabilities.flatMap((c) =>
    c.type === 'contracts' && c.contracts !== '*' ? c.contracts.map(String) : [],
  );

const reader = (feeToken = addr(4n)) =>
  ({
    registry: addr(1n),
    modular: true,
    deployment: { chainId: 31337n, rollupVersion: 1n },
    snapshot: async () => ({ blockNumber: 1 }),
    getConfig: async () => ({ feeToken }),
    getModules: async () => ({ registrar: addr(2n), resolver: addr(3n) }),
  }) as unknown as RegistryReader;

test('the manifest names only ANS contracts, drops zero addresses and asks for no address book or events', () => {
  const m = ansCapabilityManifest([addr(1n), addr(2n), addr(1n), AztecAddress.ZERO], app);
  assert.deepEqual(contractsOf(m), [addr(1n).toString(), addr(2n).toString()]);
  assert.deepEqual(
    m.capabilities.map((c) => c.type),
    ['accounts', 'contracts', 'simulation', 'transaction'],
  );
  // Functions may be '*' within a named contract; the contract itself never is.
  for (const c of m.capabilities) {
    if (c.type === 'contracts') assert.notEqual(c.contracts, '*');
    const scopes = c.type === 'transaction' ? [c.scope] : c.type === 'simulation' ? [c.transactions?.scope, c.utilities?.scope] : [];
    for (const scope of scopes) {
      assert.ok(Array.isArray(scope));
      assert.ok(scope.every((p) => p.contract !== '*' && !p.additionalScopes));
    }
  }
  assert.deepEqual(m.metadata, app);
});

test('requestAnsCapabilities asks for the registry, active modules, payment token and sponsor', async () => {
  const f = fakeWallet();
  const { accounts } = await requestAnsCapabilities(reader(), f.wallet, { app, sponsoredFpc: addr(5n) });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(contractsOf(f.requests[0]), [1n, 4n, 2n, 3n, 5n].map((n) => addr(n).toString()));
  assert.equal(accounts.length, 1);
  assert.ok(accounts[0].item.equals(account));
});

test('a free registrar with no payment token asks for no token contract', async () => {
  const f = fakeWallet();
  await requestAnsCapabilities(reader(AztecAddress.ZERO), f.wallet, { app });
  assert.deepEqual(contractsOf(f.requests[0]), [1n, 2n, 3n].map((n) => addr(n).toString()));
});

test('a wallet on another network is refused before any permission request', async () => {
  const f = fakeWallet();
  f.wallet.getChainInfo = async () => ({ chainId: new Fr(1), version: new Fr(1) }) as never;
  await assert.rejects(
    requestAnsCapabilities(reader(), f.wallet, { app }),
    (e: AnsError) => e.code === 'wrong_deployment',
  );
  assert.equal(f.requests.length, 0);
});

test('a grant without an explicit account list falls back to the wallet account list', async () => {
  const f = fakeWallet({ omitAccountList: true });
  const accounts = await scopeAnsWallet(f.wallet, app).authorize([addr(1n)]);
  assert.equal(accounts.length, 1);
});

test('a partial grant fails closed', async () => {
  const noSend = fakeWallet({
    grant: (m) => m.capabilities.filter((c) => c.type !== 'transaction') as WalletCapabilities['granted'],
  });
  await assert.rejects(scopeAnsWallet(noSend.wallet, app).authorize([addr(1n)]), rejected);
  const noSigning = fakeWallet({
    grant: (m) =>
      m.capabilities.map((c) =>
        c.type === 'accounts' ? { ...c, canCreateAuthWit: false, accounts: [] } : c,
      ),
  });
  await assert.rejects(scopeAnsWallet(noSigning.wallet, app).authorize([addr(1n)]), rejected);
});

test('registering a contract outside the grant widens it first and keeps earlier contracts', async () => {
  const f = fakeWallet();
  const scoped = scopeAnsWallet(f.wallet, app);
  await scoped.authorize([addr(1n)]);
  await scoped.wallet.registerContract({ address: addr(1n) } as never);
  assert.equal(f.requests.length, 1);
  await scoped.wallet.registerContract({ address: addr(9n) } as never);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(contractsOf(f.requests[1]), [addr(1n).toString(), addr(9n).toString()]);
  assert.deepEqual(f.registered, [addr(1n).toString(), addr(9n).toString()]);
});

test('a widened grant that drops the session account ends the session', async () => {
  const f = fakeWallet();
  const scoped = scopeAnsWallet(f.wallet, app);
  await scoped.authorize([addr(1n)]);
  f.setAccounts([{ alias: 'Other', item: addr(200n) }]);
  await assert.rejects(scoped.wallet.registerContract({ address: addr(9n) } as never), rejected);
  assert.deepEqual(f.registered, []);
});
