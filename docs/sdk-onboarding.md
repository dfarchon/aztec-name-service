# SDK integration and registration

Names display as `<label>.fog` (Fully Obfuscated Glyph). The suffix is presentation only: contracts store and hash the bare label, so `alice.fog` is the root label `alice` and `team.alice.fog` is the subname `team` under `alice`. Strip one trailing `.fog` from user input with `normalizeName(input, { suffix: NAME_SUFFIX })` and display names with `formatName(label)`. Every other SDK call, route and stored value uses the canonical label; without the option, `team.fog` means a subname of the root name `fog`, not the suffix.

## Developer quickstart

Run inside the standalone consumer starter (`examples/consumer`):

```sh
npm install
npm run check
npm run doctor
npm run read
npm run dev
```

`doctor` checks network identity, contract classes, active modules, the exact payment token, decimals and sponsorship. `read` resolves names and verifies primary bindings without a wallet. The browser example implements wallet discovery, connection verification, account selection, balance preflight, encrypted plan storage, commit, maturity wait, reveal and recovery; `npm run build` emits a standalone static bundle.

| API | Inputs and result |
| --- | --- |
| `connectFog` | Authorized wallet, account and deployment configuration; verifies network identity and sponsor contract, returning `FogContext` |
| `readFeeTokenMetadata` | Exact token address; verifies standard Token class and returns `decimals` and `symbol` |
| `getPrivateFeeBalance` | `FogContext` and exact payment token; registers token artifact and reads private balance |
| `getFeeReadiness` | `FogContext` and accepted quote; returns balance, shortfall, metadata and `ready` without treating read failures as zero |
| `createRegistrationFlow` | `FogContext` and `RegistrationPlanStore`; serializes preparation, commit, reveal and receipt recovery |
| `getModules` / `getAdministrator` / `getLegacyRegistry` | Reads active modules, current administrator and optional legacy Registry |
| `configureModules` / `setAdministrator` | Current administrator context and target module or account addresses; returns hash-recoverable transaction result |
| `migrateName` | Legacy root holder context and root label; destination account reconfirms primary consent after migration |

## Capabilities, pricing and recovery

