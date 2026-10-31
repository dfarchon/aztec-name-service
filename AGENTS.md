# ANS repository

This is one npm-workspace repository containing the Aztec contracts (`contracts/`), SDK (`sdk/`), web app (`web/`), Cloudflare site and monitor (`ops/`) and chain acceptance tests (`e2e/`).

## Product boundary

Public names and owners, with transfers, editor roles, subnames, public profile records and multi-chain address records. No private owner commitments or cross-chain asset transfers. Follow `README.md` for lease and authorization rules. Preserve commit-reveal, exact fee authorization, generation/revision checks and bidirectional primary verification.

## Toolchain and verification

- Pin the Aztec toolchain to exactly 6.0.0 (`.aztecrc`, checked by `scripts/aztec.mjs`). Aztec.nr dependencies use `git = "https://github.com/aztec-labs-eng/aztec-nr"`, `tag = "v6.0.0"`; never a branch or a floating tag. npm packages use exact `@aztec-labs/*` 6.0.0. Use `aztec compile` / `aztec test` through `scripts/aztec.mjs`, not bare nargo.
- Node >=24.12.0; `.nvmrc` selects Node 24. Use npm and commit package-lock.json.
- `npm ci`, `npm run check`, `npm test`, `npm run build` verify the TypeScript workspaces.
- Contract edits require `npm run build:contracts`, `npm run generate:sdk`, `npm run test:contracts`, then SDK checks. Commit the SDK artifact and generated TypeScript wrapper together. Check the Brillig diagnostic baseline with `npm run check:brillig`.
- Run `npm run test:e2e` against a local Aztec node when contract behavior or wallet flows change. Local tests with proving disabled do not establish real-proof or public-network readiness.
- TXE uses port 8081 in this toolchain; do not run a local node on 8081 concurrently with contract tests.
- Public testnet runs (`npm run test:testnet`, `npm run deploy:v6`) keep their network identity checks, real proving and private checkpoint directory outside the repository. Resume existing hashes instead of creating duplicate transactions.
- Root dependency overrides are validated for this workspace; they do not propagate to SDK consumers. Keep the consumer boundary in `docs/dependency-security.md` explicit.
- Record verification boundaries honestly; never present an old test total as a fresh run.

## Contracts and compatibility

- V6 (`name_registry_v6`) is the core on the Aztec 6 testnet, deployed fresh with a zero legacy address. V2–V5 deployments on the Aztec 5.2.1 rollup are a read-only archive; no names are migrated to Aztec 6.
- Administrators configure modules directly; a confirmed transaction takes effect immediately. Fees are immutable per Registrar: deploying a new Registrar and configuring it does not require holder migration. Implementation changes use a new Registry deployment.
- Preserve the V2–V6 sources and storage baselines (`contracts/*/storage-layout.json`). Never regenerate a baseline to make an incompatible layout pass; `sdk/scripts/validate-layout.mjs` must pass against the unchanged baselines.
- Class IDs must not change within one toolchain version; they may change only with a toolchain change. A toolchain change never changes storage slots, field order or packed encodings.
- Preserve commit age, exact payment authorization, ownership, generation/revision, editor restrictions, ancestor lifetime and primary consent checks.
- `scripts/sync-v4.mjs` maintains the historical V4 artifact from frozen V3 source and the extension include. Do not change legacy behavior while editing newer versions. Keep `v4_test_module` as a TXE-only fixture, outside SDK artifacts and public deployment.
- Changes to modules, fees or migration require `npm run test:modular`; extended name flows and administrator authority require `npm run test:extensions` on an isolated proof-disabled node. Run `npm run smoke:modular -w @ans/web` for browser controls; fixtures do not establish signing readiness.

## Data and delivery

Never commit .env files, wallet keys, registration secrets, deployment keys, local wallet stores or runtime logs. `.env.example` contains only placeholders. Local implementation work never implies a public-network deployment, fee-policy change, SDK publication or website publication.

## Developer integration standards

- Follow `docs/code-structure.md`: keep protocol/layout selection, holding permissions and registration recovery in their existing modules. Web registration uses the SDK flow with an encrypted storage adapter.
- Run `npm run format:integration` for SDK consumer examples and the documentation source; `npm run check:format` enforces the same pinned formatting rules in CI. This scope excludes generated contract artifacts and unrelated source.
- Keep English and Chinese onboarding rules aligned. Define API inputs, results, units and relevant errors; distinguish application memory, encrypted recovery data and chain state.
- Documentation TypeScript examples must be complete modules with declared inputs. `npm run test:consumer` compiles the exact examples against the independently installed SDK, without broadcasting transactions.
- Verify both wallet chain ID and rollup version before registering contracts, reading private balances, creating payment authorization or sending. Keep these operation checks inside the shared wallet queue. A validation failure before `send` must not set a registration plan's unknown-broadcast flag.
- Registration recovery clears a saved transaction hash only when a receipt proves that transaction reverted or was dropped. Callback, wallet and RPC exceptions never count as receipt evidence.
- Keep public display caching available through `@ans/sdk/read`, without ANS contract artifacts. Independent consumer checks must exercise compiled JavaScript in plain Node as well as TypeScript examples and browser builds.
- `npm run check:docs` checks bilingual fields, table columns, article links and matching README examples. The website and Markdown exports continue to use one content source.
