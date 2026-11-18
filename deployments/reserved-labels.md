# Reserved labels: content policy v3

`reserved-labels.json` uses `fog-reserved-labels/1`. Categories are public review information; enforcement uses the union of their node keys. Every label is 7–31 ASCII characters, lowercase letters/digits/hyphens only, with no edge hyphen, `--`, `0x` prefix or dot. Short names are already closed to public registration and are excluded here. Categories and the flattened list must have no duplicates.

| Category | Scope |
| --- | --- |
| aztec | Aztec project, infrastructure and identity variants; original v1 categories retained |
| noir | S3 Noir projects, organizations and tooling; inclusion does not imply Aztec affiliation |
| fog | Service and dfarchon identity, administration and protocol labels |
| system | Administrative, support, security and impersonation-sensitive words |
| ecosystem | Major chain, exchange, wallet and infrastructure identities |
| corporate | Technology companies and explicitly sourced products |
| ai | AI companies and explicitly sourced assistants |
| payments | Payment company identity compounds |
| consumer | Consumer brands and identity compounds |

The loader accepts lowercase category names (`^[a-z][a-z0-9-]*$`), including `noir` and `fog`. The deployment loader rejects malformed files and duplicates before hashing. The canonical SHA-256 input is `JSON.stringify(sortedFlatLabels)`; category order and category keys do not affect it. Legacy arrays remain supported with the same validation. Reservation bits are seeded and verified before bootstrap. Administrator mint and renewal retain their existing authorization and bypass public reservations.

Propose changes by editing the categorized file with a rationale for each addition/removal, running loader and pinned-hash tests, and updating the deployment policy hash for review. A file edit does not change chain state; applying a reservation change requires the current administrator's explicit transaction.

Historical v1 ruling 7 added 22 labels (195 total at that time): hyphenated Aztec product and official/support/admin/team variants prevent impersonation; service names protect the protocol identity; airdrop/giveaway/rewards/staking/claim-airdrop and noreply/webmaster protect solicitation and sender identities; ethereumfoundation pairs with its existing hyphenated form. Look-alike spellings remain out of scope. Readiness requires this file's `minLength` to equal deployment `minPublicLength`.

## Content policy v2

Reviewed 2026-11-07 (Asia/Taipei). “v2” versions the content policy only; the file schema is `fog-reserved-labels/1`. All original 195 labels remain verbatim in their categories. There are 81 additions, 276 total; no removals. No new bare generic roots or look-alike spellings are added. `human-tech` refers to the listed Human Tech brand, not generic human phrases; `shield-support` is a deliberate support compound for the listed Shield identity. Neither asserts an official support service or allocates trademark rights. The six uncertain role compounds `nemi-finance`, `nyx-payments`, `xochi-bridge`, `shield-bridge`, `nyx-money`, `train-bridge` were skipped. Candidate duplicates are discarded (none in this bounded set).

Reservation prevents public registration; it is not endorsement, a safety audit, partnership, proof of ownership, or a trademark grant. Source listings establish identity spelling, not an official status for generated support/official variants. Noir ecosystem projects are not necessarily deployed on Aztec. Existing broad v1 reservations are retained for compatibility, not used to justify new generic reservations.

| Category | Retained | Added | Total |
| --- | ---: | ---: | ---: |
| aztec | 35 | 37 | 72 |
| fog | 24 | 0 | 24 |
| system | 57 | 0 | 57 |
| ecosystem | 79 | 24 | 103 |
| noir | 0 | 20 | 20 |
| Total | 195 | 81 | 276 |

### Sources and addition rationale

