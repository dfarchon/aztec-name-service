# Protocol: administration, modules and deployments

Fog Names centers on the Registry contract while delegating fee policy and forward-address resolution to replaceable modules. Name ownership, leases and profile records live in the Registry, so swapping modules never migrates names.

## Module responsibilities

| Module | Responsibility | Configuration rule |
| --- | --- | --- |
| Registry | Ownership, leases, generations and revisions, permissions, primary-name consent | Administrator configures the active Registrar and default Resolver directly |
| Registrar | Quotes, commit-reveal, exact fee authorization and private payment collection | Registry, payment token, treasury, annual price and `priceVersion` are fixed at construction |
| Resolver | Default Aztec forward-address writes forwarded with the original caller | Bound Registry is fixed; holders may select a compatible Resolver |

The deployment account is the initial administrator. `bootstrap` performs one-time initialization; thereafter `configureModules(ctx, { registrar, resolver })` updates modules and takes effect immediately once confirmed. Modules must bind the same Registry, the SDK validates supported contract classes, and configuration writes check the module revision to prevent stale overwrites.

Administrator configuration never alters name ownership, expiry or records. A new default Resolver applies to subsequent registrations and subname issuance, while existing names keep their selected Resolver. Holder-controlled Resolver changes clear the default address and advance the binding version, requiring fresh primary consent from the target account.

## Fee updates

Registrar payment parameters are immutable. Changing prices or settlement tokens uses the following flow:

1. Verify network identity, payment token, decimals, treasury, annual pricing and token acquisition path.
2. Deploy a new Registrar bound to the live Registry and verify its immutable fee parameters.
3. Have the administrator call `configureModules(ctx, { registrar, resolver })`, retaining any unchanged module address.
4. Confirm the transaction, read back the active configuration, and verify exact user debits and treasury credits on registration and renewal.

No Registry redeployment or name migration is needed. The retired Registrar is no longer accepted by the Registry; obsolete quotes and unconsumed registration plans must be prepared again, while completed payments recover their existing receipts.

## V6 and network deployments

| Contract | Network | Status |
| --- | --- | --- |
| `name_registry_v6` | Aztec 6 testnet | Active core (`deployments/testnet-v6.json`); zero legacy address, no name migration |
| `name_registry_v5` and earlier | Aztec 5.2.1 testnet | Read-only archive (`deployments/testnet.json`, `deployments/legacy/`) |

V6 changes relative to V5:

- Administrator transfer uses a two-step handoff (`nominate_administrator` with zero address cancelling, followed by `accept_administrator`), exposed via `get_administrator` / `get_pending_administrator` with `pending_administrator` appended at the end of storage.
- Expired (`>= MAX_COMMIT_AGE`), unconsumed commitments may be resubmitted to refresh their timestamp; unexpired or consumed commitments remain immutable.
- Storage layout, commit-reveal, exact payment authorization, generation/revision checks, editor restrictions, ancestor lease bounds and bidirectional primary verification remain unchanged.

The SDK recognizes recompiled V2–V5 classes alongside V6–V8 by exact class ID. Registration plans bind the deployment and rollup version and cannot cross deployments. See [V6 deployment](deploy-v6.md).

## Historical V5 holder migration

V5 supported migrating root names from a constructor-pinned legacy Registry during active lease or the 30-day grace period:

| Aspect | Behavior |
| --- | --- |
| Eligibility | Root-name holder during active lease or 30-day grace period |
| Reservation | Renewable legacy names remained reserved on the destination against third-party registration |
| Preserved | Holder, expiry timestamp and default Aztec address |
| Reconfigured | Primary consent, editor, profile records, multi-chain addresses and subnames |
| Legacy instance | Retained original records and behavior |
| Duplicate guard | Refused once initialized on the destination Registry |

## Verification and Workers

`npm run test:contracts` checks contract permissions and state boundaries; `npm run test:extensions` exercises immediate module switches, plan invalidation, authority handoff, exact fee settlement and extended name flows on an isolated local chain (proving disabled).

`ops/wrangler*.jsonc` accepts comments and trailing commas without committing `account_id` or `RELEASE`. `npm run deploy:testnet` validates Worker network fields, including the L1 Rollup address, against the deployment manifest and injects `--var RELEASE:<commit>`. The D1 `database_id` in `ops/wrangler*.jsonc` belongs to the existing test environment; create your own D1 database when deploying to another account. Configure comma-separated web wallet URLs through `FOG_PUBLIC_WALLET_URLS`; the build permits only their origins in CSP `frame-src`.

## Launch Registrar

`NameRegistrarLaunch` is an optional V6/V7 module. The current testnet runs it in free mode with a 5-character public minimum; this does not announce a mainnet deployment. Public registration defaults to at least 7 characters; the live administrator can choose 3–31. Short names show “Not yet available”; reserved names show “Reserved”. Reservations use node keys, batches of 32 and zero padding. `deployments/reserved-labels.json` contains the categorized v3 content-policy list of 325 labels (all original v2 276 plus 49 additions; file schema `fog-reserved-labels/1`), all at least 7 characters. The loader rejects illegal labels and duplicates before hashing the sorted flat list; categories, corporate identity sources and change procedure are in `deployments/reserved-labels.md`. Support/official compounds are our anti-impersonation policy and do not claim an official company service, endorsement, ownership or partnership.

