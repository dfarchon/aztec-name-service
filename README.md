# Fog Names (`.fog`)

Fog Names is a public `.fog` name registration and resolution service on Aztec: Noir contracts, a TypeScript SDK (`@fog/sdk`), a React web app, and a Cloudflare monitor in one npm-workspace repository (`sdk`, `web`, `e2e`, `ops`). It supports public names and holders, Aztec forward addresses, bidirectionally verified primary names, recipient-confirmed transfers, editor permissions, subnames, public profiles, and multi-chain address records.

**Status**: Deployed on the Aztec public testnet only; contracts and SDK have not been audited. Testnet registration is currently free: the active Registrar is `NameRegistrarLaunch` with no payment token, and network fees are paid by the shared sponsor contract. See [docs/sdk-onboarding.md](docs/sdk-onboarding.md) for SDK integration and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Name and lease rules

| Topic | Behavior |
| --- | --- |
| Labels | 3–31 lowercase ASCII letters, digits, or hyphens; no leading or trailing hyphen; input is normalized to lowercase |
| Display suffix | Names display as `<label>.fog` (Fully Obfuscated Glyph). The suffix is presentation-only: contracts store and hash bare labels, so `alice.fog` is root label `alice`; user inputs accept labels with or without `.fog` |
| New-label restrictions | Cannot contain consecutive `--` (prevents `xn--` punycode spoofing) or start with `0x` (prevents address spoofing); enforced on-chain by tiered and launch Registrars while legacy names continue resolving and renewing |
| Registration | `commit` → wait 60 chain seconds → `reveal`; commitments expire after 24 hours |
| Lease duration | 1–5 whole years (365 days per year); launch Registrars issue and renew fixed 1-year leases |
| Expiry | Resolution stops immediately at expiry; the previous holder can renew during a 30-day grace period, after which anyone can register the next generation |
| Fees | Each Registrar fixes its payment token, annual price, and treasury; the administrator can activate a new Registrar immediately. Tiered Registrars price by label length for both registration and renewal |
| Authority | Public owner stored on-chain and authorized by the calling account; address updates and renewals check both `generation` and `revision` |
| Primary name | Confirmed by the target account; verified reads check active lease, matching `generation`, matching forward address, and matching `bindingVersion` |
| Re-registration | Increments `generation` and starts with clean records; prior primary bindings never revive |
| Discovery | Paginates public registration events and verifies current on-chain holders; transport errors and incomplete pages never appear as an empty portfolio |

| Management | Behavior |
| --- | --- |
| Transfers | Offered by the holder and accepted by the recipient within 7 days; cancellable; acceptance increments `generation` |
| Record reset | Transfers invalidate previous forward addresses, profile records, editors, primary confirmations, and subnames |
| Editor | One optional editor per name; may update the default Aztec address and profile records, but cannot renew, transfer, issue subnames, change the resolver, or delegate roles |
| Subnames | Issued, revoked, or reissued by the parent holder up to 4 levels deep; lease cannot outlive any ancestor; ancestor `generation` changes invalidate prior descendant state |
| Profile records | Up to 64 distinct keys per generation (keys up to 31 bytes; UTF-8 values up to 248 bytes); clearing a value does not reclaim key quota |
| Multi-chain addresses | Stored under keys such as `address:eip155:1` and `address:eip155:8453` alongside the default Aztec address; records store addresses only and never transfer cross-chain assets |

See [Protocol](docs/protocol.md) for module configuration and V6/V7 behavior, and [V8 core upgrades](docs/core-upgrade-v8.md) for the independent V8 implementation, fixed upgrade delays, and rollback boundaries.

## Pricing

Registration and renewal are tiered by label length with target annual pricing of **128 AZTEC (3 characters), 32 AZTEC (4 characters), and 1 AZTEC (5+ characters)** at 18 decimals. Target pricing metadata lives in `deployments/aztec-pricing.json`, while live quotes are always read from the active on-chain Registrar. Testnet registration is currently free; an earlier tiered deployment rehearsed paid flows with `mAZTEC`. Official L2 transferable AZTEC settlement is not yet configured, and Fee Juice pays network gas only.

## Repository layout

