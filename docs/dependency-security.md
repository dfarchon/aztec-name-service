# Dependency security

CI runs `npm audit --audit-level=high`; any new high or critical advisory blocks the build. Advisory counts describe the npm dependency graph rather than confirmed exploitable paths, and "zero high advisories" is not a security audit.

## Root workspace overrides

| Dependency | Pinned version | Reason |
| --- | --- | --- |
| `ws` | 8.22.0 | Overrides an older exact transitive pin upstream |
| `systeminformation` | 5.33.16 | Mitigates command-injection advisories in system inspection (including [GHSA-3f7j-7jwc-fxfj](https://github.com/advisories/GHSA-3f7j-7jwc-fxfj)) |
| `@opentelemetry/propagator-jaeger` | 2.9.0 | Addresses the [Jaeger propagator advisory](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-45rx-2jwx-cxfr) while preserving other OpenTelemetry versions used by Aztec |
| `zod` 4.x | 4.6.7 | Deduplicates `zod` 4.x across the Aztec 6 dependency graph |

Transitive `follow-redirects` resolves to `1.16.2` in `package-lock.json`, addressing cross-origin redirect credential leaks ([GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8), [GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c), [GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p)).

## SDK consumer boundary

npm applies `overrides` only from the installing application's root `package.json`, and this workspace lockfile does not ship inside the `fog-sdk` tarball. Applications installing `fog-sdk` must evaluate and configure their own root `overrides`, then audit and test their resolved dependency graph.

## Public read hashing

Poseidon2 hashing for labels, commitments, and public storage slots uses the exact pinned [`@zkpassport/poseidon2@0.6.2`](https://github.com/zkpassport/poseidon2), allowing `fog-sdk/read` to resolve names without loading the Barretenberg proving runtime. Inputs are range-checked through Aztec `Fr`. `sdk/test/hash-compatibility.test.ts` cross-checks protocol domain separators, input lengths, field boundaries, and public map slots against the official Aztec implementation; this verifies output parity rather than auditing the library itself.
