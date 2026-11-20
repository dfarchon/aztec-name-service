import type { ContractArtifact } from '@aztec-labs/aztec.js/abi';
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';

import { FogError } from '../core/errors.js';
import { registryProtocols } from '../core/registry-protocol.js';

/**
 * The single classId → contract binding table. Every artifact is a dynamic import, so a deployment
 * downloads only the registry, Registrar and Resolver it actually uses (each artifact is 1.5–3 MB of JSON).
 */
type ProtocolKey = keyof typeof registryProtocols;
/** Module implementations `RegistryReader.assertModule` can return. */
export type ModuleKind = 'registrar' | 'registrarTiered' | 'registrarLaunch' | 'resolver';

/** Registries with V4 record extensions (subnames, text records, managers, transfers). */
const extendedBindings = {
  extended: () => import('../artifacts/NameRegistryV4.js').then((m) => m.NameRegistryV4Contract),
  current: () => import('../artifacts/NameRegistryV5.js').then((m) => m.NameRegistryV5Contract),
  v6: () => import('../artifacts/NameRegistryV6.js').then((m) => m.NameRegistryV6Contract),
  v7: () => import('../artifacts/NameRegistryV7.js').then((m) => m.NameRegistryV7Contract),
  v8: () => import('../artifacts/NameRegistryV8.js').then((m) => m.NameRegistryV8Contract),
  v8Rehearsal: () =>
    import('../artifacts/NameRegistryV8Rehearsal.js').then(
      (m) => m.NameRegistryV8RehearsalContract,
    ),
};

const registryBindings = {
  ...extendedBindings,
  legacy: () => import('../artifacts/NameRegistry.js').then((m) => m.NameRegistryContract),
  modular: () => import('../artifacts/NameRegistryV3.js').then((m) => m.NameRegistryV3Contract),
  // The upgrade-test class keeps the V3 call surface; only its wallet artifact differs (see below).
  upgraded: () => import('../artifacts/NameRegistryV3.js').then((m) => m.NameRegistryV3Contract),
} satisfies Record<ProtocolKey, unknown>;

const walletArtifacts: Record<ProtocolKey, () => Promise<ContractArtifact>> = {
  ...(Object.fromEntries(
    Object.entries(registryBindings).map(([key, load]) => [
      key,
      () => load().then((c) => c.artifact),
    ]),
  ) as Record<ProtocolKey, () => Promise<ContractArtifact>>),
  upgraded: () =>
    import('../artifacts/RegistryUpgradeTest.js').then(
      (m) => m.RegistryUpgradeTestContract.artifact,
    ),
};

const moduleBindings = {
  registrar: () => import('../artifacts/NameRegistrar.js').then((m) => m.NameRegistrarContract),
  registrarTiered: () =>
    import('../artifacts/NameRegistrarTiered.js').then((m) => m.NameRegistrarTieredContract),
  registrarLaunch: () =>
    import('../artifacts/NameRegistrarLaunch.js').then((m) => m.NameRegistrarLaunchContract),
  resolver: () => import('../artifacts/NameResolver.js').then((m) => m.NameResolverContract),
} satisfies Record<ModuleKind, unknown>;

type Loaded<T> = T extends () => Promise<infer C> ? C : never;
type Instance<T> =
  Loaded<T> extends { at(address: AztecAddress, wallet: Wallet): infer I } ? I : never;
type Bindings = typeof registryBindings;

export type ExtendedRegistryContract = Instance<Bindings[keyof typeof extendedBindings]>;
export type RegistryContract = Instance<Bindings[ProtocolKey]>;
export type LegacyRegistryContract = Instance<Bindings['legacy']>;
export type ModuleContract<K extends ModuleKind> = Instance<(typeof moduleBindings)[K]>;

const keyByClass = new Map(
  Object.entries(registryProtocols).map(([key, p]) => [p.classId, key as ProtocolKey]),
);

function protocolKey(classId: string): ProtocolKey {
  const key = keyByClass.get(classId);
  if (!key)
    throw new FogError('wrong_deployment', 'registry class has no supported wallet artifact');
  return key;
}

export async function registryContract(
  classId: string,
  address: AztecAddress,
  wallet: Wallet,
): Promise<RegistryContract> {
  return (await registryBindings[protocolKey(classId)]()).at(address, wallet);
}

/** V2 registry: registration, renewal and forward records live on the registry itself. */
export async function legacyRegistryContract(address: AztecAddress, wallet: Wallet) {
  return (await registryBindings.legacy()).at(address, wallet);
}

export async function extendedRegistryContract(
  classId: string,
  address: AztecAddress,
  wallet: Wallet,
): Promise<ExtendedRegistryContract> {
  const key = protocolKey(classId);
  if (!(key in extendedBindings))
    throw new FogError('invalid_argument', 'this feature requires registry V4');
  return (await extendedBindings[key as keyof typeof extendedBindings]()).at(address, wallet);
}

/** The exact artifact the wallet needs to execute this registry class's private functions. */
export function registryWalletArtifact(classId: string): Promise<ContractArtifact> {
  return walletArtifacts[protocolKey(classId)]();
}

export async function moduleContract<K extends ModuleKind>(
  kind: K,
  address: AztecAddress,
  wallet: Wallet,
): Promise<ModuleContract<K>> {
  return (await moduleBindings[kind]()).at(address, wallet) as ModuleContract<K>;
}

export async function moduleArtifact(kind: ModuleKind): Promise<ContractArtifact> {
  return (await moduleBindings[kind]()).artifact;
}
