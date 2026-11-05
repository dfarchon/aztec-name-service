import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { ContractArtifact } from '@aztec-labs/aztec.js/abi';
import type { InteractionFeeOptions } from '@aztec-labs/aztec.js/contracts';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';

import { NameRegistryContract } from '../artifacts/NameRegistry.js';
import { NameRegistryV7Contract } from '../artifacts/NameRegistryV7.js';
import { NameRegistryV6Contract } from '../artifacts/NameRegistryV6.js';
import { NameRegistryV5Contract } from '../artifacts/NameRegistryV5.js';
import { NameRegistryV4Contract } from '../artifacts/NameRegistryV4.js';
import { NameRegistryV3Contract } from '../artifacts/NameRegistryV3.js';
import { NameRegistrarContract } from '../artifacts/NameRegistrar.js';
import { NameRegistrarLaunchContract } from '../artifacts/NameRegistrarLaunch.js';
import { NameRegistrarTieredContract } from '../artifacts/NameRegistrarTiered.js';
import { NameResolverContract } from '../artifacts/NameResolver.js';
import { RegistryUpgradeTestContract } from '../artifacts/RegistryUpgradeTest.js';
import { registryProtocols } from '../core/registry-protocol.js';
import type { Snapshot } from '../core/types.js';
import type { RegistryReader } from '../client/reader.js';
import { AnsError } from '../core/errors.js';
import { ExecutionQueue } from './queue.js';
import { FEE_TOKEN_CLASS_ID } from '../client/fee-token.js';
import { assertWalletNetwork } from './network.js';

/** An existing wallet plus the account acting in it. The SDK never receives keys. */
export type AnsSigner = {
  wallet: Wallet;
  account: AztecAddress;
  /** Network fee payment, e.g. a sponsored FPC. Omit to let the wallet pay from the account's fee juice. */
  fee?: InteractionFeeOptions;
  /** Host validation inside the shared queue, after identity checks and before submission. Cannot broadcast. */
  beforeSend?: (account: AztecAddress) => Promise<void>;
};

const queues = new WeakMap<Wallet, ExecutionQueue>();
const registryArtifacts = new Map<string, ContractArtifact>([
  [registryProtocols.legacy.classId, NameRegistryContract.artifact],
  [registryProtocols.modular.classId, NameRegistryV3Contract.artifact],
  [registryProtocols.upgraded.classId, RegistryUpgradeTestContract.artifact],
  [registryProtocols.extended.classId, NameRegistryV4Contract.artifact],
  [registryProtocols.current.classId, NameRegistryV5Contract.artifact],
  [registryProtocols.v6.classId, NameRegistryV6Contract.artifact],
  [registryProtocols.v7.classId, NameRegistryV7Contract.artifact],
]);

/** Reader + signer. Write operations and wallet-local utilities go through here. */
export class AnsContext {
  readonly queue: ExecutionQueue;

  constructor(
    readonly reader: RegistryReader,
    readonly signer: AnsSigner,
  ) {
    let q = queues.get(signer.wallet);
    if (!q) queues.set(signer.wallet, (q = new ExecutionQueue()));
    this.queue = q;
  }

  get account() {
    return this.signer.account;
  }

  get wallet() {
    return this.signer.wallet;
  }

  /** Recheck inside the wallet queue before private reads, authorization or transaction submission. */
  assertWalletNetwork() {
    return assertWalletNetwork(this.wallet, this.reader.deployment);
  }

  /** Same wallet and deployment, different account (e.g. the game account next to the name holder). */
  as(account: AztecAddress, fee = this.signer.fee): AnsContext {
    return new AnsContext(this.reader, { ...this.signer, account, fee });
  }

  extendedContract() {
    if (!this.reader.extended)
      throw new AnsError('invalid_argument', 'this feature requires registry V4');
    if (this.reader.classId === registryProtocols.v7.classId)
      return NameRegistryV7Contract.at(this.reader.registry, this.wallet);
    if (this.reader.classId === registryProtocols.v6.classId)
      return NameRegistryV6Contract.at(this.reader.registry, this.wallet);
    return this.reader.classId === registryProtocols.current.classId
      ? NameRegistryV5Contract.at(this.reader.registry, this.wallet)
      : NameRegistryV4Contract.at(this.reader.registry, this.wallet);
  }