Each registration and renewal is exactly 365 days. `max_renew_ahead` is seconds, bounded at construction to 0–315360000 (10 years): 0 (the local/testnet script default) allows repeated renewal without a horizon; otherwise current expiry must be at most chain time plus the horizon. Mainnet sets `maxRenewAhead = 31536000`: renewal opens 1 year before expiry. Admin and treasury use placeholder address `0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68` (offline-generated, never deployed), with `adminPlaceholder: true`; replace with the actual trusted administrator and pass readiness before launch (single administrator is the product choice; multisig is optional). Pause blocks only public registration; holder renewal and administrator mint stay available, protecting holders during the grace period.

Free mode requires a zero token and all three prices zero: no token transfer, AuthWit or private token balance read. Fee Juice or sponsorship still pays network fees. Paid mode uses the same code with immutable token, treasury and 3/4/5+ prices; all public policy gates still apply. Authority is read from the Registry on every operation, so the nominee gains authority only after accepting the two-step handoff and the old administrator immediately loses it.

Administrator mint uses a separate commit-reveal domain, waits 60 seconds to 24 hours, writes the recipient directly, and grants one year without registration fees even in paid mode. Label rules, including no `--` or `0x`, still apply. Before switching instances, operator tooling combines the canonical list with every node discovered in the complete ReservedChanged history, copies policy and verifies storage parity and the immutable renewal cap. Price version must increase; any mismatch prevents the switch. Holdings, generations and records do not migrate. Old registration plans become invalid and need a fresh quote.

## V7 resolver and revision rules

Mainnet targets a fresh V7 (`protocol: 7`, retaining schema `fog-deployment-v6/1`). The current testnet stays on frozen V6; V2–V5 remain archives on the old rollup, with no migration to Aztec 6. Acceptance on V7 resets the resolver to the current default and emits ResolverChanged. Old-generation addresses, profiles, editors, primary consent and descendants cannot revive. A resolver can write only in the generation bound by that holder or default policy, and the supplied actor must be the current holder or editor. The SDK and web also verify its class and Registry binding.

V7 separates holder `NameRecord.revision` from editor `Holding.recordRevision`: editor writes cannot stale holder renewal, editor removal, resolver replacement or transfer acceptance. Resolver replacement clears the address and advances record revision, invalidating pending editor writes. V3–V6 retain a shared revision. `get_record_revision(node, generation)` / `getRecordRevision(node, generation, snapshot)` returns the generation's record revision as u32 / number.

An unverified resolver produces `resolveAddress.status = 'untrusted_resolver'` and `resolvePrimary.status = 'stale'` with reason `untrusted_resolver`. `inspectResolver` returns public address, verified, isDefault and optional zero / unknown_class / other_registry reason; transport errors still throw. V6 `acceptTransfer` refuses an unverified inherited resolver unless `acceptUnverifiedResolver: true` is explicit; the inherited resolver can also block recovery by pumping the shared revision. V6 testnet names must not be treated as holding value. V7 reports `resolverReset: true`. Reset checks the target resolver without requiring trust in the inherited one.

Before creating a plan or sending commit, the SDK requires 300 chain seconds of quote lifetime: 60 minimum commit age + 60 reveal margin + 180 proving, inclusion and checkpoint slack. `COMMIT_QUOTE_MARGIN = 300n`; `REVEAL_MARGIN = 60n`. Insufficient lifetime returns `quote_expired` before wallet submission. Allow adequate time for actual proving/inclusion; encrypted recovery and receipt-evidence rules still apply.

`setPrimary(ctx, { name, acceptUnverifiedResolver? }, opts?)` refuses an unverified resolver with `invalid_argument` unless explicitly opted in with `true`. The override preserves transport, active-lease and forward-address checks and cannot make `resolvePrimary` report trust. Only `resolveAddress` and `resolvePrimary` validate resolver trust; raw `RegistryReader.getAddress` / `fog-sdk/read` returns public chain records for callers to validate.

L-02 remains open before mainnet: administrator changes to the default resolver take effect immediately, and V7 registrations, reissues and accepted transfers use that current default. Administrator compromise therefore affects future recipients. The product retains a trusted single administrator and the immediate module-configuration risk; monitoring continues to watch `configure_modules`.

`AddressChangedV3.revision` is the shared name revision on V3–V6 and the generation's record revision on V7. Indexers must select the meaning by protocol version and keep the V7 holder revision separate.

## Independent V8

V8 is a new independent registry retaining frozen V7 public behavior and layout prefix, not a patch to an existing deployment. It adds fixed 24-hour application plus 24-hour protocol delays, strictly preactivation cancellation and compatible delayed rollback preserving writes. A trusted single administrator can still configure modules immediately. See [V8 core upgrades](core-upgrade-v8.md) for raw snapshot, trust and rehearsal boundaries.
