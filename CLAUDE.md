# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

ANS is an ENS-like name service on Aztec: Noir contracts, a TypeScript SDK (`@ans/sdk`), a React/Vite site, a Cloudflare monitor and chain acceptance scripts, in one npm-workspace repo (`sdk`, `web`, `e2e`, `ops`). **`AGENTS.md` holds the binding rules** (product boundary, legacy compatibility, verification and delivery rules); `README.md` (Chinese) holds the protocol rules; `docs/code-structure.md` holds module boundaries. Read them before changing behavior. Docs, UI strings and commits are mostly Chinese, and user-facing docs are bilingual.

## Toolchain

- Aztec **6.0.0** everywhere (`.aztecrc`). Contracts go through `node scripts/aztec.mjs …`, which checks `.aztecrc` and runs `~/.aztec/versions/6.0.0` (`node_modules/@aztec-labs/aztec`) without touching the global Aztec install. Aztec.nr comes from `aztec-labs-eng/aztec-nr` tag `v6.0.0`. npm packages are exact `@aztec-labs/*` 6.0.0. Never use bare `nargo`.
- Node 24 (`.nvmrc`, >=24.12) and npm. Commit `package-lock.json`, and run `npm ci` after pulling because the lockfile changes often.

## Commands

```sh
npm run check            # builds SDK, typechecks all workspaces (web/e2e typecheck against sdk/dist)
npm test                 # SDK, e2e and ops unit tests, plus pricing, bundle budget and deployment config
npm run build            # SDK + web production build
npm run check:docs       # bilingual docs, and README code blocks must match web/src/docs-examples.ts
npm run check:format     # pinned prettier on integration files; fix with npm run format:integration
npm run test:consumer    # packs SDK, installs it independently, compiles examples/consumer and doc examples (needs the zip CLI)
```

CI runs all of the above plus `npm audit --audit-level=high` and `pack:sdk`. It does not run contract, chain or browser tests.

A single SDK test: `cd sdk && node --import tsx --test --test-name-pattern "<name>" test/<file>.test.ts`.

### Contracts

- Edit flow: `npm run build:contracts` → `npm run generate:sdk` → `npm run test:contracts` → `npm run check && npm test`.
- `generate:sdk` copies the artifacts from `contracts/target/` into `sdk/src/artifacts/` and regenerates the wrappers plus `modular-metadata.json`, which pins class IDs and storage slots.
- A new contract package must be added in three places: `contracts/Nargo.toml`, `sdk/scripts/sync-artifacts.mjs` and `sdk/scripts/read-metadata.mjs`.
- Run one package's tests: `cd contracts && NO_PROXY=127.0.0.1,localhost node ../scripts/aztec.mjs test --package <pkg> --test-threads 2`. TXE listens on 8081. If a proxy is set, `NO_PROXY` is required, and every test fails with "Failed calling external resolver" when the TXE worker crashed. Look for the real error, often a bad `env.deploy("@pkg/Contract")` path, in the full log.
- A contract crate cannot depend on both `name_registry_v3` and `name_registry_v5`, because the event selectors collide. Registrar and resolver tests use the V3 registry and its interface, which V5 shares.
- `generate:sdk` rewrites artifact debug paths to repository/dependency-relative form, so rebuilding on another machine does not leak local paths. Class IDs are pinned per toolchain version and must stay unchanged within 6.0.0 (`sdk/test/modular.test.ts` checks them). Storage slots never change. Check the Brillig diagnostic baseline with `npm run check:brillig`.

### Chain and browser tests (manual)

- Local node E2E: `NO_PROXY=127.0.0.1,localhost node scripts/aztec.mjs start --local-network` (port 8080), then `npm run test:e2e`. `test:modular` and `test:extensions` default to an isolated node on 8082 with the debug RPC on 8882: `ANVIL_PORT=8547 node scripts/aztec.mjs start --local-network --port 8082 --admin-port 8882`, then `npm run test:modular` (README.md has the details). Proving is disabled, so these runs don't prove real-proof readiness.
- Browser smoke tests: `npm run smoke:* -w @ans/web` with `BASE=<vite url>`. They need a built SDK and a running dev server.
- Public testnet: only when the user asks. `npm run deploy:v6` (see docs/deploy-v6.md), `npm run test:testnet:v6` and the archived V5 runner `npm run test:testnet` broadcast with real proofs. State and keys live outside the repo in `~/.local/share/ans/<run>/`. Every tx hash is checkpointed before broadcast, and a re-run resumes from it instead of resending.