- S1: [Aztec apps](https://aztec.network/apps)
- S2: [Awesome Aztec (official organization)](https://github.com/AztecProtocol/awesome-aztec)
- S3: [Awesome Noir (official organization)](https://github.com/noir-lang/awesome-noir)
- S4: [Azguard Wallet](https://azguardwallet.io/)
- S5: [Nulo on Aztec](https://aztec.network/projects/nulo)
- S6: [Original v1 baseline (195 labels)](../e2e/src/fixtures/reserved-labels-v1.json)

The official-organization curated lists do not endorse or audit listed projects. S6 is the existing repository baseline, not independent verification of brand relationships. Each group below reserves the named identity and obvious compound identity variants to reduce impersonation.

- **S1 — Aztec directory identities (17)**: `dark-forest`, `dark-forest-aztec`, `darkforest`, `galactica`, `galactica-official`, `nemi-official`, `olla-official`, `ravenhouse`, `ravenhouse-official`, `rolling-chat`, `rollingchat`, `shield-support`, `xochi-official`, `zk-money`, `zkmoney`, `zkpassport`, `zkpassport-support`.
- **S2 — Aztec curated projects and resources (16)**: `aztec-examples`, `aztec-faucet`, `aztec-governance`, `aztec-nodes`, `aztec-staking`, `aztec-standards`, `aztec-starter`, `aztec-vision`, `clustec`, `dashtec`, `gregoswap`, `human-tech`, `olla-finance`, `primus-labs`, `primuslabs`, `warptoad`.
- **S3 — Noir projects and tooling (20)**: `anoncast`, `barretenberg`, `codetracer`, `cosnarks`, `interfold`, `kalypso`, `megahonk`, `noir-codegen`, `noir-debugger`, `noir-docs`, `noir-libraries`, `noir-official`, `noir-stdlib`, `noir-support`, `provekit`, `reilabs`, `taceo-labs`, `ultrahonk`, `zk-email`, `zkproofport`.
- **S4 — Azguard wallet identity (4)**: `azguard`, `azguard-official`, `azguard-support`, `azguard-wallet`.
- **S5 — Nulo wallet identity (2)**: `nulo-support`, `nulo-wallet`.
- **S6 — Existing brand impersonation variants (22)**: `binance-official`, `binance-support`, `coinbase-official`, `coinbase-support`, `kraken-official`, `kraken-support`, `ledger-official`, `ledger-support`, `metamask-official`, `metamask-support`, `okx-support`, `phantom-support`, `phantom-wallet`, `rabby-official`, `rabby-support`, `trezor-official`, `trezor-support`, `trust-wallet-support`, `trustwallet`, `uniswap-official`, `uniswap-support`, `walletconnect-support`.

The following map names the source entry behind every addition. Normalization and deliberate anti-impersonation compounds need not be an official exact legal brand or service name. S1/S2/S3 are directory provenance, not affiliation categories: the bare `darkforest` / `dark-forest` forms belong to `ecosystem`; `dark-forest-aztec` stays in `aztec`. All 20 S3 labels belong to `noir`, including Aztec-maintained tooling. Original v1 Noir labels stay in their original `aztec` category.

| Source | Exact entry or component | Reserved variants |
| --- | --- | --- |
| S1 | Nemi | `nemi-official` |
| S1 | Olla | `olla-official` |
| S1 | Xochi | `xochi-official` |
| S1 | Shield | `shield-support` |
| S1 | RavenHouse | `ravenhouse`, `ravenhouse-official` |
| S1 | Dark Forest Aztec | `dark-forest-aztec`; `darkforest`, `dark-forest` are bare game-identity variants without an Aztec affiliation claim |
| S1 | Galactica | `galactica`, `galactica-official` |
| S1 | RollingChat | `rollingchat`, `rolling-chat` |
| S1 | zk.money | `zk-money`, `zkmoney` |
| S1 | ZKPassport | `zkpassport`, `zkpassport-support` |
| S2 | Olla Finance (Projects) | `olla-finance` |
| S2 | Human Tech (Projects) | `human-tech` |
| S2 | Warptoad (Projects) | `warptoad` |
| S2 | Primus Labs (Projects) | `primus-labs`, `primuslabs` |
| S2 | GregoSwap (Projects, Aztec Swap standalone example) | `gregoswap` |
| S2 | Dashtec; Clustec; Aztec Vision; Aztec Nodes (Explorers) | `dashtec`, `clustec`, `aztec-vision`, `aztec-nodes`, respectively |
| S2 | Aztec Governance Dashboard (Dashboards); Aztec Staking Dashboard (Explorers) | `aztec-governance`, `aztec-staking`, respectively |
| S2 | Aztec Faucet (Faucet, Nethermind testnet faucet) | `aztec-faucet` |
| S2 | Aztec Examples Repo (Coding / Examples) | `aztec-examples` |
| S2 | Aztec Starter (Official Resources / Boilerplates) | `aztec-starter` |
| S2 | Aztec Standards (Coding / Examples) | `aztec-standards` |
| S3 | anoncast (Social); Interfold (Infrastructure) | `anoncast`, `interfold`, respectively |
| S3 | ZKProofport; ZK Email (SDK) | `zkproofport`, `zk-email`, respectively |
| S3 | CodeTracer (Linting & debugging) | `codetracer` |
| S3 | coSNARKs; Kalypso (Private Shared States) | `cosnarks`, `kalypso`, respectively |
| S3 | Barretenberg (UltraHonk / MegaHonk), Proving Backends | `barretenberg`, `ultrahonk`, `megahonk` |
| S3 | ProveKit (Spartan + WHIR), Proving Backends | `provekit` |
| S3 | Reilabs (Lampe / Sunspot attribution); Taceo Labs (coSNARKs attribution) | `reilabs`, `taceo-labs`, respectively |
| S3 | Resources: [Docs](https://noir-lang.org/docs/), Noir identity | `noir-docs`, `noir-official`, `noir-support`; the latter two are deliberate impersonation compounds |
| S3 | Libraries section; General: [Standard Library](https://github.com/noir-lang/noir/tree/master/noir_stdlib), [stdlib documentation](https://noir-lang.org/docs/libraries/standard_library/black_box_fns) | `noir-libraries`, `noir-stdlib` |
| S3 | Linting & debugging: [VS Code Debugger](https://noir-lang.org/docs/tooling/debugger) | `noir-debugger` |
| S3 | Browser development: [Noir Codegen for TypeScript](https://noir-lang.org/docs/tooling/noir_codegen) | `noir-codegen` |
| S4 | Azguard Wallet | `azguard`, `azguard-wallet`, `azguard-support`, `azguard-official` |
| S5 | Nulo (wallet) | `nulo-wallet`, `nulo-support` |
| S6 | Existing MetaMask, Coinbase, Binance, Kraken, Uniswap, Ledger, Rabby and Trezor baseline identities | Each corresponding `-official` and `-support` variant above |
| S6 | Existing Phantom; Trust Wallet; WalletConnect; OKX baseline identities | `phantom-support`, `phantom-wallet`; `trustwallet`, `trust-wallet-support`; `walletconnect-support`; `okx-support` |

### Canonical data and seeding budget

Historical v2 SHA-256: `b6d4e77d1cdc119abfec4f0060fd7235463e8ed7d85ce5e8b3e07c8bea42b147`. The v2 fixture retains this hash; this is a template update, not a chain change. The regression fixture pins the prior 195-label hash and checks each original category and label.

At 32 nodes per seed transaction, the full list needs `ceil(276/32) = 9` batches, previously `ceil(195/32) = 7`: two additional transactions (+28.6% by batch count). The last batch has 20 labels and 12 zero-padding slots. If a seed batch costs C, the planning change is 7C → 9C (+2C); no linear per-label gas claim is made. Using the rehearsal's unmeasured 1.98 FJ per-call allocation solely as a budget proxy gives 13.86 → 17.82 FJ (+3.96 FJ). This is not a simulation, real fee quote, measured seed cost, or guaranteed bound. Deployment, failed transactions, account setup and funding need their own allowances. The existing one-label rehearsal remains a fixture; see [rehearsal planning](../docs/launch-rehearsal.md).

## Content policy v3

Official pages listed below were checked on 2026-11-07 (Asia/Taipei). The loader accepts the four lowercase categories under schema `fog-reserved-labels/1`. All 276 v2 labels and their category arrays remain exact; 49 bounded additions give 325 labels. The v1 fixture and all prior exclusions remain. No duplicate candidates or uncertain product-parent relationships were accepted.

These sources establish brand identity and the stated product relationships. Support/official compounds are **our anti-impersonation policy**, not evidence that a company uses that exact label or provides that service. Reservation asserts no endorsement, ownership, partnership, contact channel or trademark right. “Legal label” means syntax validation only, not legal review. Public minimum length stays 7; no short bare brands, broad generic roots or look-alike spellings are added. `mcdonalds` explicitly omits the brand's apostrophe for ASCII normalization. Bare `windows`, `android`, `stripe` and `visa` are not added. Mastercard was omitted because its official pages could not be retrieved; other unresearched brands remain outside this bounded set.

| Category | Retained v2 | Added | Total |
| --- | ---: | ---: | ---: |
| aztec | 72 | 0 | 72 |
| fog | 24 | 0 | 24 |
| system | 57 | 0 | 57 |
| ecosystem | 103 | 0 | 103 |
| noir | 20 | 0 | 20 |
| corporate | 0 | 27 | 27 |
| ai | 0 | 7 | 7 |
| payments | 0 | 6 | 6 |
| consumer | 0 | 9 | 9 |
| Total | 276 | 49 | 325 |

### Official source mapping

Every new label is mapped below; product names in the identity column are explicitly present in the official pages listed.

| Source | Identity | Category | Labels |
| --- | --- | --- | --- |
| [C1](https://www.apple.com/wallet/) | Apple, Apple Wallet, Apple Pay | corporate | `apple-support`, `apple-official`, `apple-wallet`, `apple-pay` |
| [C2](https://about.google/products/) | Google, Google Wallet, YouTube, Android | corporate | `google-support`, `google-official`, `google-wallet`, `youtube`, `youtube-support`, `android-support` |
| [C3](https://www.microsoft.com/en-us/about) | Microsoft | corporate | `microsoft`, `microsoft-support` |
| [C4](https://www.microsoft.com/en-us/windows/) | Microsoft Windows | corporate | `microsoft-windows`, `windows-support` |
| [C5](https://www.aboutamazon.com/what-we-do) | Amazon, Amazon Web Services, Prime Video | corporate | `amazon-support`, `amazon-official`, `amazon-web-services`, `prime-video` |
| [C6](https://about.meta.com/technologies/) | Meta | corporate | `meta-support`, `meta-official` |
| [C7](https://www.nvidia.com/en-us/about-nvidia/) | NVIDIA | corporate | `nvidia-support`, `nvidia-official` |
| [C8](https://www.samsung.com/us/about-us/our-business/) | Samsung | corporate | `samsung`, `samsung-support` |
| [C9](https://www.sony.com/en/SonyInfo/CorporateInfo/) | Sony, PlayStation | corporate | `sony-support`, `playstation`, `playstation-support` |
| [C10](https://openai.com/) | OpenAI, ChatGPT | ai | `openai-support`, `openai-official`, `chatgpt`, `chatgpt-support` |
| [C11](https://www.anthropic.com/company) | Anthropic, Claude | ai | `anthropic`, `anthropic-support`, `claude-support` |
| [C12](https://www.paypal.com/us/webapps/mpp/about) | PayPal | payments | `paypal-support`, `paypal-official` |
| [C13](https://stripe.com/about) | Stripe | payments | `stripe-support`, `stripe-official` |
| [C14](https://www.visa.com/about-visa.html) | Visa | payments | `visa-support`, `visa-official` |
| [C15](https://about.nike.com/) | Nike | consumer | `nike-official` |
| [C16](https://www.coca-colacompany.com/brands) | Coca-Cola | consumer | `coca-cola`, `coca-cola-official` |
| [C17](https://www.starbucks.com/about-us/) | Starbucks | consumer | `starbucks`, `starbucks-official` |
| [C18](https://corporate.mcdonalds.com/) | McDonald’s | consumer | `mcdonalds`, `mcdonalds-official` |
| [C19](https://corporate.walmart.com/about) | Walmart | consumer | `walmart`, `walmart-support` |

### Current hash and planning

Canonical SHA-256: `743b1b4c3ab4762cb2d12662765406fdf91971845a5ec6137b1f7444223657fa`. Only `reservedListHash` changes in the mainnet template; `minPublicLength` remains 7. The immutable v2 fixture pins `b6d4e77d1cdc119abfec4f0060fd7235463e8ed7d85ce5e8b3e07c8bea42b147` and exact category arrays; the v1 fixture remains unchanged.

Batch size remains 32: v2 `ceil(276/32)=9`, v3 `ceil(325/32)=11`, two extra transactions (+22.2%). The final batch has 5 labels and 27 zero slots. For cost C per batch, 9C → 11C (+2C). The provisional, unmeasured 1.98 FJ allowance gives seed budgets 17.82 → 21.78 FJ (+3.96). Full-list rehearsal planning totals are 55.58 → 59.54 FJ, with recommended allowances 84 → 90 FJ. The one-label fixture remains 39.74 FJ / recommended 60. These are planning allowances, not measured fees, simulations, quotes or guaranteed bounds. Failed transactions, account setup, deployment and funding need their own allowances; no FJ-to-ETH conversion is made. See [rehearsal planning](../docs/launch-rehearsal.md).
