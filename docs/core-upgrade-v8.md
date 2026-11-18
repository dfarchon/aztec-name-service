# V8 core upgrades

V8 is a fresh independent registry retaining frozen V7 public business rules. V2–V7 sources, storage baselines, class IDs and existing deployments remain unchanged. Existing V6 has no core upgrade entry and cannot be retrofitted; old names are not migrated. This document describes an implementation awaiting independent review, not production or mainnet readiness. Future configuration lives in `deployments/future-v8.template.json` and the isolated rehearsal profile in `e2e/v8-rehearsal.json`; both prohibit public execution and site publication this round.

## Authority and trust

The product uses a **trusted single administrator**; multisig is optional. Placeholder administrators remain blocked, as do unresolved RPC, network, version, real-proof, address, budget and site requirements. The administrator can approve malicious code and attest false family/sequence labels. On-chain approval proves process constraints only. Reviewing the exact artifact and class ID, frozen-layout tests and SDK allowlists remain necessary.

`configure_modules` still takes effect immediately. Core delays do not protect Registrar fee policy or the default Resolver used by future registrations, reissues and accepted transfers. This remains a separate accepted administrative risk.

## Lifecycle and cancellation

| Action | Preconditions and effect |
| --- | --- |
| `approve_release` | Administrator, current nonce, registered exact class, fixed family and positive sequence. Explicit reapproval after revocation preserves original family/sequence labels. |
| `approve_edge_pair` | Records reviewed forward and reverse edges between two approved releases with strictly increasing sequence; either direction is revocable. |
| `propose_upgrade` | Pins runtime source, target, live directed edge and an application-ready time `now + 86400` chain seconds. |
| `execute_upgrade` | Administrator and fresh nonce, exact match against stored proposal after application wait, rechecked runtime class, live approvals and exact 86400-second protocol delay; submits only the stored target. |
| `cancel_upgrade` | Cancels the application proposal before execution. |
| `cancel_scheduled_upgrade` | Strictly before `activation_at` while runtime class is still the stored `from`, schedules the running source as a no-op; fails at and after `activation_at`. |
| `settle_upgrade` | Anyone may settle confirmed activation bookkeeping without changing the nonce. |
| Revocation | Clears affected proposals; scheduled policy cannot be revoked until safe cancellation. Reapproval requires a fresh proposal and full wait. |
| Administrator handoff | Nonce-bound nomination and acceptance; acceptance clears pending application proposals and increments the nonce while preserving any already-submitted protocol schedule. |

Times are chain Unix seconds rather than local wall-clock time. Forward upgrade and compatible rollback each require 24 application hours plus 24 protocol hours. A round trip takes at least 96 hours plus inclusion and confirmation. There is no emergency bypass, arbitrary-call entry, delay setter or freeze operation.

**Rollback preserves business writes.** It changes implementation code without undoing transactions, registrations, transfers, events or successor writes. The rehearsal successor changes only version output and release sequence, with an identical business and governance layout and no new state. Appending fields does not prove semantic rollback safety. The core has no private notes or private storage; separate Token notes remain independent and establish no arbitrary future-note compatibility.

## Reads and wallet execution

Decision reads pin block header, contract instance, application raw slots and protocol raw slots to a single block `N` and recheck `hash(N)`. Advancing latest chain head is allowed as long as `N` remains canonical. Public simulation is a **next-block prediction**, not snapshot evidence. Unknown roots, classes, targets or edges, or inconsistent bookkeeping, fail closed.

`RegistryReader.connect(node, address, { allowRehearsalSuccessor: true })` permits only the exact known rehearsal successor when explicitly enabled. `administerCoreUpgrade(ctx, action, options)` takes a uint64 bigint nonce, Field bigint class/family and positive uint32 sequence, returning the transaction hash, tracked receipt status and readback. Unknown or inconsistent state raises `wrong_deployment`, invalid inputs raise `invalid_argument`, and insufficient activation margin raises `unsupported`. Readback failure carries the known hash in `unknown_tx_state` and never authorizes resend.

Within the shared wallet queue, network identity checks precede current-class and artifact refresh. A minimum 900-second preactivation proving/inclusion margin is a conservative floor, not measured real-proof latency or a guarantee; public preflight must measure and raise it if needed. Refresh artifacts after activation before resuming writes. Network outages never enable writes, cross-network fallbacks, or clearing of unknown-broadcast markers or saved hashes.

## Rehearsal and future migration