| Directory | Contents |
| --- | --- |
| `contracts/name_registry_v6` | Current core Registry on the Aztec 6 testnet (frozen) |
| `contracts/name_registry_v7` | Frozen successor implementation with transfer resolver reset and separate record revisions |
| `contracts/name_registry_v8`, `_v8_rehearsal` | Independent V8 suite and exact-layout rehearsal successor with fixed core upgrade delays |
| `contracts/name_registry`, `_v3`, `_v4`, `_v5` | Frozen legacy Registry sources and storage baselines (read-only archive) |
| `contracts/name_registrar`, `_tiered`, `_launch` | Single-price, length-tiered, and launch fee/policy Registrar modules |
| `contracts/name_resolver` | Default forward-address Resolver module |
| `contracts/test_token` | Standard Aztec Token fixture for TXE fee tests (see `third-party/`) |
| `sdk` | Wallet-free reads (`@fog/sdk/read`), bidirectional resolution, discovery, transactions, fee authorization, and registration recovery |
| `web` | Search, registration, portfolio, name management, documentation center, and live service status |
| `ops` | Cloudflare site Worker and per-minute health monitor backed by D1 |
| `e2e` | Local-chain acceptance suites, public testnet runners, and V6 deployment tooling |
| `examples/consumer` | Standalone consumer starter compiled against an independently packed `@fog/sdk` |
| `deployments` | Testnet deployment manifests, reserved label policy, and pricing metadata |

See [Code structure](docs/code-structure.md) for module responsibilities and extension boundaries.

## Development

Requires Node 24 (`>=24.12.0`) and npm. Compiled contract artifacts are committed with the SDK, so editing TypeScript workspaces does not require the Aztec toolchain.

```sh
npm ci
npm run check                                                   # build SDK and typecheck all workspaces
npm test                                                        # SDK, web, e2e, ops, pricing, bundle, deployment, and Brillig tests
VITE_NETWORK=local VITE_FEE_PAYMENT=sponsored npm run build     # build SDK and local web bundle
npm run dev                                                     # build SDK and start Vite dev server
```

Documentation and consumer integration checks: `npm run check:docs`, `npm run check:format`, and `npm run test:consumer` (requires the `zip` CLI). CI runs all of the above plus `npm audit --audit-level=high`, without contract, chain, or browser runs.

### Contracts

The toolchain is pinned to Aztec **6.0.0** (`.aztecrc`). Scripts invoke `~/.aztec/versions/6.0.0` via `scripts/aztec.mjs` without relying on a global Aztec binary; set `FOG_AZTEC_TOOLCHAIN_DIR` for a custom installation path.

```sh
npm run build:contracts
npm run generate:sdk     # sync artifacts, generate wrappers and modular-metadata.json
npm run test:contracts   # TXE tests on port 8081
npm run check:brillig
npm run check && npm test
```

Contract class IDs must remain unchanged within a single toolchain version, and storage baselines (`contracts/*/storage-layout.json`) are never regenerated to mask incompatible edits.

### Local chain

```sh
NO_PROXY=127.0.0.1,localhost node scripts/aztec.mjs start --local-network   # port 8080
NO_PROXY=127.0.0.1,localhost npm run test:e2e
```

Module, fee, and extension flows run against an isolated local node on port 8082 (debug RPC on 8882):

```sh
ANVIL_PORT=8547 node scripts/aztec.mjs start --local-network --port 8082 --admin-port 8882
npm run test:modular
npm run test:extensions
```

Local chains disable proving and do not establish real-proof or public-network readiness. For local web runs, copy `web/.env.example` to `web/.env` and set `VITE_REGISTRY`. Browser smoke checks run via `npm run smoke:* -w @fog/web` against a built SDK and running server (`BASE=<vite url>`).

RPC configuration accepts one `VITE_NODE_URL`. DEV defaults to `local` when `VITE_NETWORK` is absent. Only `local` defaults to `http://localhost:8080` when the URL is omitted (an empty string is invalid), with chain ID 31337 and an optional rollup pin. Public profiles require explicit `testnet-v6` or `mainnet`, a fee mode, and chain/rollup pins matching the selected network. Public production builds always require HTTPS; explicitly selected public DEV profiles may use HTTP loopback fixtures. Invalid configuration fails the build, with no public profile inference or network fallback. A read transport failure returned by the transport (including a single failed `noRetry` call) or an identity mismatch withdraws the live reader and write context. Recovery rechecks identity and known contract classes while retaining saved transaction hashes.

## Public testnet

The active deployment is `deployments/testnet-v6.json` (Aztec 6 testnet, V6 Registry, free `NameRegistrarLaunch` with a 5-character public minimum). Deployed on 2026-11-11, it replaced the earlier paid tiered V6 deployment archived at `deployments/legacy/testnet-v6-tiered.json` without migrating names. Earlier V2–V5 deployments on the Aztec 5.2.1 rollup are archived read-only under `deployments/testnet.json` and `deployments/legacy/`.

