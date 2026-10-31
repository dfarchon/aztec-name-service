// CI compiles these complete modules inside the independently installed starter.
export const profileExample = `import { type AnsContext, setTextRecord, setChainAddress } from '@ans/sdk';

export async function updateProfile(
  ctx: AnsContext,
  name: string,
  description: string,
  ethereumAddress: string,
): Promise<void> {
  if (!ctx.reader.extended) throw new Error('An extended registry is required');
  await setTextRecord(ctx, { name, key: 'description', value: description });
  await setChainAddress(ctx, { name, chain: 'eip155:1', address: ethereumAddress });
}`;

export const connectionExample = `import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { RegistryReader } from '@ans/sdk/read';
import { registrationActions } from './registration.js';
import { encryptedPlanStore } from './plan-store.js';
import deployment from './deployment.json' with { type: 'json' };

export async function connectRegistration(
  reader: RegistryReader,
  wallet: Wallet,
  account: AztecAddress,
  recoveryPassphrase: string,
  name: string,
) {
  const scope = deployment.chainId + ':' + deployment.registry + ':' + account;
  const store = encryptedPlanStore(localStorage, recoveryPassphrase, scope);
  const flow = await registrationActions(reader, wallet, account, store);
  const quote = await flow.quote(31536000n, name);
  const readiness = await flow.readiness(quote);
  return { flow, store, quote, readiness };
}`;

export const registrationExample = `import type { FeeQuote, RegistrationPlan, TxUpdate } from '@ans/sdk';
import type { RegistrationFlow } from './registration.js';

export async function commitAcceptedPlan(
  flow: RegistrationFlow,
  name: string,
  acceptedQuote: FeeQuote,
  onUpdate?: (update: TxUpdate) => void,
): Promise<RegistrationPlan> {
  const plan = await flow.prepare({ name, acceptedQuote });
  return flow.commit(plan, { onUpdate });
}

export async function finishReadyPlan(
  flow: RegistrationFlow,
  plan: RegistrationPlan,
  onUpdate?: (update: TxUpdate) => void,
): Promise<RegistrationPlan> {
  const state = await flow.check(plan);
  if (state.state === 'commit_wait' && !plan.registerTx) return plan;
  return flow.finish(plan, { onUpdate });
}`;

export const configurationExample = `import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { configureModules, type AnsContext } from '@ans/sdk';

export async function updateModules(
  administrator: AnsContext,
  registrar: AztecAddress,
  defaultResolver: AztecAddress,
) {
  const { tx } = await configureModules(
    administrator,
    { registrar, resolver: defaultResolver },
    { waitFor: 'confirmed' },
  );
  const modules = await administrator.reader.getModules();
  return { tx, modules };
}`;
