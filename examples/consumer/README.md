# ANS SDK integration

English · [中文](README.zh-CN.md)

This starter includes SDK 0.7.0, example code and public testnet configuration. Resolve names without a wallet, then connect a wallet for registration and recovery.

## Environment and startup

- Node: 24.12 or newer.
- Aztec packages: 6.0.0. Keep these versions in the application’s root `package.json`.
- Dependencies: retain the root `overrides`; overrides from the SDK package do not apply to the application.
- Distribution: the archive includes `ans-sdk.tgz`. The SDK is not published on public npm.

Run these commands from the extracted `ans-consumer` directory:

```sh
npm install
npm run check
npm run doctor
npm run read
```

| Command                                   | Result                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `npm run check`                           | Check TypeScript types in the example.                                 |
| `npm run doctor`                          | Read network identity, payment token, sponsor and contract modules.    |
| `npm run read`                            | Resolve the example name and verify its primary name without a wallet. |
| `npm run dev`                             | Start the browser example; open the printed localhost URL.             |
| `npm run build`                           | Build the browser example for hosting.                                 |
| `npm audit --omit=dev --audit-level=high` | Audit the installed application dependencies.                          |

## Example files

| File                                       | Purpose                                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| `deployment.json`                          | RPC, registry, chain, rollup and sponsor configuration. |
| `pricing.json`                             | Pricing policy at the time of release.                  |
| `read.ts` / `doctor.ts`                    | Public resolution example and deployment diagnostics.   |
| `wallet-connection.ts` / `registration.ts` | Wallet connection and registration API wrapper.         |
| `plan-store.ts`                            | Encrypt and save plans in browser `localStorage`.       |
| `browser/main.ts`                          | Connect the form, wallet approvals and saved plans.     |

The initial browser page imports `@ans/sdk/read`. Wallet discovery and registration load on user actions. The shared `bundle-budget.ts` build check limits initial JavaScript to 400 kB gzip and rejects eagerly loaded ANS execution artifacts; the build writes its measurements to `bundle-budget.json`.

