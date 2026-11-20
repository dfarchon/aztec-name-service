# Aztec 6 deployment rehearsal

This runner deploys a fresh V6 registry with zero legacy, a resolver, a flat or tiered registrar, and a new 18-decimal mAZTEC test token (or free `NameRegistrarLaunch`). It does not migrate names from earlier rollups. Historical V2–V5 runners and archive manifests keep their existing configuration.

## Local

Use Aztec 6.0.0 and a proof-disabled chain on `127.0.0.1:8080` (chain ID 31337). All services must bind to `127.0.0.1`; stop them after the rehearsal. Do not run TXE contract tests concurrently with the local chain.

Local SponsoredFPC may be derived and registered with the wallet before publication; its class must match the official SponsoredFPC artifact. If published, its address and class are also checked. Public testnet preflight requires publication.

The local acceptance runner advances blocks with unrelated commits before checking commitment maturity. Both flat and tiered renewals use SDK `renew(ctx, { name, duration })`, with exact user debit, treasury credit and expiry checks. The SDK selects renewal arguments from the registrar kind recognized by class ID in the same decision that registers its artifact.

```sh
npm run deploy:v6 -- --network local --registrar flat --price-version 1 --state-dir /tmp/fog-v6-flat
npm run deploy:v6 -- --network local --registrar tiered --price-version 1 --state-dir /tmp/fog-v6-tiered
FOG_V6_MANIFEST=/tmp/fog-v6-flat/deployment-v6.json FOG_V6_STATE_DIR=/tmp/fog-v6-flat npm run test:e2e:v6-manifest
FOG_V6_MANIFEST=/tmp/fog-v6-tiered/deployment-v6.json FOG_V6_STATE_DIR=/tmp/fog-v6-tiered npm run test:e2e:v6-manifest
npm run check:deployment -- --v6-manifest /tmp/fog-v6-tiered/deployment-v6.json
```

`--network`, `--registrar flat|tiered`, and `--price-version` are required. The price version is a positive u32 integer without a default. Prices are integer token base units from `deployments/aztec-pricing.json`; `10^18` units = 1 mAZTEC. Tiered uses the 3- and 4-character annual prices; longer labels use `annualPrice`. `annualPriceStatus=provisional` produces a warning without changing prices. The official Token artifact is the default; `--token repo` selects the frozen repository `test_token` artifact. `--token-name` and `--token-symbol` default to `mAZTEC`; decimals are fixed at 18. Without a keys file, local treasury defaults to the new owner. With a keys file, treasury defaults to its separate treasury account. Local manifest acceptance restores that account from the same state directory to verify exact private treasury credits, as well as user debits.

## Offline keys

```sh
npm run deploy:v6 -- --init-keys --network local --state-dir /tmp/fog-v6-keyed
npm run deploy:v6 -- --network local --registrar tiered --price-version 1 --state-dir /tmp/fog-v6-keyed --dry-run
npm run deploy:v6 -- --network local --registrar tiered --price-version 1 --state-dir /tmp/fog-v6-keyed
FOG_V6_MANIFEST=/tmp/fog-v6-keyed/deployment-v6.json FOG_V6_STATE_DIR=/tmp/fog-v6-keyed npm run test:e2e:v6-manifest
```

`--init-keys` accepts only `--network local|testnet-v6` and optional `--state-dir`. It is offline: no node, wallet, confirmation or treasury input is needed. It generates separate owner and treasury Schnorr accounts and four deployment salts in `keys.json` (`fog-v6-keys/1`). Output contains only network, path, public owner/treasury addresses and an offline backup reminder. Existing keys, state, lock, temporary files or dangling links cause refusal before generation; an existing directory must already be private and owned by the current user. New directories use `0700` and the file uses `0600`. Repository paths, legacy V2–V5 directories and the other network's default directory are rejected, including resolved symlink paths.

Deployment takes treasury from the keys file; an explicit differing `--treasury` fails before network access. A new testnet deployment requires keys; existing checkpoints without keys remain resumable. Local deployment without keys retains random owner generation. Keys and checkpoint owner fields, salts, owner address and treasury must agree before wallet creation (`Checkpoint keys file mismatch` on drift). Keep `keys.json` for recovery and back it up offline. Owner private values also remain in `state.json` under the checkpoint schema. Treasury is an initializerless Schnorr address that can receive payments before deployment; losing its keys prevents spending. Do not print either private file.

