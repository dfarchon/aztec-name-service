# Reserved labels: content policy v2 / 保留名单：内容策略 v2

`reserved-labels.json` uses `ans-reserved-labels/1`. Categories are public review information; enforcement uses the union of their node keys. Every label is 7–31 ASCII characters, lowercase letters/digits/hyphens only, with no edge hyphen, `--`, `0x` prefix or dot. Short names are already closed to public registration and are excluded here. Categories and the flattened list must have no duplicates.

| Category / 分类 | Scope / 范围 |
| --- | --- |
| aztec | Aztec project, infrastructure and identity variants; original v1 categories retained / Aztec 项目、基础设施及身份变体；保留 v1 原分类 |
| noir | New S3 Noir projects, organizations and tooling; inclusion does not imply Aztec affiliation / 新增 S3 Noir 项目、组织和工具，不表示与 Aztec 有隶属关系 |
| ans | ANS and dfarchon identity, administration and service labels / ANS、dfarchon 身份及管理、服务名称 |
| system | Administrative, support, security and impersonation-sensitive words / 管理、客服、安全及易被冒用的身份词 |
| ecosystem | Major chain, exchange, wallet and infrastructure identities / 主要链、交易所、钱包及基础设施身份 |

The existing loader accepts lowercase category names (`^[a-z][a-z0-9-]*$`), including `noir`, without a schema change. The deployment loader rejects malformed files and duplicates before hashing. The canonical SHA-256 input is `JSON.stringify(sortedFlatLabels)`; category order does not affect it. Legacy arrays remain supported with the same validation. Reservation bits are seeded and verified before bootstrap. Administrator mint and renewal retain their existing authorization and bypass public reservations.

部署加载器先校验标签和跨分类重复，再计算规范哈希：对排序后的扁平数组执行 `JSON.stringify`，然后 SHA-256；分类顺序不影响结果。旧数组格式继续支持，并接受同样校验。bootstrap 前必须写入并核验保留状态。管理员铸造和持有人续期继续使用原有权限，不受公开保留规则限制。

Propose changes by editing the categorized file with a rationale for each addition/removal, running loader and pinned-hash tests, and updating the deployment policy hash for review. A file edit does not change chain state; applying a reservation change requires the current administrator's explicit transaction.

变更时在对应分类中编辑，并逐项说明增删理由；运行加载器和哈希测试，更新部署策略哈希后提交审阅。修改文件不会自动修改链上状态；生效需要当前管理员明确发送交易。

Historical v1 ruling 7 added 22 labels (195 total at that time): hyphenated Aztec product and official/support/admin/team variants prevent impersonation; ANS service names protect the service identity; airdrop/giveaway/rewards/staking/claim-airdrop and noreply/webmaster protect solicitation and sender identities; ethereumfoundation pairs with its existing hyphenated form. Look-alike spellings remain out of scope. Readiness requires this file's minLength to equal deployment minPublicLength.

历史 v1 裁定7补充22项（当时合计195）：Aztec 产品连字符与官方、客服、管理、团队变体防止身份冒用；ANS 服务名称保护服务身份；空投、奖励、质押、领取与发件人身份词减少钓鱼冒用；ethereumfoundation 补齐现有连字符形式。近似拼写不在本次范围。就绪检查要求本文件 minLength 等于部署 minPublicLength。


## Content policy v2 / 内容策略 v2

Reviewed 2026-11-07 (Asia/Taipei). “v2” versions the content policy only; the file schema stays `ans-reserved-labels/1` and the loader is unchanged. All original 195 labels remain verbatim in their original categories. There are 81 additions, 276 total; no removals. No new bare generic roots or look-alike spellings are added. `human-tech` refers to the listed Human Tech brand, not generic human phrases; `shield-support` is a deliberate support compound for the listed Shield identity. Neither asserts an official support service or allocates trademark rights. The six uncertain role compounds `nemi-finance`, `nyx-payments`, `xochi-bridge`, `shield-bridge`, `nyx-money`, `train-bridge` were skipped. Candidate duplicates are discarded (none in this bounded set).