  contract() {
    if (this.reader.classId === registryProtocols.v7.classId)
      return NameRegistryV7Contract.at(this.reader.registry, this.wallet);
    if (this.reader.classId === registryProtocols.v6.classId)
      return NameRegistryV6Contract.at(this.reader.registry, this.wallet);
    return this.reader.classId === registryProtocols.current.classId
      ? NameRegistryV5Contract.at(this.reader.registry, this.wallet)
      : this.reader.modular
      ? NameRegistryV3Contract.at(this.reader.registry, this.wallet)
      : NameRegistryContract.at(this.reader.registry, this.wallet);
  }

  async registrationContract(expected?: string) {
    return (await this.registrationTarget(expected)).contract;
  }

  async registrationTarget(expected?: string): Promise<
    | { kind: 'registry'; contract: NameRegistryContract }
    | { kind: 'registrar'; contract: NameRegistrarContract }
    | { kind: 'registrarTiered'; contract: NameRegistrarTieredContract }
    | { kind: 'registrarLaunch'; contract: NameRegistrarLaunchContract }
  > {
    if (!this.reader.modular)
      return { kind: 'registry', contract: NameRegistryContract.at(this.reader.registry, this.wallet) };
    const config = await this.reader.getConfig();
    const address = config.registrar!;
    if (expected && address.toString() !== expected)
      throw new AnsError('fee_changed', 'registrar changed; prepare a new registration plan');
    if (config.launch) {
      await this.registerArtifact(address, NameRegistrarLaunchContract.artifact);
      return { kind: 'registrarLaunch', contract: NameRegistrarLaunchContract.at(address, this.wallet) };
    }
    if (config.lengthPrices) {
      await this.registerArtifact(address, NameRegistrarTieredContract.artifact);
      return { kind: 'registrarTiered', contract: NameRegistrarTieredContract.at(address, this.wallet) };
    }
    await this.registerArtifact(address, NameRegistrarContract.artifact);
    return { kind: 'registrar', contract: NameRegistrarContract.at(address, this.wallet) };
  }

  async addressContract(node: bigint, generation: number, snapshot?: Snapshot) {
    if (!this.reader.modular) return NameRegistryContract.at(this.reader.registry, this.wallet);
    const address = await this.reader.getResolver(node, generation, snapshot);
    await this.registerArtifact(address, NameResolverContract.artifact);
    return NameResolverContract.at(address, this.wallet);
  }

  private async registerArtifact(address: AztecAddress, artifact: ContractArtifact) {
    const instance = await this.reader.node.getContract(address);
    if (!instance) throw new AnsError('wrong_deployment', `no contract at ${address}`);
    await this.wallet.registerContract(instance, artifact);
  }

  /** Call inside the wallet queue. Rechecks the exact asset on every payment, including after a module change. */
  async registerFeeToken(address: AztecAddress) {
    if (address.isZero()) return;
    await this.assertWalletNetwork();
    const instance = await this.reader.node.getContract(address);
    if (instance?.currentContractClassId.toString() !== FEE_TOKEN_CLASS_ID)
      throw new AnsError('unsupported', 'fee asset is not the supported standard Token');
    const { TokenContractArtifact } = await import('@aztec-labs/noir-contracts.js/Token');
    await this.wallet.registerContract(instance, TokenContractArtifact);
  }

  /** Registers the registry (and optionally the fee token) with the wallet so it can execute their private code. */
  async ensureRegistered(
    opts: {
      feeToken?: { address: AztecAddress; artifact: ContractArtifact };
    } = {},
  ) {
    await this.assertWalletNetwork();
    const classId = this.reader.modular
      ? await this.reader.assertCurrentClass()
      : registryProtocols.legacy.classId;
    const artifact = registryArtifacts.get(classId);
    if (!artifact)
      throw new AnsError('wrong_deployment', 'registry class has no supported wallet artifact');
    await this.registerArtifact(this.reader.registry, artifact);
    if (this.reader.modular) {
      const snap = await this.reader.snapshot();
      const modules = await this.reader.getModules(snap);
      const registrar = await this.reader.assertModule(modules.registrar, 'registrar', snap);
      await this.reader.assertModule(modules.resolver, 'resolver', snap);
      await this.registerArtifact(
        modules.registrar,
        registrar === 'registrarLaunch' ? NameRegistrarLaunchContract.artifact : registrar === 'registrarTiered' ? NameRegistrarTieredContract.artifact : NameRegistrarContract.artifact,
      );
      await this.registerArtifact(modules.resolver, NameResolverContract.artifact);
    }
    if (opts.feeToken) await this.registerArtifact(opts.feeToken.address, opts.feeToken.artifact);
  }
}