## Read-only public preflight

```sh
npm run deploy:v6 -- --network testnet-v6 --registrar tiered --price-version 1 --treasury 0x0000000000000000000000000000000000000000000000000000000000000001 --state-dir /tmp/fog-v6-public-dryrun --dry-run
```

The treasury above is a placeholder and `priceVersion=1` is a rehearsal input; choose both deliberately for a real deployment. A dry run sends no transaction.

The default RPC is `https://aztec-testnet.drpc.org`. A node URL override still requires exact identity: `nodeVersion` `6.0.0`, `chainId` `11155111`, `rollupVersion` `679261766`, `rollup` `0x1f435a7f2da358caf887a470faeee7d5d5f4efba` and `realProofs=true`. SponsoredFPC must exist and match the derived class/address. Identity rejection occurs before wallet/PXE/state creation. Dry runs call only `getNodeInfo`/`getContract`, print the methods used, and generate no keys or salts. Without a keys file, owner/deployer and dependent contract addresses are shown as `"pending: derived after formal local key generation"`. With a keys file, dry-run uses its public address/salt projection to predict all six owner, treasury and contract addresses, and prints no private values. Class IDs, network identity, SponsoredFPC, prices, steps and the confirmation string remain available; confirmation does not depend on the owner. Dry runs create no wallet, state, lock or manifest. Do not change RPC providers to work around a failed public preflight.

For a public deployment, the runner requires `--confirm` exactly matching the string printed by dry-run. It binds network identity, registrar kind, `priceVersion`, token source and treasury. Missing/wrong confirmation fails before network I/O.

## Recovery and data

State defaults to `~/.local/share/fog/local-aztec6-6.0.0/` or `~/.local/share/fog/testnet-aztec6-6.0.0/`. `--state-dir` must remain outside the repository and legacy default directories. Keep local and public state separate. Directory mode is `0700`; atomic state writes use `0600`. Keys and salts stay only in private state and wallet storage; never copy them into logs, manifests or the repository. The manifest contains public addresses, identity, classes, prices, transaction hashes and deployment time; schema is `fog-deployment-v6/1`. Public display metadata and chain state are distinct from private recovery data. A local manifest cannot be written into `deployments/`.

Rerun the same command and directory after interruption. Hashes are saved before `sendTx`; the runner prints `SKIP` for completed steps and `RESUME` for saved pending hashes. It tracks existing hashes without automatic resending. Changes to policy or network identity reject the checkpoint. A stale lock is removed only when its owner process no longer exists. Stop the entire process group when testing interruption.

If a receipt is dropped, the runner checks the deterministic deployment address or bootstrap bindings. An existing matching effect is recorded as `published-without-receipt`. If absent, it stops. Only explicit `--rebroadcast <step>` can clear that hash, and only after a dropped receipt and absent effect are both confirmed. An RPC failure does not establish absence. Reverted receipts and unknown timeouts remain stopped for inspection. Never delete private checkpoints to recover a pending public transaction.

`check:deployment` validates Worker alignment and canonical manifests. A canonical V6 testnet manifest forbids `sample=true`. `--v6-manifest` validates an explicit local rehearsal or sample without comparing against Workers. Proof-disabled local success does not establish real-proof or public-network readiness. CI verifies the official Token pin; the repo Token pin is checked locally after `npm run build:contracts`.

## Fee Juice and mainnet preparation

Select `--fee-payment sponsored|fee-juice`. Local and testnet default to `sponsored`; mainnet permits only `fee-juice`. Sponsored testnet confirmation and manifest fields remain unchanged. Fee-juice manifests explicitly set `feePayment: "fee-juice"` and omit sponsor contracts (`sponsoredFpc: null`). Network fees use public Fee Juice, separate from the registrar's registration token.

Public fee-juice deployment requires an explicit positive `--min-fee-juice` in wei (`10^18` wei = 1 Fee Juice), a dated directory whose basename matches `testnet-aztec6-6.0.0-nofpc-rehearsal-YYYYMMDD`, and an explicit `--manifest-out` outside `deployments/`. Never reuse the live sponsored deployment directory. Confirmation appends `:fee=fee-juice`. A funded sender pays directly; otherwise the first unfinished step may use an unconsumed bridged claim. Its L1-to-L2 message must already be inserted at the proven tip. Insufficient funds without a claim refuse before broadcasting. A claim is reserved together with the transaction hash and cannot be reused after that step completes; an explicit retry requires a `DROPPED` receipt and no chain effect.