复核日期为 2026-11-07（Asia/Taipei）。“v2”仅指内容策略版本，文件 schema 保持 `ans-reserved-labels/1`，加载器不变。原有195项及其分类全部原样保留，新增81项，共276项，无删除。不新增裸通用词或近似拼写；`human-tech` 对应目录中的 Human Tech 品牌，不泛指 human 类词组；`shield-support` 是针对 Shield 身份构造的明显客服组合词，不表示官方客服服务，也不分配商标权；上述六个角色含义不确定的候选已跳过，候选重复项会丢弃（本次无重复）。

Reservation prevents public registration; it is not endorsement, a safety audit, partnership, proof of ownership, or a trademark grant. Source listings establish identity spelling, not an official status for generated support/official variants. Noir ecosystem projects are not necessarily deployed on Aztec. Existing broad v1 reservations are retained for compatibility, not used to justify new generic reservations.

保留仅限制公开注册，不表示背书、安全审计、合作关系、所有权证明或商标授权。来源用于核对身份拼写，不能证明所构造的 support/official 变体为官方服务。Noir 生态项目不等于已部署在 Aztec。原有宽泛 v1 保留词按兼容要求保留，不作为新增通用词的理由。

| Category / 分类 | Retained / 保留 | Added / 新增 | Total / 合计 |
| --- | ---: | ---: | ---: |
| aztec | 35 | 37 | 72 |
| ans | 24 | 0 | 24 |
| system | 57 | 0 | 57 |
| ecosystem | 79 | 24 | 103 |
| noir | 0 | 20 | 20 |
| Total / 总计 | 195 | 81 | 276 |

### Sources and addition rationale / 来源及新增理由

