import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type {
  Aliased,
  AppCapabilities,
  ContractFunctionPattern,
  Wallet,
  WalletCapabilities,
} from '@aztec-labs/aztec.js/wallet';
import type { ContractInstanceWithAddress } from '@aztec-labs/stdlib/contract';

import type { RegistryReader } from '../client/reader.js';
import { FogError } from '../core/errors.js';
import { assertWalletNetwork } from './network.js';

/** Shown by the wallet in its permission prompt. */
export type FogAppMetadata = {
  name: string;
  version: string;
  url?: string;
  description?: string;
  icon?: string;
};

type Granted = WalletCapabilities['granted'];

const covers = (scope: '*' | ContractFunctionPattern[] | undefined, address: AztecAddress) =>
  scope === '*' ||
  !!scope?.some((p) => p.function === '*' && (p.contract === '*' || p.contract.equals(address)));

/** Registration, transaction and utility simulation, and sending are all granted for `address`. */
export function grantsFogContract(granted: Granted, address: AztecAddress) {
  return (
    granted.some(
      (c) =>
        c.type === 'contracts' &&
        !!c.canRegister &&
        (c.contracts === '*' || c.contracts.some((a) => a.equals(address))),
    ) &&
    granted.some((c) => c.type === 'simulation' && covers(c.transactions?.scope, address)) &&
    granted.some((c) => c.type === 'simulation' && covers(c.utilities?.scope, address)) &&
    granted.some((c) => c.type === 'transaction' && covers(c.scope, address))
  );
}

const unique = (contracts: AztecAddress[]) => [
  ...new Map(contracts.filter((a) => !a.isZero()).map((a) => [a.toString(), a])).values(),
];

/** Only the named contracts: no address book, private events or wildcard contract access. */
export function fogCapabilityManifest(contracts: AztecAddress[], app: FogAppMetadata): AppCapabilities {
  const addresses = unique(contracts);
  const scope = addresses.map((contract) => ({ contract, function: '*' }));
  return {
    version: '1.0',
    metadata: app,
    capabilities: [
      { type: 'accounts', canGet: true, canCreateAuthWit: true },
      { type: 'contracts', contracts: addresses, canRegister: true, canGetMetadata: true },
      { type: 'simulation', transactions: { scope }, utilities: { scope } },
      { type: 'transaction', scope },
    ],
  };
}

/** Every contract the deployment needs before an account opens; later ones are granted on first use. */
export async function fogSessionContracts(reader: RegistryReader, sponsoredFpc?: AztecAddress) {
  const snap = await reader.snapshot();
  const policy = await reader.getConfig(snap);
  const contracts = [reader.registry, policy.feeToken];
  if (reader.modular) {
    const modules = await reader.getModules(snap);
    contracts.push(modules.registrar, modules.resolver);
  }
  if (sponsoredFpc) contracts.push(sponsoredFpc);
  return unique(contracts);
}

/**
 * Accounts the wallet lets Fog read and sign payment authorizations for. A wallet may omit the account list from
 * a grant (accounts are known only after connecting); the wallet's own account list then applies.
 */
function authorizedAccounts(granted: Granted, available: Aliased<AztecAddress>[]) {
  const grants = granted.filter((c) => c.type === 'accounts');
  const allows = (flag: 'canGet' | 'canCreateAuthWit', a: AztecAddress) =>
    grants.some((c) => c[flag] && (!c.accounts || c.accounts.some((x) => x.item.equals(a))));
  return available.filter((a) => allows('canGet', a.item) && allows('canCreateAuthWit', a.item));
}

/**
 * Aztec 6 wallets refuse account and contract calls until the app holds matching capabilities. The returned
 * wallet asks for a missing contract grant before `registerContract`, keeping every earlier contract: a name can
 * keep its own Resolver, and an administrator can activate a new Registrar or payment token mid-session. A
 * narrower account grant ends the session with `wallet_rejected` instead of switching accounts.
 */
export function scopeFogWallet(wallet: Wallet, app: FogAppMetadata) {
  const contracts = new Map<string, AztecAddress>();
  let granted: Granted = [];
  let accounts: Aliased<AztecAddress>[] | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(step: () => Promise<T>) => {
    const run = tail.then(step);
    tail = run.catch(() => {});
    return run;
  };
  const request = async (next: AztecAddress[]) => {
    const requested = unique([...contracts.values(), ...next]);
    const response = await wallet.requestCapabilities(fogCapabilityManifest(requested, app));
    const allowed = authorizedAccounts(response.granted, await wallet.getAccounts());
    if (!allowed.length)
      throw new FogError('wallet_rejected', 'no account allows Fog to read it and sign payment authorizations');
    if (requested.some((a) => !grantsFogContract(response.granted, a)))
      throw new FogError('wallet_rejected', 'Fog contract permissions were not fully granted');
    if (accounts?.some((a) => !allowed.some((x) => x.item.equals(a.item))))
      throw new FogError('wallet_rejected', 'wallet account permissions changed; reconnect the wallet');
    for (const address of requested) contracts.set(address.toString(), address);
    granted = response.granted;
    accounts ??= allowed;
    return accounts;
  };
  const registerContract: Wallet['registerContract'] = async (instance, ...rest) => {
    const address = (instance as Partial<ContractInstanceWithAddress>).address;
    if (!address) throw new FogError('invalid_argument', 'Fog registers only deployed contracts');
    await serial(async () => {
      if (!grantsFogContract(granted, address)) await request([address]);
    });
    return wallet.registerContract(instance, ...rest);
  };
  return {
    wallet: new Proxy(wallet, {
      get(target, property) {
        if (property === 'registerContract') return registerContract;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Wallet,
    authorize: (initial: AztecAddress[]) => serial(() => request(initial)),
  };
}

/**
 * Check the wallet network, then ask once for every contract the deployment uses. Use the returned wallet for
 * `connectFog`; it requests later contracts before registering them. Returns the accounts Fog may act for.
 */
export async function requestFogCapabilities(
  reader: RegistryReader,
  wallet: Wallet,
  options: { app: FogAppMetadata; sponsoredFpc?: AztecAddress },
) {
  await assertWalletNetwork(wallet, reader.deployment);
  const scoped = scopeFogWallet(wallet, options.app);
  const accounts = await scoped.authorize(await fogSessionContracts(reader, options.sponsoredFpc));
  return { wallet: scoped.wallet, accounts };
}