The bridge helper accepts only `local` and `testnet-v6`. `--init-l1-key` creates a new offline L1 key with exclusive creation, mode `0600`, and prints only its public address. Keep it inside the private state directory. Fund that address with L1 gas before bridging. `--l1-rpc-url` must have no credentials, query or fragment; it is not printed or persisted, only its host. The helper checks L1 chain identity and the node's pinned portal/handler, reads the handler's mint amount, mints, approves, and deposits an explicit amount. It persists the claim secret before any L1 send and checkpoints each signed transaction's hash before forwarding it. Pending hashes stop without resend. Confirmed receipts resume the remaining steps; a completed claim is a no-op. Output contains public addresses, hashes, message hash, leaf index and amount only. `bridge.json`, L1 keys and wallet state are private recovery data; never copy them into a manifest or logs.

```sh
# Public rehearsal is operator-only; choose the date, amount, price version and minimum.
S="$HOME/.local/share/fog/testnet-aztec6-6.0.0-nofpc-rehearsal-<YYYYMMDD>"
npm run deploy:v6 -- --init-keys --network testnet-v6 --state-dir "$S"
npm run bridge:fee-juice -- --init-l1-key --network testnet-v6 --state-dir "$S"
# Fund the printed public L1 address with Sepolia ETH, then preview the exact confirmation.
npm run bridge:fee-juice -- --network testnet-v6 --state-dir "$S" --l1-rpc-url '<SEPOLIA_RPC>' --amount '<CHOSEN_WEI>' --dry-run
# Replace --dry-run with --confirm '<PRINTED_CONFIRMATION>' after reviewing.
npm run deploy:v6 -- --network testnet-v6 --fee-payment fee-juice --registrar tiered --price-version '<CHOSEN_VERSION>' --state-dir "$S" --manifest-out "$S/deployment-v6.json" --min-fee-juice '<CHOSEN_MIN_WEI>' --dry-run
node scripts/build-site.mjs --network testnet-v6 --manifest "$S/deployment-v6.json" --out "$S/site"
# Preview on 127.0.0.1 only. This does not publish the site.
```

Mainnet identity is pinned to Aztec 6.0.0, L1 chain 1, rollup version 2070860440 and rollup `0xe37a2663cc9c119ba41572c40fab0bbb23a5402f`. `deployments/mainnet.template.json` is a template, never a live deployment. The registration token, final pricing, admin/multisig, treasury, RPC provider, domain and Cloudflare resources remain undecided. Mainnet deployment, build and publication refuse with named blockers before network access or subprocess execution. A mainnet deployment dry run needs an explicit `--node-url` and only checks `getNodeInfo`, then reports blockers; it creates no wallet. Token-deploying mainnet flows are refused even if configuration blockers are resolved. There is no existing-token flow. No mainnet deployment or publication is authorized by these commands.

Web builds require `VITE_NETWORK` and `VITE_FEE_PAYMENT` on public networks. Embedded public sponsored mode requires an explicitly configured FPC; only proof-disabled chain 31337 may derive one. Fee-juice mode never registers an FPC. Before register, renew, records or primary writes, the shared wallet queue verifies identity and checks public Fee Juice against current minimum fees × default node gas limits. The error includes account and balance. The monitor keeps its check names; in fee-juice mode sponsorship is `N/A`, and an undecided operator balance is `N/A`. Once an operator is chosen, configure its precomputed map slot and watermark; `check:deployment` verifies the slot with the 6.0.0 stdlib.

## Launch Registrar

`NameRegistrarLaunch` is an optional V6/V7 module. The current testnet runs it in free mode with a 5-character public minimum; this does not announce a mainnet deployment. Public registration defaults to at least 7 characters; the live administrator can choose 3–31. Short names show “Not yet available”; reserved names show “Reserved”. Reservations use node keys, batches of 32 and zero padding. `deployments/reserved-labels.json` contains the categorized v3 content-policy list of 325 labels (all original v2 276 plus 49 additions; file schema `fog-reserved-labels/1`), all at least 7 characters. The loader rejects illegal labels and duplicates before hashing the sorted flat list; categories, corporate identity sources and change procedure are in `deployments/reserved-labels.md`. Support/official compounds are our anti-impersonation policy and do not claim an official company service, endorsement, ownership or partnership.