```sh
# Read-only preflight: calls getNodeInfo / getContract only, generates no keys, and sends no transactions
npm run deploy:v6 -- --network testnet-v6 --registrar tiered --price-version 1 --treasury 0x0000000000000000000000000000000000000000000000000000000000000001 --state-dir /tmp/fog-v6-public-dryrun --dry-run
# Real-proof acceptance against the archived paid V6 manifest (mints mAZTEC and broadcasts paid transactions)
FOG_V6_E2E_REPORT=/path/to/report.json npm run test:testnet:v6
```

Public scripts verify node identity (`chainId`, `rollupVersion`, rollup address, `nodeVersion`, and `realProofs`) before broadcasting, store private keys and checkpoints outside the repository (default `~/.local/share/fog/`), and persist each transaction hash before `sendTx` so interrupted runs resume without duplicate broadcasts. See [V6 deployment](docs/deploy-v6.md).

## Website and monitoring

[Testnet app](https://fog-testnet.huantian233.workers.dev) · [Service status](https://fog-testnet.huantian233.workers.dev/#/status) · [Documentation](https://fog-testnet.huantian233.workers.dev/#/docs)

The site Worker and monitor Worker share one D1 database: every minute the monitor checks the website, RPC endpoint, network identity, block progression, contract classes, and sponsor balance, alerting after three consecutive failures. Web Vitals report only metric names, numeric values, and release IDs—never addresses, names, or transactions. All articles, Markdown exports, and `/llms-full.txt` are generated from `web/src/docs-content.ts`.

```sh
npm install --global wrangler@4.147.0
wrangler login
wrangler d1 execute fog-testnet-monitor --config ops/wrangler-monitor.jsonc --remote --file ops/schema.sql
npm run deploy:testnet
```

The D1 `database_id` in `ops/wrangler*.jsonc` belongs to the existing test environment; create a new D1 database and update both configs when deploying to another Cloudflare account. Deployment requires a clean working tree and stamps the short `HEAD` commit hash into `/health.txt`.

## SDK

```sh
npm run pack:sdk                       # produces fog-sdk-<version>.tgz
npm install /path/to/fog-sdk-<version>.tgz
```

`@fog/sdk` is distributed as a tarball rather than published to public npm. It identifies V2–V8 registries and supported Registrars by exact on-chain class ID, failing closed with `wrong_deployment` on unknown classes. Registration flows encrypt and persist plans before sending, check receipts for known hashes first, and clear a hash only when a receipt proves the transaction reverted or dropped. See [SDK integration](docs/sdk-onboarding.md) and [Dependency security](docs/dependency-security.md).

## Security and license

Report vulnerabilities privately following [SECURITY.md](SECURITY.md). First-party code is licensed under [Apache-2.0](LICENSE); see [third-party/](third-party/README.md) for upstream attributions.

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

### Resolver integration

```typescript
import { resolveAddress, type RegistryReader } from '@fog/sdk/read';
import { setResolver, type FogContext } from '@fog/sdk';

export async function receivingAddress(reader: RegistryReader, name: string) {
  const result = await resolveAddress(reader, name);
  if (result.status === 'untrusted_resolver') throw new Error('Verify the resolver before using this address');
  return result.status === 'resolved' ? result.address : undefined;
}

export async function restoreDefaultResolver(ctx: FogContext, name: string) {
  const modules = await ctx.reader.getModules();
  return setResolver(ctx, { name, resolver: modules.resolver });
}
```

`setPrimary(ctx, { name, acceptUnverifiedResolver? }, opts?)` refuses an unverified resolver with `invalid_argument` unless explicitly opted in with `true`. The override preserves transport, active-lease and forward-address checks and cannot make `resolvePrimary` report trust. Only `resolveAddress` and `resolvePrimary` validate resolver trust; raw `RegistryReader.getAddress` / `@fog/sdk/read` returns public chain records for callers to validate.

L-02 remains open before mainnet: administrator changes to the default resolver take effect immediately, and V7 registrations, reissues and accepted transfers use that current default. Administrator compromise therefore affects future recipients. The product retains a trusted single administrator and the immediate module-configuration risk; monitoring continues to watch `configure_modules`.

`AddressChangedV3.revision` is the shared name revision on V3–V6 and the generation's record revision on V7. Indexers must select the meaning by protocol version and keep the V7 holder revision separate.