Aztec 6 wallets such as Nulo refuse account and contract calls other than `getChainInfo` until the app is granted capabilities. After checking the wallet network, call `requestFogCapabilities` (or `wallet.requestCapabilities`) for account reads, payment authorizations, and registration, simulation and sending on the Registry, the active Registrar, the default Resolver, the payment token and the sponsor contract when used. Name exact addresses: no wildcards, address book or private events. A name can keep its own Resolver, and an administrator can activate a new Registrar or payment token; the SDK calls `registerContract` before using such a contract, so request that address first. `connectFog` expects an already authorized wallet. Payment authorizations are sent as a call intent (the token's `transfer_in_private`, called by the Registry or Registrar), so the wallet can show the exact transfer; the SDK checks that it matches the exact authorization hash and returns `unsupported` otherwise, without asking for a signature. Wallets draw a fresh salt for every transaction; the SDK neither sets nor reuses one and pins no standard contract address.

Amounts use bigint base units. Token metadata determines display precision; 1 `mAZTEC` is `10^18` units. Registration fees and network fees are separate. Sponsorship does not fund the registration payment.

Prices are tiered by name length. Pass the name when quoting (`flow.quote(duration, name)`, or `labelLength` for `getFeeQuote`) and quote again when the name changes; a tiered Registrar rejects a quote without a length with `invalid_argument`. A quote binds its `labelLength` together with the amount. New registrations cannot contain `--` or start with `0x`; the SDK returns `invalid_name` before any wallet request, while existing names keep resolving and renewing. SDK 0.5.0 and earlier do not recognize the tiered Registrar and return `wrong_deployment`; upgrade to the current release.

`RegistrationPlanStore.load` must return the result of the last successful `save` for that key (read-your-writes). A store that serves stale reads can make the flow rebroadcast a transaction.

Persist the plan before sending. Track an existing transaction hash before retrying, and preserve an unknown-broadcast state until wallet activity is reconciled. Encrypted storage failures must block replacement of recovery data. Multiple tabs require a shared lease from the integrating application.

Administrators configure payment and default Resolver modules directly. A confirmed change takes effect immediately, preserves existing names and invalidates obsolete payment quotes. A replacement core deployment requires a new context and holder-authorized migration; plans cannot cross deployments. Migration preserves root ownership, expiry and the default address. Profiles, editors, subnames and primary consent are configured again on the destination. `mAZTEC` is a project test asset with no self-service faucet; official AZTEC settlement remains subject to asset verification.

## Launch Registrar

`NameRegistrarLaunch` is an optional V6/V7 module. The current testnet runs it in free mode with a 5-character public minimum; this does not announce a mainnet deployment. Public registration defaults to at least 7 characters; the live administrator can choose 3–31. Short names show “Not yet available”; reserved names show “Reserved”. Reservations use node keys, batches of 32 and zero padding. `deployments/reserved-labels.json` contains the categorized v3 content-policy list of 325 labels (all original v2 276 plus 49 additions; file schema `fog-reserved-labels/1`), all at least 7 characters. The loader rejects illegal labels and duplicates before hashing the sorted flat list; categories, corporate identity sources and change procedure are in `deployments/reserved-labels.md`. Support/official compounds are our anti-impersonation policy and do not claim an official company service, endorsement, ownership or partnership.

Each registration and renewal is exactly 365 days. `max_renew_ahead` is seconds, bounded at construction to 0–315360000 (10 years): 0 (the local/testnet script default) allows repeated renewal without a horizon; otherwise current expiry must be at most chain time plus the horizon. Mainnet sets `maxRenewAhead = 31536000`: renewal opens 1 year before expiry. Admin and treasury use placeholder address `0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68` (offline-generated, never deployed), with `adminPlaceholder: true`; replace with the actual trusted administrator and pass readiness before launch (single administrator is the product choice; multisig is optional). Pause blocks only public registration; holder renewal and administrator mint stay available, protecting holders during the grace period.

Free mode requires a zero token and all three prices zero: no token transfer, AuthWit or private token balance read. Fee Juice or sponsorship still pays network fees. Paid mode uses the same code with immutable token, treasury and 3/4/5+ prices; all public policy gates still apply. Authority is read from the Registry on every operation, so the nominee gains authority only after accepting the two-step handoff and the old administrator immediately loses it.

Administrator mint uses a separate commit-reveal domain, waits 60 seconds to 24 hours, writes the recipient directly, and grants one year without registration fees even in paid mode. Label rules, including no `--` or `0x`, still apply. Before switching instances, operator tooling combines the canonical list with every node discovered in the complete ReservedChanged history, copies policy and verifies storage parity and the immutable renewal cap. Price version must increase; any mismatch prevents the switch. Holdings, generations and records do not migrate. Old registration plans become invalid and need a fresh quote.

### Launch read API

- `getConfig(snapshot?)`: returns optional `launch: { minPublicLength, paused, maxRenewAhead }`; length is characters and the horizon is bigint seconds.
- `isReserved(node, snapshot?)`: bigint node → boolean for the active launch registrar; returns `false` on other registrar kinds.
- `eligibility(name, snapshot?)`: canonical root name → `open | too_short | reserved | paused`, checked in pause/minimum/reservation order at one snapshot; this does not test ownership or reserve the name.
- `name_reserved`, `name_not_available_yet`, `registration_paused` are stable error codes before commit/reveal. Non-year launch quotes use `invalid_argument`.

See `examples/consumer/registration.ts` (`inspectLaunch`), compiled against the independently installed SDK. No private wallet data enters these reads. Registration plans and saved hashes remain encrypted recovery data, separate from chain state; wallet/RPC/callback errors do not prove a reverted receipt.

Launch reveal defaults to `preflight: true`; a caller can explicitly override it when its wallet already guarantees simulation. A failed simulation occurs before the unknown-broadcast marker.

For a name-specific renewal quote, pass its current `expiresAt` (bigint chain seconds) to `getFeeQuote`. The returned optional `renewableAt` is the earliest chain timestamp in seconds; 0 means no horizon restriction. It is absent without `expiresAt` or for registration quotes, and does not replace ownership or lease-status checks. `renew()` supplies the expiry from its holding snapshot and rejects with `renewal_too_early` before payment authorization when that snapshot precedes the window. Manage disables renewal and shows “Renewable from <date>”; refresh the quote when the date is reached. Chain execution remains authoritative.

## V7 resolver and revision rules

Mainnet targets a fresh V7 (`protocol: 7`, retaining schema `fog-deployment-v6/1`). The current testnet stays on frozen V6; V2–V5 remain archives on the old rollup, with no migration to Aztec 6. Acceptance on V7 resets the resolver to the current default and emits ResolverChanged. Old-generation addresses, profiles, editors, primary consent and descendants cannot revive. A resolver can write only in the generation bound by that holder or default policy, and the supplied actor must be the current holder or editor. The SDK and web also verify its class and Registry binding.

V7 separates holder `NameRecord.revision` from editor `Holding.recordRevision`: editor writes cannot stale holder renewal, editor removal, resolver replacement or transfer acceptance. Resolver replacement clears the address and advances record revision, invalidating pending editor writes. V3–V6 retain a shared revision. `get_record_revision(node, generation)` / `getRecordRevision(node, generation, snapshot)` returns the generation's record revision as u32 / number.

An unverified resolver produces `resolveAddress.status = 'untrusted_resolver'` and `resolvePrimary.status = 'stale'` with reason `untrusted_resolver`. `inspectResolver` returns public address, verified, isDefault and optional zero / unknown_class / other_registry reason; transport errors still throw. V6 `acceptTransfer` refuses an unverified inherited resolver unless `acceptUnverifiedResolver: true` is explicit; the inherited resolver can also block recovery by pumping the shared revision. V6 testnet names must not be treated as holding value. V7 reports `resolverReset: true`. Reset checks the target resolver without requiring trust in the inherited one.

Before creating a plan or sending commit, the SDK requires 300 chain seconds of quote lifetime: 60 minimum commit age + 60 reveal margin + 180 proving, inclusion and checkpoint slack. `COMMIT_QUOTE_MARGIN = 300n`; `REVEAL_MARGIN = 60n`. Insufficient lifetime returns `quote_expired` before wallet submission. Allow adequate time for actual proving/inclusion; encrypted recovery and receipt-evidence rules still apply.

| API | Inputs | Result and errors |
| --- | --- | --- |
| `inspectResolver` | `bigint` node, `number` generation, optional `Snapshot` | `address`, `verified`, `isDefault`, optional `reason`; network errors throw |
| `getRecordRevision` | `bigint` node, `number` generation, `Snapshot` | `number` u32; returns name revision on V3–V6 |
| `acceptTransfer` | `FogContext`, `name`, optional `acceptUnverifiedResolver: boolean` | `tx`, `resolverReset`, inherited resolver inspection on V6; `invalid_argument` without consent |
| `resolveAddress` | `RegistryReader`, `name`, optional `Snapshot` | `resolved` only for a trusted binding; `untrusted_resolver` carries `resolver`, `node`, `nameStatus`, `snapshot` |

Import V7 execution bindings from `@fog/sdk/contracts/v7`; keep public readers on `@fog/sdk/read`. The V6 bindings remain at `@fog/sdk/contracts/v6`. These exports contain contract artifacts and belong behind user actions.

`setPrimary(ctx, { name, acceptUnverifiedResolver? }, opts?)` refuses an unverified resolver with `invalid_argument` unless explicitly opted in with `true`. The override preserves transport, active-lease and forward-address checks and cannot make `resolvePrimary` report trust. Only `resolveAddress` and `resolvePrimary` validate resolver trust; raw `RegistryReader.getAddress` / `@fog/sdk/read` returns public chain records for callers to validate.

L-02 remains open before mainnet: administrator changes to the default resolver take effect immediately, and V7 registrations, reissues and accepted transfers use that current default. Administrator compromise therefore affects future recipients. The product retains a trusted single administrator and the immediate module-configuration risk; monitoring continues to watch `configure_modules`.

`AddressChangedV3.revision` is the shared name revision on V3–V6 and the generation's record revision on V7. Indexers must select the meaning by protocol version and keep the V7 holder revision separate.

For existing V2–V7 deployments, core replacement requires a new address and plans cannot cross deployments. An independent V8 supports exact-class, delayed same-address upgrades with queued artifact refresh. Existing V6 cannot be retrofitted and old names are not migrated; see [V8 core upgrades](core-upgrade-v8.md).