Each registration and renewal is exactly 365 days. `max_renew_ahead` is seconds, bounded at construction to 0–315360000 (10 years): 0 (the local/testnet script default) allows repeated renewal without a horizon; otherwise current expiry must be at most chain time plus the horizon. Mainnet sets `maxRenewAhead = 31536000`: renewal opens 1 year before expiry. Admin and treasury use placeholder address `0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68` (offline-generated, never deployed), with `adminPlaceholder: true`; replace with the actual trusted administrator and pass readiness before launch (single administrator is the product choice; multisig is optional). Pause blocks only public registration; holder renewal and administrator mint stay available, protecting holders during the grace period.

Free mode requires a zero token and all three prices zero: no token transfer, AuthWit or private token balance read. Fee Juice or sponsorship still pays network fees. Paid mode uses the same code with immutable token, treasury and 3/4/5+ prices; all public policy gates still apply. Authority is read from the Registry on every operation, so the nominee gains authority only after accepting the two-step handoff and the old administrator immediately loses it.

Administrator mint uses a separate commit-reveal domain, waits 60 seconds to 24 hours, writes the recipient directly, and grants one year without registration fees even in paid mode. Label rules, including no `--` or `0x`, still apply. Before switching instances, operator tooling combines the canonical list with every node discovered in the complete ReservedChanged history, copies policy and verifies storage parity and the immutable renewal cap. Price version must increase; any mismatch prevents the switch. Holdings, generations and records do not migrate. Old registration plans become invalid and need a fresh quote.

### Local launch preview

```sh
npm run deploy:v6 -- --network local --node-url http://127.0.0.1:8082 --registrar launch --token none --price-version 1 --min-public-length 7 --initial-paused true --max-renew-ahead 0 --state-dir /tmp/fog-launch-preview --dry-run
```

This read-only local preview sends no transaction. Deployment seeding verifies the reserved list before bootstrap and leaves the requested pause state unchanged; unpause is an explicit administrator action. `e2e/src/launch-admin.ts` offers a read-only CLI preview. `runLaunchAdmin` and `switchLaunchRegistrar` require an injected `FogContext` and explicit `{ broadcast: true }` to mutate; they never load keys. Keep an admin mint process alive through commit maturation: its secret stays in application memory, and interrupting it requires a new mint commitment. No website admin console or public SDK admin API is added.

## V7/V8 resolver and revision rules

Mainnet targets a fresh V8 free-launch suite (`protocol: 8`, `registryVersion: 8`, retaining schema `fog-deployment-v6/1` and V7 business rules). The current testnet stays on frozen V6; V2–V5 remain archives on the old rollup, with no migration to Aztec 6. Acceptance on V7/V8 resets the resolver to the current default and emits ResolverChanged. Old-generation addresses, profiles, editors, primary consent and descendants cannot revive. A resolver can write only in the generation bound by that holder or default policy, and the supplied actor must be the current holder or editor. The SDK and web also verify its class and Registry binding.

V7 separates holder `NameRecord.revision` from editor `Holding.recordRevision`: editor writes cannot stale holder renewal, editor removal, resolver replacement or transfer acceptance. Resolver replacement clears the address and advances record revision, invalidating pending editor writes. V3–V6 retain a shared revision. `get_record_revision(node, generation)` / `getRecordRevision(node, generation, snapshot)` returns the generation's record revision as u32 / number.

An unverified resolver produces `resolveAddress.status = 'untrusted_resolver'` and `resolvePrimary.status = 'stale'` with reason `untrusted_resolver`. `inspectResolver` returns public address, verified, isDefault and optional zero / unknown_class / other_registry reason; transport errors still throw. V6 `acceptTransfer` refuses an unverified inherited resolver unless `acceptUnverifiedResolver: true` is explicit; the inherited resolver can also block recovery by pumping the shared revision. V6 testnet names must not be treated as holding value. V7 reports `resolverReset: true`. Reset checks the target resolver without requiring trust in the inherited one.

