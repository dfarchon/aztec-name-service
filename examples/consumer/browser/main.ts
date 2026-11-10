import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import type { WalletProvider } from '@aztec-labs/wallet-sdk/manager';
import { RegistryReader, toAnsError } from '@ans/sdk/read';
import type { FeeQuote, RegistrationPlan, TxUpdate } from '@ans/sdk';
import type { discoverWallets } from '../wallet-connection.js';
import type { registrationActions } from '../registration.js';
import type { encryptedPlanStore } from '../plan-store.js';
import deployment from '../deployment.json' with { type: 'json' };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const output = (value: unknown) => {
  element('status').textContent =
    typeof value === 'string'
      ? value
      : JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
};
let reader: RegistryReader;
let wallet: Wallet | undefined;
let provider: WalletProvider | undefined;
let discovery: ReturnType<typeof discoverWallets> | undefined;
let flow: Awaited<ReturnType<typeof registrationActions>> | undefined;
let store: ReturnType<typeof encryptedPlanStore> | undefined;
let quote: FeeQuote | undefined;
let plans: RegistrationPlan[] = [];
let busy = false;
let finishable = false;
let verify: ((accepted: boolean) => void) | undefined;
let canPay = false;
let generation = 0;
const selected = () =>
  plans.find((plan) => plan.commitment.toString() === element<HTMLSelectElement>('plan').value);
