# Code structure

This document describes the module boundaries, transaction recovery rules, and extension points across `@fog/sdk` and `@fog/web`.

## Module responsibilities

| Module | Inputs and outputs |
| --- | --- |
| `sdk/src/core/registry-protocol.ts` | Selects protocol capabilities and storage layouts from the exact on-chain contract class ID using lightweight read metadata only. |
| `sdk/src/client/reader.ts` | Reads public chain state at a pinned block snapshot and validates contract classes and module bindings. |
| `sdk/src/wallet/context.ts` | Binds the wallet, account, and `RegistryReader`, selecting execution artifacts on demand. |
| `sdk/src/transactions/holding.ts` | Inspects name holdings and enforces shared lease, owner, and editor authorization checks. |
| `sdk/src/transactions/tx.ts` | Serializes wallet work inside the shared queue, validates network identity, builds calls, runs optional preflight simulation, sends, and tracks receipts by hash. |
| `sdk/src/transactions/registration-flow.ts` | Persists registration plans, serializes commit/reveal and recovery, and preserves transaction hashes and `broadcastUnknown` markers. |
| `web/src/registration.ts` | Adapts encrypted account records into `RegistrationPlanStore`, reusing one active registration flow per account context. |
| `web/src/pages/Register.tsx` | Displays quotes, private balance readiness, and registration progress while driving the SDK registration flow. |

## Transactions and recovery

Write operations that select a Registrar or Resolver pass a deferred call builder to `runTx`. The SDK enters the shared wallet queue first, verifies wallet network identity, and refreshes contract artifacts before constructing the call. Callers passing prebuilt interactions remain supported.

Call construction or simulation failures happen before `send`, preserving safe retry without setting `broadcastUnknown`. Once a hash is returned, progress is saved immediately; if submission fails without returning a hash, `broadcastUnknown` is persisted so the host application reconciles wallet activity before retrying.

`flow.recover(plan, kind, options)` queries receipts without broadcasting. It clears and saves the stored hash only when a receipt proves the transaction was dropped or reverted, then throws the corresponding error; timeouts retain the hash. Latest in-memory and persisted progress always supersedes stale caller plan copies, including hashes cleared after verified failure.

## Extension rules

- **New contract versions**: Add protocol metadata and wallet execution bindings while keeping public reads free of executable contract artifacts. Storage layouts must continue passing frozen baseline checks.
- **New name operations**: Reuse shared holding inspection and role checks before constructing calls. Transfer recipients and primary-name targets keep their dedicated consent checks.
- **New host integrations**: Supply a `RegistrationPlanStore` implementation and reuse `createRegistrationFlow`; encryption and cross-tab coordination belong in the host application.
