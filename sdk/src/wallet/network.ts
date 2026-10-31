import type { Wallet } from '@aztec-labs/aztec.js/wallet';

import { AnsError, toAnsError } from '../core/errors.js';
import type { Deployment } from '../core/types.js';

/** Check the wallet itself; discovery filters and the reader's RPC identity are insufficient. */
export async function assertWalletNetwork(
  wallet: Wallet,
  deployment: Pick<Deployment, 'chainId' | 'rollupVersion'>,
): Promise<void> {
  let chain;
  try {
    chain = await wallet.getChainInfo();
  } catch (cause) {
    const error = toAnsError(cause);
    throw error.code === 'reverted'
      ? new AnsError('network', 'cannot read wallet network identity', cause)
      : error;
  }
  if (
    chain.chainId.toBigInt() !== deployment.chainId ||
    chain.version.toBigInt() !== deployment.rollupVersion
  ) {
    throw new AnsError('wrong_deployment', 'wallet and reader use different Aztec networks');
  }
}