Before creating a plan or sending commit, the SDK requires 300 chain seconds of quote lifetime: 60 minimum commit age + 60 reveal margin + 180 proving, inclusion and checkpoint slack. `COMMIT_QUOTE_MARGIN = 300n`; `REVEAL_MARGIN = 60n`. Insufficient lifetime returns `quote_expired` before wallet submission. Allow adequate time for actual proving/inclusion; encrypted recovery and receipt-evidence rules still apply.

### Version selection and offline placeholder

`--registry-version 6|7` defaults to 6 for local/testnet and 7 for mainnet. Testnet requires 6; mainnet requires 7. The confirmation includes `registryVersion`; V7 checkpoint policy hashes bind that version. Readback checks both class ID and `implementation_version`. The mainnet broadcaster remains blocked by the existing readiness and fee-token decisions.

Run the following command in a private offline environment. It creates a new private directory and exclusively writes a `0600` file, prints only address/directory and makes no deployment or transaction. The mainnet placeholder uses the 6.0.0 Schnorr account helper; its owner/treasury/salts field conventions match existing key files, but it is not a local/testnet initializerless deployment checkpoint. Preserve it offline and replace both admin and treasury before launch; never paste secret material into a report.

```sh
node --import tsx e2e/src/generate-placeholder-admin.ts
```

The template uses placeholder admin/treasury `0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68` (offline-generated, never deployed), with `adminPlaceholder: true`; replace with the actual trusted administrator before launch (multisig is optional). Readiness rejects a copied placeholder. It also requires protocol 8 (`allowRehearsalSuccessor: false`) and exactly 31536000 seconds for launch renewals.

### Mainnet V8 free-launch operator

`npm run deploy:mainnet:v8` (`e2e/src/mainnet-v8-launch.ts`) executes isolated-signer mainnet preparation, optional Ethereum Mainnet `$AZTEC` Fee Juice Portal bridging, checkpointed V8 + `NameResolver` + free `NameRegistrarLaunch` deployment (`initialPaused: true`), 6-transaction batched (60-per-tx) 325-label reservation seeding/readback, and post-deploy Launch administration (`--admin-action unpause|pause|minimum|mint`):

```sh
# 1. Offline isolated account generation under fog-signer or ans-signer (mode 0700)
S="/var/lib/ans-signer/mainnet-v8-launch-<YYYYMMDD>"
npm run deploy:mainnet:v8 -- --init-accounts --state-dir "$S"
# 2. Read-only mainnet preflight (does not open credentials.json or send transactions)
npm run deploy:mainnet:v8 -- --state-dir "$S" --node-url '<MAINNET_HTTPS_RPC>' --domain '<HTTPS_DOMAIN>' --manifest-out "$S/mainnet.json" --max-fee-juice 150 --dry-run
# 3. After funding L2 Fee Juice and reviewing confirmation, deploy (--send --confirm '<EXACT>')
# 4. Copy "$S/mainnet.json" to deployments/mainnet.json, configure ops/wrangler*mainnet.jsonc, commit, and run:
npm run deploy:mainnet
# 5. Unpause public registration once monitoring reports healthy:
npm run deploy:mainnet:v8 -- --admin-action unpause --state-dir "$S" --node-url '<MAINNET_HTTPS_RPC>' --dry-run
```

`setPrimary(ctx, { name, acceptUnverifiedResolver? }, opts?)` refuses an unverified resolver with `invalid_argument` unless explicitly opted in with `true`. The override preserves transport, active-lease and forward-address checks and cannot make `resolvePrimary` report trust. Only `resolveAddress` and `resolvePrimary` validate resolver trust; raw `RegistryReader.getAddress` / `fog-sdk/read` returns public chain records for callers to validate.

L-02 remains open before mainnet: administrator changes to the default resolver take effect immediately, and V7 registrations, reissues and accepted transfers use that current default. Administrator compromise therefore affects future recipients. The product retains a trusted single administrator and the immediate module-configuration risk; monitoring continues to watch `configure_modules`.

`AddressChangedV3.revision` is the shared name revision on V3–V6 and the generation's record revision on V7. Indexers must select the meaning by protocol version and keep the V7 holder revision separate.