## Architecture

```text
contracts → artifacts (committed) → sdk → web, e2e, ops (monitor), examples/consumer
```

**Contracts** (`contracts/`):
- Registries: `name_registry` (V2), plus `name_registry_v3`, `_v4` and `_v5`, all kept for deployed instances on the Aztec 5.2.1 rollup (read-only archive) with frozen storage layouts. `name_registry_v6` is the core on the Aztec 6 testnet (`deployments/testnet-v6.json`).
- The V3+ registries delegate fees and records to replaceable modules: a **Registrar** (`name_registrar`, single price; `name_registrar_tiered`, length tiers and the stricter new-label rules) and a **Resolver** (`name_resolver`). The administrator swaps modules immediately with `configure_modules`, and names never migrate.
- A Registrar's fee policy is immutable, so a price change means deploying a new Registrar and switching to it.
- Shared hashing, label packing and lifecycle rules live in `ans_common`.

**Invariants** (see AGENTS.md):
- commit-reveal (60s–24h);
- exact private fee authwit bound to the Registrar;
- generation/revision checks on every holder write;
- bidirectional primary verification;
- registration commitments that bind the chain, registry, Registrar, name, owner, duration, token, treasury, priceVersion, max fee and quote expiry.

**SDK** (`sdk/src`), with three entry points: `.`, `./read` (wallet-free, no contract artifacts) and `./contracts/v6`.
- `core/registry-protocol.ts` and `artifacts/modular-metadata.json` pick the protocol and storage layout from the exact on-chain class ID.
- `RegistryReader` (`client/reader.ts`) reads raw storage slots at one snapshot. It rejects unknown registry or module classes with `wrong_deployment`, so supporting a new contract class always needs a new SDK release; older SDKs fail closed.
- `getFeeQuote` / `chargeFor` need `labelLength` on a tiered Registrar, and `flow.quote(duration, name)` derives it. A quote binds its length.
- `core/hash.ts`, `packing.ts` and `label.ts` mirror the Noir code. `vectors.nr` and `sdk/test/vectors.test.ts` pin the shared constants, so change both together.
- Registration (`transactions/registration-flow.ts`) persists encrypted plans before sending and recovers through `trackTx`. It never rebroadcasts unknown transactions, and clears a saved hash only when a receipt proves that transaction reverted or was dropped.

**Web** (`web/src`):
- `session.ts` holds the central store.
- `registration.ts` adapts encrypted account records into SDK plan storage.
- `docs-content.ts` and `docs-examples.ts` are the single source for the docs center, the Markdown exports and `llms-full.txt`. Prices come from `deployments/aztec-pricing.json` (target AZTEC pricing) and `deployments/testnet-v6.json` (live test deployment).

**Ops** (`ops/`) holds the Cloudflare site Worker and the per-minute monitor (D1). `ops/src/modular.ts` checks module classes against `modular-metadata.json`, so a new Registrar or Resolver class must be added there too, or the monitor flags it.

## Release

- `npm run deploy:testnet` builds the site from `deployments/testnet-v6.json` and deploys both Workers with wrangler. It refuses a dirty tree, untracked files included, and the release id is the short HEAD hash (`/health.txt`).
- `npm run check:deployment` keeps `ops/wrangler*.jsonc` vars in sync with the deployment manifest.
- When an on-chain module change needs new SDK support, publish the site and monitor first, then switch on chain. The live site's SDK must already recognize the new class.
- `.gitignore` keeps `docs/acceptance/`, `docs/history/`, `docs/archive/`, `docs/reviews/`, `docs/plans/` and dated docs files local; undated public guides remain trackable. Record each public change with its transaction hashes and an honest verification boundary.

The optional `name_registrar_launch` / `NameRegistrarLaunch` module supports fixed-year free or paid leases, live minimum/reservation/pause policy, a constructor renewal horizon (seconds, 0 = no cap), and live Registry administrator minting. Read policy through `RegistryReader`; use e2e launch admin tooling for administrator actions. Reserved-list parity must pass before a module switch. This module does not change testnet-v6.json or authorize public deployment.