Configuration files are release snapshots. Read the active Registrar and fee quote from the chain before payment. See [Pricing and payment assets](https://ans-testnet.huantian233.workers.dev/#/docs/pricing) for the current payment token and active collection configuration.

## Name resolution

Import public read APIs from `@ans/sdk/read`; no wallet connection or proving runtime is required. Keep wallet execution imports behind user actions. `RegistryReader.connect` connects to the node and validates the registry contract class.

`resolveAddress` returns a status, an address when resolved, and the block snapshot used for the read. Pass that snapshot to `resolvePrimary` to verify that the primary name resolves back to this address in the current registration generation. The runnable example is in `read.ts`.

## Wallet connection

1. Run `npm run dev` and discover a compatible wallet in the current browser.
2. Compare the connection symbols on the page and in the wallet, then confirm the secure channel.
3. Select an authorized account. `connectAns` checks the chain, rollup, registry, account authorization and sponsor contract class, then registers the required contract artifacts with the wallet.

`connectAns` returns an `AnsContext` containing the reader, wallet and account. It checks the wallet’s `chainId` and rollup version against the reader before registering contracts. Private balance reads, fee authorization and transaction submission recheck the wallet network inside its queue; a mismatch returns `wrong_deployment`. Reconnect after switching networks. Wallet keys remain in the wallet.

For repeated primary-name display, import `Resolver` from `@ans/sdk/read`. Its memory cache deduplicates concurrent queries and checks cached block hashes for reorgs. The default TTL is 30 seconds, capped by the name’s expiry; invalidate it when switching accounts or deployments. Payment checks still use fresh chain reads. Owned-name pagination cursors are bound to the account, registry, chain and rollup version; restart discovery with no cursor when upgrading from a pre-0.4.3 cursor.

## Registration data

| Object                  | Contents and use                                                         | Storage                                             |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| `FeeQuote`              | Duration, amount, token and fee policy read from the chain.              | Application memory; accepted values enter the plan. |
| `RegistrationPlan`      | Account, name, registration secret, accepted fee and transaction hashes. | The application encrypts it before saving.          |
| `RegistrationPlanStore` | Application-provided `load` and `save` methods; restore a plan by key.   | This example uses encrypted browser `localStorage`. |
| Registration flow       | `createRegistrationFlow` coordinates plan storage and transactions.      | Application memory; recreate after a reload.        |

## Payment checks

Read a fresh quote with `flow.quote(duration, name)`, with duration in seconds; `31536000n` is one year. The price depends on the name length (3 characters, 4 characters, 5 or more), so pass the name the user will register and quote again whenever it changes; a tiered Registrar rejects a quote without a name with `invalid_argument`. Call `flow.readiness(quote)` to check the selected account’s private balance. Display the name, duration, amount, token address and these fields before asking the user to accept payment:

| Field       | Meaning                                                               |
| ----------- | --------------------------------------------------------------------- |
| `ready`     | Whether the private balance covers this quote.                        |
| `balance`   | Private balance in the quoted token’s smallest units.                 |
| `shortfall` | Additional amount needed, in the same units.                          |
| `token`     | Payment token address, symbol and decimals; omitted for a free quote. |

Current test payment tokens have no self-serve faucet. Obtain private balance in the exact quoted token from the testnet operator. Fee Juice pays network fees; it cannot pay the registration treasury. `doctor` checks public configuration, while `readiness` checks the selected account’s balance.

For direct calls, use `getFeeReadiness(ctx, quote)` or `getPrivateFeeBalance(ctx, token)`. The SDK registers the exact payment-token artifact before private reads and paid authorization, including after a Registrar change. Read failures return errors rather than a zero balance.

## Registration process

| Step             | API                                     | Result                                                                           |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Quote acceptance | Application UI                          | The user accepts the displayed name, duration, token and amount.                 |
| Plan preparation | `flow.prepare({ name, acceptedQuote })` | Recheck the fee policy and save the plan before returning.                       |
| Commit           | `flow.commit(plan, { onUpdate })`       | Request wallet approval for the first transaction, then save and track its hash. |
| Waiting period   | `flow.check(plan)`                      | Read chain time; return `ready_to_register` when the registration window opens.  |
| Registration     | `flow.finish(plan, { onUpdate })`       | Request approval for payment and registration; wait for a checkpointed receipt.  |

In the browser example, enter a recovery passphrase of at least eight characters and unlock plan storage before preparing a plan. Each new transaction requires a separate wallet approval.

`registrationActions` in `registration.ts` calls `connectAns` and creates the flow. The function below accepts a connected reader, confirmed wallet, authorized account, recovery passphrase and the name to register. It returns the flow, store, quote and readiness without submitting a transaction:

```ts
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Wallet } from '@aztec/aztec.js/wallet';
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
}
```

When `readiness.ready` is true, display the quote and obtain user acceptance. Then call `commitAcceptedPlan` with that quote:

```ts
import type { FeeQuote, RegistrationPlan, TxUpdate } from '@ans/sdk';
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
}
```

`commitAcceptedPlan` returns the saved plan after commit confirmation. `finishReadyPlan` returns the unchanged plan while waiting; call `check` again to display the remaining time. Once ready, it submits registration; an existing `registerTx` is tracked. `onUpdate` receives `TxUpdate` for progress. These functions are application examples. Complete registration after its receipt reaches `checkpointed`.

## Plan storage and recovery

The example encrypts each plan with SDK `seal`/`unseal` before writing `localStorage`. Plans contain registration secrets; keep them out of URLs and logs. Keep the recovery passphrase and encrypted browser data. Clearing browser storage removes the saved plans; recovery on another device requires a copy of that encrypted data and the passphrase.

After an interruption, reconnect the same account, unlock the store with the original passphrase, load the saved plan and recreate the flow. Then call `check` or continue the corresponding step.

- `commit` and `finish` load the latest saved plan. An existing hash is tracked before any new submission; an older in-memory plan also reuses the saved hash.
- A wrong passphrase or storage failure stops the operation. Existing recovery data is retained.
- If hash persistence fails after submission, `unknown_tx_state` carries the hash. Track it and repair storage before continuing.
- If the wallet returns no hash, the plan records `broadcastUnknown`. Inspect wallet activity before explicitly clearing and saving the flag, then recreate the flow.
- Call `flow.recover(plan, kind, options)` with `kind` set to `"commitTx"` or `"registerTx"` to check a known receipt without broadcasting. It clears and saves a hash only after a verified dropped or reverted outcome, then throws the corresponding error. A timeout preserves the hash; retrying with an old plan copy uses the latest saved progress.

Keep one active flow per account. Multiple tabs or independent application instances need a shared storage lease to prevent concurrent submission. The example serializes actions within one tab; the application must provide coordination across instances and a test-token funding service.

## Record updates

V4 provides `setManager`, `offerTransfer`, `acceptTransfer`, `issueSubname`, `revokeSubname`, `setTextRecord` and `setChainAddress`.

Before each write, the SDK reads the current registration generation and revision. Generation identifies the current registration; revision identifies its latest changes. If either changed before submission, re-read the record before retrying. See [Ownership and editor permissions](https://ans-testnet.huantian233.workers.dev/#/docs/permissions) for the account required by each action.

## Error handling

| Code                               | Action                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `network`                          | Retry the read; retain form data and saved plans.                                      |
| `fee_changed`                      | Read and display a fresh quote; prepare a new plan after user acceptance.              |
| `unknown_tx_state`                 | Check the stored hash or `broadcastUnknown` as described in Plan storage and recovery. |
| `wallet_rejected`                  | Retain the plan and let the user retry wallet approval.                                |
| `unsupported` / `wrong_deployment` | Verify the network, contract class and SDK version before signing.                     |
