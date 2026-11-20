import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { ContractArtifact } from '@aztec-labs/aztec.js/abi';
import type { InteractionFeeOptions } from '@aztec-labs/aztec.js/contracts';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';

import { isV8Class, assertUpgradeInclusionMargin } from '../client/core-upgrade.js';
import { BlockNumber } from '@aztec-labs/aztec.js/fields';
import { registryProtocols } from '../core/registry-protocol.js';
import type { Snapshot } from '../core/types.js';
import type { RegistryReader } from '../client/reader.js';
import { FogError } from '../core/errors.js';
import { ExecutionQueue } from './queue.js';
import { FEE_TOKEN_CLASS_ID } from '../client/fee-token.js';
import type { GasEstimate } from '../transactions/gas.js';
import { assertWalletNetwork } from './network.js';
import {
  type ExtendedRegistryContract,
  type LegacyRegistryContract,
  type ModuleContract,
  type RegistryContract,
  extendedRegistryContract,
  legacyRegistryContract,
  moduleArtifact,
  moduleContract,
  registryContract,
  registryWalletArtifact,
} from './bindings.js';

/** An existing wallet plus the account acting in it. The SDK never receives keys. */
export type FogSigner = {
  wallet: Wallet;
  account: AztecAddress;
  /** Network fee payment, e.g. a sponsored FPC. Omit to let the wallet pay from the account's fee juice. */
  fee?: InteractionFeeOptions;
  /** Host validation inside the shared queue, after identity checks and before submission. Cannot broadcast. */
  beforeSend?: (account: AztecAddress) => Promise<void>;
  /**
   * Simulate each call first and declare its measured gas plus a 10% margin. Without this the wallet declares
   * the network's whole per-transaction gas limit, so the fee payer must hold that much larger maximum fee.
   */
  estimateGas?: boolean;
  /**
   * Host fee validation after gas estimation and before submission. `gas` is the limits the transaction will
   * declare; it is absent when estimation is off or the wallet returned no gas usage. Cannot broadcast.
   */
  checkFee?: (account: AztecAddress, gas?: GasEstimate) => Promise<void>;
};

const queues = new WeakMap<Wallet, ExecutionQueue>();

/** Reader + signer. Write operations and wallet-local utilities go through here. */
export class FogContext {
  readonly queue: ExecutionQueue;

  constructor(
    readonly reader: RegistryReader,
    readonly signer: FogSigner,
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

  /** Call inside the queue after host validation/preflight, before marking a possible broadcast. */
  async assertSendReady() {
    await this.assertWalletNetwork();
    if (isV8Class(this.reader.classId)) {
      const state = await this.reader.getCoreUpgradeState();
      assertUpgradeInclusionMargin(state);
      if (state.currentClass !== this.reader.classId)
        throw new FogError('wrong_deployment', 'core class changed after artifact registration; retry with refreshed artifacts');
    }
  }

  /** Same wallet and deployment, different account (e.g. the game account next to the name holder). */
  as(account: AztecAddress, fee = this.signer.fee): FogContext {
    return new FogContext(this.reader, { ...this.signer, account, fee });
  }

  /** Typed binding for this registry's exact class. Loads only that class's artifact. */
  extendedContract(): Promise<ExtendedRegistryContract> {
    return extendedRegistryContract(this.reader.classId, this.reader.registry, this.wallet);
  }

  contract(): Promise<RegistryContract> {
    return registryContract(this.reader.classId, this.reader.registry, this.wallet);
  }

  async registrationContract(expected?: string) {
    return (await this.registrationTarget(expected)).contract;
  }

  async registrationTarget(expected?: string): Promise<
    | { kind: 'registry'; contract: LegacyRegistryContract }
    | { kind: 'registrar'; contract: ModuleContract<'registrar'> }
    | { kind: 'registrarTiered'; contract: ModuleContract<'registrarTiered'> }
    | { kind: 'registrarLaunch'; contract: ModuleContract<'registrarLaunch'> }
  > {
    if (!this.reader.modular)
      return { kind: 'registry', contract: await legacyRegistryContract(this.reader.registry, this.wallet) };
    const config = await this.reader.getConfig();
    const address = config.registrar!;
    if (expected && address.toString() !== expected)
      throw new FogError('fee_changed', 'registrar changed; prepare a new registration plan');
    const kind = config.launch ? 'registrarLaunch' : config.lengthPrices ? 'registrarTiered' : 'registrar';
    await this.registerArtifact(address, await moduleArtifact(kind));
    // Narrowing a generic kind is not expressible; each branch above pairs the kind with its binding.
    return { kind, contract: await moduleContract(kind, address, this.wallet) } as
      | { kind: 'registrar'; contract: ModuleContract<'registrar'> }
      | { kind: 'registrarTiered'; contract: ModuleContract<'registrarTiered'> }
      | { kind: 'registrarLaunch'; contract: ModuleContract<'registrarLaunch'> };
  }

  async addressContract(node: bigint, generation: number, snapshot?: Snapshot) {
    if (!this.reader.modular) return legacyRegistryContract(this.reader.registry, this.wallet);
    const address = await this.reader.getResolver(node, generation, snapshot);
    await this.registerArtifact(address, await moduleArtifact('resolver'));
    return moduleContract('resolver', address, this.wallet);
  }

  private async registerArtifact(address: AztecAddress, artifact: ContractArtifact) {
    const instance = await this.reader.node.getContract(address);
    if (!instance) throw new FogError('wrong_deployment', `no contract at ${address}`);
    await this.wallet.registerContract(instance, artifact);
  }

  /** Call inside the wallet queue. Rechecks the exact asset on every payment, including after a module change. */
  async registerFeeToken(address: AztecAddress) {
    if (address.isZero()) return;
    await this.assertWalletNetwork();
    const instance = await this.reader.node.getContract(address);
    if (instance?.currentContractClassId.toString() !== FEE_TOKEN_CLASS_ID)
      throw new FogError('unsupported', 'fee asset is not the supported standard Token');
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
    const artifact = await registryWalletArtifact(classId);
    if (isV8Class(classId)) {
      const state = await this.reader.getCoreUpgradeState();
      assertUpgradeInclusionMargin(state);
      if (state.currentClass !== classId) throw new FogError('wrong_deployment', 'core class changed during artifact selection; retry before sending');
      const instance = await this.reader.node.getContract(this.reader.registry, BlockNumber(state.snapshot.blockNumber));
      if (!instance || instance.currentContractClassId.toString() !== classId) throw new FogError('wrong_deployment', 'core artifact and snapshot differ');
      await this.wallet.registerContract(instance, artifact);
      if (!await this.reader.isCanonical(state.snapshot)) throw new FogError('wrong_deployment', 'artifact snapshot reorged');
    } else await this.registerArtifact(this.reader.registry, artifact);
    if (this.reader.modular) {
      const snap = await this.reader.snapshot();
      const modules = await this.reader.getModules(snap);
      const registrar = await this.reader.assertModule(modules.registrar, 'registrar', snap);
      await this.reader.assertModule(modules.resolver, 'resolver', snap);
      await this.registerArtifact(modules.registrar, await moduleArtifact(registrar));
      await this.registerArtifact(modules.resolver, await moduleArtifact('resolver'));
    }
    if (opts.feeToken) await this.registerArtifact(opts.feeToken.address, opts.feeToken.artifact);
  }
}