- S1: [Aztec apps](https://aztec.network/apps)
- S2: [Awesome Aztec (official organization)](https://github.com/AztecProtocol/awesome-aztec)
- S3: [Awesome Noir (official organization)](https://github.com/noir-lang/awesome-noir)
- S4: [Azguard Wallet](https://azguardwallet.io/)
- S5: [Nulo on Aztec](https://aztec.network/projects/nulo)
- S6: [Original v1 baseline (195 labels)](../e2e/src/fixtures/reserved-labels-v1.json)

The official-organization curated lists do not endorse or audit listed projects. S6 is the existing repository baseline, not independent verification of brand relationships. Each group below reserves the named identity and obvious compound identity variants to reduce impersonation.

官方组织维护的目录不背书或审计其中项目。S6 是仓库已有基线，不是品牌关系的独立证明。以下分组用于保护对应身份及明显的组合身份变体，减少冒用。

- **S1 — Aztec directory identities / Aztec 目录身份 (17)**: `dark-forest`, `dark-forest-aztec`, `darkforest`, `galactica`, `galactica-official`, `nemi-official`, `olla-official`, `ravenhouse`, `ravenhouse-official`, `rolling-chat`, `rollingchat`, `shield-support`, `xochi-official`, `zk-money`, `zkmoney`, `zkpassport`, `zkpassport-support`.
- **S2 — Aztec curated projects and resources / Aztec 项目与资源 (16)**: `aztec-examples`, `aztec-faucet`, `aztec-governance`, `aztec-nodes`, `aztec-staking`, `aztec-standards`, `aztec-starter`, `aztec-vision`, `clustec`, `dashtec`, `gregoswap`, `human-tech`, `olla-finance`, `primus-labs`, `primuslabs`, `warptoad`.
- **S3 — Noir projects and tooling / Noir 项目与工具 (20)**: `anoncast`, `barretenberg`, `codetracer`, `cosnarks`, `interfold`, `kalypso`, `megahonk`, `noir-codegen`, `noir-debugger`, `noir-docs`, `noir-libraries`, `noir-official`, `noir-stdlib`, `noir-support`, `provekit`, `reilabs`, `taceo-labs`, `ultrahonk`, `zk-email`, `zkproofport`.
- **S4 — Azguard wallet identity / Azguard 钱包身份 (4)**: `azguard`, `azguard-official`, `azguard-support`, `azguard-wallet`.
- **S5 — Nulo wallet identity / Nulo 钱包身份 (2)**: `nulo-support`, `nulo-wallet`.
- **S6 — Existing brand impersonation variants / 已有品牌防冒用变体 (22)**: `binance-official`, `binance-support`, `coinbase-official`, `coinbase-support`, `kraken-official`, `kraken-support`, `ledger-official`, `ledger-support`, `metamask-official`, `metamask-support`, `okx-support`, `phantom-support`, `phantom-wallet`, `rabby-official`, `rabby-support`, `trezor-official`, `trezor-support`, `trust-wallet-support`, `trustwallet`, `uniswap-official`, `uniswap-support`, `walletconnect-support`.

The following map names the source entry behind every addition. Normalization and deliberate anti-impersonation compounds need not be an official exact legal brand or service name. S1/S2/S3 are directory provenance, not affiliation categories: the new bare `darkforest` / `dark-forest` forms belong to `ecosystem`; `dark-forest-aztec` stays in `aztec`. All 20 new S3 labels belong to `noir`, including Aztec-maintained tooling. Original v1 Noir labels stay in their original `aztec` category.

下表逐项对应来源条目。规范化拼写和为防冒用构造的组合词不要求是官方法定品牌全称或服务名称。S1/S2/S3 表示来源，不表示隶属分类：新增 Dark Forest 裸形式归入 ecosystem，dark-forest-aztec 留在 aztec；全部20个新增 S3 标签归入 noir，包括 Aztec 维护的工具；v1 原有 Noir 标签及原分类不变。

| Source / 来源 | Exact entry or component / 具体条目或组件 | Reserved variants / 保留变体 |
| --- | --- | --- |
| S1 | Nemi | `nemi-official` |
| S1 | Olla | `olla-official` |
| S1 | Xochi | `xochi-official` |
| S1 | Shield | `shield-support` |
| S1 | RavenHouse | `ravenhouse`, `ravenhouse-official` |
| S1 | Dark Forest Aztec | `dark-forest-aztec`; `darkforest`, `dark-forest` are bare game-identity variants, without an Aztec affiliation claim / 裸游戏身份变体，不主张 Aztec 隶属关系 |
| S1 | Galactica | `galactica`, `galactica-official` |
| S1 | RollingChat | `rollingchat`, `rolling-chat` |
| S1 | zk.money | `zk-money`, `zkmoney` |
| S1 | ZKPassport | `zkpassport`, `zkpassport-support` |
| S2 | Olla Finance (Projects) | `olla-finance` |
| S2 | Human Tech (Projects) | `human-tech` |
| S2 | Warptoad (Projects) | `warptoad` |
| S2 | Primus Labs (Projects) | `primus-labs`, `primuslabs` |
| S2 | GregoSwap (Projects, Aztec Swap standalone example) | `gregoswap` |
| S2 | Dashtec; Clustec; Aztec Vision; Aztec Nodes (Explorers) | `dashtec`, `clustec`, `aztec-vision`, `aztec-nodes`, respectively / 依次对应 |
| S2 | Aztec Governance Dashboard (Dashboards); Aztec Staking Dashboard (Explorers) | `aztec-governance`, `aztec-staking`, respectively / 依次对应 |
| S2 | Aztec Faucet (Faucet, Nethermind testnet faucet) | `aztec-faucet` |
| S2 | Aztec Examples Repo (Coding / Examples) | `aztec-examples` |
| S2 | Aztec Starter (Official Resources / Boilerplates) | `aztec-starter` |
| S2 | Aztec Standards (Coding / Examples) | `aztec-standards` |
| S3 | anoncast (Social); Interfold (Infrastructure) | `anoncast`, `interfold`, respectively / 依次对应 |
| S3 | ZKProofport; ZK Email (SDK) | `zkproofport`, `zk-email`, respectively / 依次对应 |
| S3 | CodeTracer (Linting & debugging) | `codetracer` |
| S3 | coSNARKs; Kalypso (Private Shared States) | `cosnarks`, `kalypso`, respectively / 依次对应 |
| S3 | Barretenberg (UltraHonk / MegaHonk), Proving Backends | `barretenberg`, `ultrahonk`, `megahonk` |
| S3 | ProveKit (Spartan + WHIR), Proving Backends | `provekit` |
| S3 | Reilabs (Lampe / Sunspot attribution); Taceo Labs (coSNARKs attribution) | `reilabs`, `taceo-labs`, respectively / 依次对应 |
| S3 | Resources: [Docs](https://noir-lang.org/docs/), Noir identity | `noir-docs`, `noir-official`, `noir-support`; the latter two are deliberate impersonation compounds / 后两项是防冒用组合词 |
| S3 | Libraries section; General: [Standard Library](https://github.com/noir-lang/noir/tree/master/noir_stdlib), [stdlib documentation](https://noir-lang.org/docs/libraries/standard_library/black_box_fns) | `noir-libraries`, `noir-stdlib` |
| S3 | Linting & debugging: [VS Code Debugger](https://noir-lang.org/docs/tooling/debugger) | `noir-debugger` |
| S3 | Browser development: [Noir Codegen for TypeScript](https://noir-lang.org/docs/tooling/noir_codegen) | `noir-codegen` |
| S4 | Azguard Wallet | `azguard`, `azguard-wallet`, `azguard-support`, `azguard-official` |
| S5 | Nulo (wallet) | `nulo-wallet`, `nulo-support` |
| S6 | Existing MetaMask, Coinbase, Binance, Kraken, Uniswap, Ledger, Rabby and Trezor baseline identities | Each corresponding `-official` and `-support` variant above / 对应上述官方及客服组合词 |
| S6 | Existing Phantom; Trust Wallet; WalletConnect; OKX baseline identities | `phantom-support`, `phantom-wallet`; `trustwallet`, `trust-wallet-support`; `walletconnect-support`; `okx-support` |

### Canonical data and seeding budget / 规范数据与写入预算

Canonical SHA-256: `b6d4e77d1cdc119abfec4f0060fd7235463e8ed7d85ce5e8b3e07c8bea42b147`. The pinned `mainnet.template.json` uses this hash; this is a template update, not a chain change. The regression fixture pins the prior 195-label hash and checks each original category and label.

规范 SHA-256 如上，`mainnet.template.json` 固定此哈希；仅更新模板，不改变链上状态。回归夹具固定原195项哈希并逐一检查原分类及标签。

At 32 nodes per seed transaction, the full list needs `ceil(276/32) = 9` batches, previously `ceil(195/32) = 7`: two additional transactions (+28.6% by batch count). The last batch has 20 labels and 12 zero-padding slots. If a seed batch costs C, the planning change is 7C → 9C (+2C); no linear per-label gas claim is made. Using the rehearsal's unmeasured 1.98 FJ per-call allocation solely as a budget proxy gives 13.86 → 17.82 FJ (+3.96 FJ). This is not a simulation, real fee quote, measured seed cost, or guaranteed bound. Deployment, failed transactions, account setup and funding need their own allowances. The existing one-label rehearsal remains a fixture; see [rehearsal planning](../docs/launch-rehearsal.md).

每批32个 node，完整名单需要9批，原来7批，增加2笔交易（批次数增加28.6%）；末批20项，补12个零值。若每批成本为 C，预算从7C增至9C，增加2C，不推断逐标签 gas 线性关系。仅用演练中未实测的每次调用1.98 FJ作为预算占位，保留写入分配从13.86增至17.82 FJ，增加3.96 FJ；这不是模拟、实时费用报价、实测写入成本或保证上界。部署、失败交易、账户准备及资金另计。单标签演练仍为夹具。