Use a fresh V8, Launch Registrar and Resolver suite, new accounts and a private checkpoint outside the repository. Retain the full 325-label reserved hash `743b1b4c3ab4762cb2d12662765406fdf91971845a5ec6137b1f7444223657fa` and all launch cases (free mode, 1–6 character rejection, 7+ character registration, administrator mint, pause/resume, renewal horizon, 300-second quote margin, and post-transfer former-resolver write rejection), plus actual V8 upgrades, strict cancellation, state preservation and rollback. Local debug time changes wall-clock wait only; neither 86400-second constant is shortened.

Waiting steps save state and exit with the earliest Asia/Taipei resume time. Resume rechecks chain state, live approvals, nonce and saved hashes. Known hashes are tracked only; ambiguous broadcasts stop without resend. Bridge proven-block recovery is bounded and never duplicated via SSH. No public transaction, bridge, funding or site publication occurs this round.

Fee planning includes both class publications, new accounts and suite deployment, approvals, proposals, execution, cancellation and rollback. Estimates remain unmeasured; historical allowances are not bounds. Public real-proof, identity, balance and measured-estimate preflight follows independent safety review. Significant overrun of 90 FJ or 0.006 Sepolia ETH stops before funding. Mainnet remains blocked pending fresh real-proof evidence and all operational requirements.

A future cross-address migration requires a separate design: namespace conflicts and expiry/reservation policy, pinned legacy identity and verifiable ownership, holder opt-in, fresh primary consent and resolver choices, and explicit generation, transfer, subname and pending-commit treatment. Do not copy old permissions or private secrets. No retroactive V6 upgrade or automatic name migration is claimed.

The historical V7 `deployments/mainnet.template.json` remains unchanged. Its historical multisig note does not override the V8 single-administrator decision or remove the placeholder block. V8 uses its own independent future template. `verifyClass: false` raises `invalid_argument`; exact-class and profile checks cannot be disabled.

Local reproduction prepares fixtures with `node scripts/prepare-v8-local-fixtures.mjs <absolute-directory-outside-repository>` and compiles there through this repository's pinned `scripts/aztec.mjs compile`. `test:upgrade` requires explicit `FOG_V8_LOCAL_FIXTURE_DIR`. Fixtures are excluded from SDK and public profiles. Only the labelled delay fixture exposes a protocol setter, solely to test the real mismatch rejection; production V8 has no such entry and actual target acceptance uses both full delays.

## Review clarifications

Release revocation leaves stored edge approvals intact but dormant while either release is revoked. Reapproving that release reactivates every stored live edge involving it, in both directions, without another edge approval. `approve_edge_pair` explicitly approves **both** directions again, including a direction separately revoked earlier. Operators must review both directions before either action. Neither action restores a cleared proposal: a fresh proposal, the full 86400-second application wait and the full 86400-second protocol wait are still required. The local policy gate reads both stored edge statuses and tests fresh proposals and premature execution rejection.

Execute checks the **current operation's** `expected_nonce` through the administrator authority check and bumps it. It does not compare that value with `pending.nonce`; the proposal's saved nonce is observability data. Release/edge revocation clears affected proposals; cancellation and administrator acceptance clear the proposal; proposal replacement saves a new one. These explicit state transitions invalidate a proposal, rather than a saved-nonce equality check at execute.

An approved future class that changes the instance's protocol update delay would prevent V8 from executing both forward upgrades and rollback: V8 requires exactly 86400 seconds and has no delay setter. Exact target review must reject a delay setter, indirect delay mutation, arbitrary-call path or delay bypass. Approving a class remains a trusted administrator decision; no emergency escape is added to V8.

The public initializer makes its first valid caller administrator. Safe deployment therefore requires a **nonzero bound deployer equal to the intended owner**, included in the instance address preimage, with initialization in the deployment transaction. Never use `universalDeploy`, a zero deployer or a separately exposed uninitialized instance for this suite. The local path supplies an explicit bound owner through `v8BoundDeployment`. Before bootstrap, read back `instance.deployer` and the initialized administrator and check both with `assertV8DeploymentOwner`. Any future executor must preserve these checks, including on resume, before further sends.

All SDK transaction submission routes converge on `runTxOutcome` inside the shared wallet queue, including registration commit/reveal and core administration. Each operation refreshes the registry artifact after network checks. A final V8 identity/class/margin read after host validation and optional preflight rejects a changed class or a margin of 900 seconds or less before the recovery marker is set. The 900-second value is a conservative floor, **not measured proof latency** or an inclusion guarantee. Retry after activation uses fresh artifacts.

Ordinary `npm run test:contracts` applies the first-party `scripts/txe-loopback.cjs` preload through `scripts/aztec.mjs test` only. The pinned launcher has no TXE host argument and starts its own Node child on 8081. The helper constrains its TCP/UDP listeners to literal loopback, preserves Unix sockets/callbacks/backlogs and rejects external hosts or unsupported prebound handles. It changes no outbound RPC, deployment or `start` command.
