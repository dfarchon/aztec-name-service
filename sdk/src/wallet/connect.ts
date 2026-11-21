import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { ContractArtifact } from '@aztec-labs/aztec.js/abi';
import type { ContractInstanceWithAddress } from '@aztec-labs/stdlib/contract';
import type { RegistryReader } from '../client/reader.js';
import { FogError } from '../core/errors.js';
import { FogContext, type FogSigner } from './context.js';
import { assertWalletNetwork } from './network.js';

/** Connect an authorized account, checking deployment and sponsor before any signing. */
export async function connectFog(
  reader: RegistryReader,
  options: {
    wallet: Wallet;
    account: AztecAddress;
    deployment: { registry: string; chainId: string; rollupVersion: string };
    sponsoredFpc?: AztecAddress;
    /**
     * Declare each call's simulated gas plus a 10% margin instead of the network's whole per-transaction limit.
     * Recommended when the account pays its own Fee Juice: the required balance then matches real usage.
     */
    estimateGas?: boolean;
    /** Host fee validation after gas estimation and before submission; see `FogSigner.checkFee`. */
    checkFee?: FogSigner['checkFee'];
  },
) {
  const expected = options.deployment;
  if (
    reader.registry.toString() !== expected.registry ||
    String(reader.deployment.chainId) !== expected.chainId ||
    String(reader.deployment.rollupVersion) !== expected.rollupVersion
  )
    throw new FogError('wrong_deployment', 'unexpected registry or network identity');
  await assertWalletNetwork(options.wallet, reader.deployment);
  if (!(await options.wallet.getAccounts()).some((account) => account.item.equals(options.account)))
    throw new FogError('invalid_argument', 'account is not authorized by this wallet');
  let fee;
  let sponsor: { instance: ContractInstanceWithAddress; artifact: ContractArtifact } | undefined;
  if (options.sponsoredFpc) {
    const { SponsoredFPCContractArtifact } = await import('@aztec-labs/noir-contracts.js/SponsoredFPC');
    const { getContractClassFromArtifact } = await import('@aztec-labs/stdlib/contract');
    const { SponsoredFeePaymentMethod } = await import('@aztec-labs/aztec.js/fee');
    const [instance, artifactClass] = await Promise.all([
      reader.node.getContract(options.sponsoredFpc),
      getContractClassFromArtifact(SponsoredFPCContractArtifact),
    ]);
    if (!instance?.currentContractClassId.equals(artifactClass.id))
      throw new FogError('wrong_deployment', 'sponsor contract class does not match this SDK');
    fee = { paymentMethod: new SponsoredFeePaymentMethod(options.sponsoredFpc) };
    sponsor = { instance, artifact: SponsoredFPCContractArtifact };
  }
  const ctx = new FogContext(reader, {
    wallet: options.wallet,
    account: options.account,
    fee,
    estimateGas: options.estimateGas,
    checkFee: options.checkFee,
  });
  await ctx.queue.run(async () => {
    await ctx.assertWalletNetwork();
    if (sponsor) await ctx.wallet.registerContract(sponsor.instance, sponsor.artifact);
    await ctx.ensureRegistered();
  });
  return ctx;
}