const controls = () => {
  element<HTMLSelectElement>('account').disabled = busy || !wallet;
  element<HTMLButtonElement>('unlock').disabled = busy || !wallet;
  element<HTMLButtonElement>('discover').disabled = busy || !!wallet;
  for (const id of ['name', 'years', 'passphrase']) element<HTMLInputElement>(id).disabled = busy;
  element<HTMLButtonElement>('quote').disabled = busy || !flow;
  element<HTMLInputElement>('accepted').disabled = busy || !quote;
  element<HTMLButtonElement>('prepare').disabled =
    busy || !flow || !quote || !canPay || !element<HTMLInputElement>('accepted').checked;
  for (const id of ['commit', 'check'])
    element<HTMLButtonElement>(id).disabled = busy || !flow || !selected();
  element<HTMLSelectElement>('plan').disabled = busy || !plans.length;
  element<HTMLButtonElement>('finish').disabled = busy || !flow || !selected() || !finishable;
};
function invalidate() {
  generation++;
  flow = undefined;
  store = undefined;
  plans = [];
  quote = undefined;
  canPay = false;
  finishable = false;
  element('plan').replaceChildren();
  element<HTMLInputElement>('accepted').checked = false;
  element('payment').textContent = 'Unlock plans for this account to read a fresh quote.';
  controls();
}
async function action(run: () => Promise<void>) {
  if (busy) return;
  busy = true;
  controls();
  try {
    await run();
  } catch (error) {
    const mapped = toAnsError(error);
    output({
      code: mapped.code,
      message: mapped.message,
      txHash: mapped.txHash,
      recovery: mapped.txHash
        ? 'Track this hash before retrying. Do not submit another payment.'
        : undefined,
    });
  } finally {
    busy = false;
    controls();
  }
}
async function reloadPlans() {
  plans = await store!.list();
  const before = element<HTMLSelectElement>('plan').value;
  element('plan').replaceChildren(
    ...plans.map((plan) => {
      const option = document.createElement('option');
      option.value = plan.commitment.toString();
      option.textContent = plan.label;
      return option;
    }),
  );
  if (plans.some((plan) => plan.commitment.toString() === before))
    element<HTMLSelectElement>('plan').value = before;
}
const onUpdate = (update: TxUpdate) => output({ state: update.state, txHash: update.txHash });
async function sendSelected(kind: 'commit' | 'finish') {
  let failure: unknown;
  try {
    await flow![kind](selected()!, { onUpdate });
    if (kind === 'finish') finishable = false;
  } catch (error) {
    failure = error;
  }
  try {
    await reloadPlans();
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure; // A storage refresh must not hide an already-submitted transaction hash.
}
element('approve').onclick = () => verify?.(true);
element('cancel').onclick = () => verify?.(false);
element('discover').onclick = () =>
  void action(async () => {
    const { discoverWallets, connectWallet } = await import('../wallet-connection.js');
    discovery?.cancel();
    element('providers').replaceChildren();
    discovery = discoverWallets('ans-sdk-consumer', (candidate) => {
      const button = document.createElement('button');
      button.textContent = candidate.name;
      button.onclick = () =>
        void action(async () => {
          provider = candidate;
          const connected = await connectWallet(
            reader,
            candidate,
            'ans-sdk-consumer',
            (symbols) =>
              new Promise<boolean>((resolve) => {
                element('symbols').textContent = symbols;
                element('verification').hidden = false;
                verify = resolve;
              }),
          );
          element('verification').hidden = true;
          verify = undefined;
          if (!connected) {
            await candidate.disconnect();
            provider = undefined;
            return;
          }
          wallet = connected.wallet;
          discovery?.cancel();
          element('account').replaceChildren(
            ...connected.accounts.map((account) => {
              const option = document.createElement('option');
              option.value = account.item.toString();
              option.textContent = `${account.alias}: ${account.item}`;
              return option;
            }),
          );
          candidate.onDisconnect(() => {
            wallet = undefined;
            provider = undefined;
            invalidate();
            output('Wallet disconnected. Reconnect to resume.');
          });
          output('Wallet connected. Select an account and enter your recovery passphrase.');
        });
      element('providers').append(button);
    });
    await discovery.done;
    output(
      element('providers').children.length
        ? 'Choose a wallet.'
        : 'No compatible wallet found. Unlock a wallet extension on this testnet and retry.',
    );
  });
element('account').onchange = invalidate;
element('passphrase').oninput = invalidate;
element('unlock').onclick = () =>
  void action(async () => {
    invalidate();
    const epoch = generation;
    const [{ encryptedPlanStore }, { registrationActions }] = await Promise.all([
      import('../plan-store.js'),
      import('../registration.js'),
    ]);
    const account = AztecAddress.fromStringUnsafe(element<HTMLSelectElement>('account').value);
    const candidateStore = encryptedPlanStore(
      localStorage,
      element<HTMLInputElement>('passphrase').value,
      `${deployment.chainId}:${deployment.registry}:${account}`,
    );
    await candidateStore.list(); // Wrong passphrases cannot overwrite saved plans.
    const candidateFlow = await registrationActions(reader, wallet!, account, candidateStore);
    if (epoch !== generation) return;
    store = candidateStore;
    flow = candidateFlow;
    await reloadPlans();
    output('Plans unlocked. Read a fresh quote or resume a saved plan.');
  });
element('years').onchange = () => {
  quote = undefined;
  canPay = false;
  element<HTMLInputElement>('accepted').checked = false;
  controls();
};
element('accepted').onchange = controls;
// A different name may fall in another price tier; require a fresh quote.
element('name').oninput = () => {
  quote = undefined;
  canPay = false;
  element<HTMLInputElement>('accepted').checked = false;
  element('payment').textContent = 'Read a fresh quote for this name.';
  controls();
};
element('quote').onclick = () =>
  void action(async () => {
    const epoch = generation,
      activeFlow = flow!;
    quote = undefined;
    canPay = false;
    element<HTMLInputElement>('accepted').checked = false;
    element('payment').textContent = 'Reading a fresh quote and private balance…';
    // The price tier depends on the name length, so the quote is bound to the name being registered.
    const fresh = await activeFlow.quote(
      BigInt(element<HTMLSelectElement>('years').value) * 31536000n,
      element<HTMLInputElement>('name').value,
    );
    const readiness = await activeFlow.readiness(fresh);
    if (epoch !== generation) return;
    quote = fresh;
    canPay = readiness.ready;
    element('payment').textContent = JSON.stringify(
      {
        feeBaseUnits: fresh.fee.toString(),
        token: fresh.feeToken.toString(),
        decimals: readiness.token?.decimals,
        symbol: readiness.token?.symbol,
        privateBalance: readiness.balance.toString(),
        shortfall: readiness.shortfall.toString(),
        ready: readiness.ready,
        funding: readiness.ready
          ? undefined
          : 'Ask the testnet operator for private balance in this exact test token. No self-serve registration-token faucet is available; Fee Juice cannot pay this fee.',
      },
      null,
      2,
    );
    output('Review the quote and explicitly accept it before saving a plan.');
  });
element('prepare').onclick = () =>
  void action(async () => {
    const plan = await flow!.prepare({
      name: element<HTMLInputElement>('name').value,
      acceptedQuote: quote!,
    });
    await reloadPlans();
    element<HTMLSelectElement>('plan').value = plan.commitment.toString();
    finishable = false;
    output('Encrypted plan saved. Commit when ready.');
  });
element('plan').onchange = () => {
  finishable = false;
  controls();
};
element('commit').onclick = () =>
  void action(async () => {
    await sendSelected('commit');
  });
element('check').onclick = () =>
  void action(async () => {
    const state = await flow!.check(selected()!);
    finishable = state.state === 'ready_to_register' || !!selected()?.registerTx;
    output(state);
  });
element('finish').onclick = () =>
  void action(async () => {
    await sendSelected('finish');
  });
window.addEventListener('pagehide', () => {
  verify?.(false);
  discovery?.cancel();
  void provider?.disconnect();
});
void action(async () => {
  reader = await RegistryReader.connect(
    createAztecNodeClient(deployment.nodeUrl, { maxBatchSize: 3 }),
    AztecAddress.fromStringUnsafe(deployment.registry),
  );
  output('Deployment connected. Find wallets to begin.');
});
