import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import {
  connectAns,
  createRegistrationFlow,
  type RegistrationPlanStore,
  type RegistryReader,
} from '@ans/sdk';
import deployment from './deployment.json' with { type: 'json' };

export type RegistrationFlow = ReturnType<typeof createRegistrationFlow>;

/**
 * Create a flow after the user confirms the wallet's secure channel.
 * account must be authorized by wallet; store must encrypt and persist plans.
 * Throws if the network, registry or sponsor does not match deployment.json.
 * Connecting does not submit a transaction. Quotes use seconds and token base units.
 */
export async function registrationActions(
  reader: RegistryReader,
  wallet: Wallet,
  account: AztecAddress,
  store: RegistrationPlanStore,
): Promise<RegistrationFlow> {
  const ctx = await connectAns(reader, {
    wallet,
    account,
    deployment,
    sponsoredFpc: AztecAddress.fromStringUnsafe(deployment.sponsoredFpc),
  });
  return createRegistrationFlow(ctx, store);
}
