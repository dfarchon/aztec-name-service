# Aztec 6 deployment rehearsal / Aztec 6 部署演练

This runner deploys a fresh V6 registry with zero legacy, a resolver, a flat or tiered registrar, and a new 18-decimal mAZTEC test token. It does not migrate or reserve names. Historical V2–V5 runners and Workers keep their existing configuration.

此脚本新建 legacy 为零地址的 V6 Registry、Resolver、flat 或 tiered Registrar，以及 18 位精度的 mAZTEC 测试 Token。不迁移或保留旧名称。历史 V2–V5 脚本和 Worker 配置保持原行为。

## Local / 本地

Use Aztec 6.0.0 and a proof-disabled chain on 127.0.0.1:8080 (chain ID 31337). All services must bind to 127.0.0.1; stop them after the rehearsal. Do not run TXE contract tests concurrently with the local chain.

使用 Aztec 6.0.0、本地关闭证明的链（127.0.0.1:8080，chain ID 31337）。所有服务仅监听 127.0.0.1，用完关闭。本地链与 TXE 合约测试串行运行。

Local SponsoredFPC may be derived and registered with the wallet before publication; its class must match the official SponsoredFPC artifact. If published, its address and class are also checked. Public testnet preflight requires publication.

本地 SponsoredFPC 可在发布前推导并注册到钱包，class 必须匹配官方 SponsoredFPC artifact；链上已发布时还会核对地址和 class。公网 testnet 预检必须确认已发布。

The local acceptance runner advances blocks with unrelated commits before checking commitment maturity. Both flat and tiered renewals use SDK `renew(ctx, { name, duration })`, with exact user debit, treasury credit and expiry checks. The SDK selects renewal arguments from the registrar kind recognised by class ID in the same decision that registers its artifact.

本地验收脚本用无关 commit 推进区块，再检查承诺成熟时间。flat 和 tiered 续租统一使用 SDK `renew(ctx, { name, duration })`，核对用户精确扣款、财库入账和到期时间。SDK 按 class ID 识别出的 Registrar 类型选择续租参数，并在同一次判断中注册相应 artifact。

```sh
npm run deploy:v6 -- --network local --registrar flat --price-version 1 --state-dir /tmp/ans-v6-flat
npm run deploy:v6 -- --network local --registrar tiered --price-version 1 --state-dir /tmp/ans-v6-tiered
ANS_V6_MANIFEST=/tmp/ans-v6-flat/deployment-v6.json ANS_V6_STATE_DIR=/tmp/ans-v6-flat npm run test:e2e:v6-manifest
ANS_V6_MANIFEST=/tmp/ans-v6-tiered/deployment-v6.json ANS_V6_STATE_DIR=/tmp/ans-v6-tiered npm run test:e2e:v6-manifest
npm run check:deployment -- --v6-manifest /tmp/ans-v6-tiered/deployment-v6.json
```

`--network`, `--registrar flat|tiered`, and `--price-version` are required. The price version is a positive u32 integer without a default. Prices are integer token base units from `deployments/aztec-pricing.json`; 10^18 units = 1 mAZTEC. Tiered uses the 3- and 4-character annual prices; longer labels use annualPrice. `annualPriceStatus=provisional` produces a warning without changing prices. The official Token artifact is the default; `--token repo` selects the frozen repository test_token artifact. `--token-name` and `--token-symbol` default to mAZTEC; decimals are fixed at 18. Without a keys file, local treasury defaults to the new owner. With a keys file, treasury defaults to its separate treasury account. Local manifest acceptance restores that account from the same state directory to verify exact private treasury credits, as well as user debits.

必须显式传 `--network`、`--registrar flat|tiered`、`--price-version`。priceVersion 是无默认值的正 u32 整数。价格读取定价文件，以最小 Token 单位计，10^18 单位等于 1 mAZTEC。tiered 使用 3/4 字符年费，长名称使用 annualPrice。provisional 状态仅警告，不改变费率。默认官方 Token，`--token repo` 选择仓库冻结的 test_token。名称和符号默认 mAZTEC，精度固定 18。无 keys 文件时，本地 treasury 默认新 owner；有 keys 文件时默认使用其中的独立财库账户。本地清单验收从同一 state 目录恢复财库账户，继续核对精确私有入账和用户扣款。

## Offline keys / 离线密钥

```sh
npm run deploy:v6 -- --init-keys --network local --state-dir /tmp/ans-v6-keyed
npm run deploy:v6 -- --network local --registrar tiered --price-version 1 --state-dir /tmp/ans-v6-keyed --dry-run
npm run deploy:v6 -- --network local --registrar tiered --price-version 1 --state-dir /tmp/ans-v6-keyed
ANS_V6_MANIFEST=/tmp/ans-v6-keyed/deployment-v6.json ANS_V6_STATE_DIR=/tmp/ans-v6-keyed npm run test:e2e:v6-manifest
```

`--init-keys` accepts only `--network local|testnet-v6` and optional `--state-dir`. It is offline: no node, wallet, confirmation or treasury input is needed. It generates separate owner and treasury Schnorr accounts and four deployment salts in `keys.json` (`ans-v6-keys/1`). Output contains only network, path, public owner/treasury addresses and an offline backup reminder. Existing keys, state, lock, temporary files or dangling links cause refusal before generation; an existing directory must already be private and owned by the current user. New directories use 0700 and the file uses 0600. Repository paths, legacy V2–V5 directories and the other network's default directory are rejected, including resolved symlink paths.

`--init-keys` 只接受 `--network local|testnet-v6` 和可选的 `--state-dir`。它纯离线，不需要节点、钱包、确认串或财库参数；生成独立 owner、treasury Schnorr 账户及四个部署 salt，保存在 `keys.json`（`ans-v6-keys/1`）。输出仅含网络、路径、公开 owner/treasury 地址和离线备份提醒。密钥、state、锁、临时文件或悬空链接已存在时，在生成前拒绝；已有目录必须属于当前用户且权限私有。新目录 0700、文件 0600。仓库路径、旧版 V2–V5 目录和另一个网络的默认目录均禁止，包括解析符号链接后的路径。

Deployment takes treasury from the keys file; an explicit differing `--treasury` fails before network access. A new testnet deployment requires keys; existing checkpoints without keys remain resumable. Local deployment without keys retains random owner generation. Keys and checkpoint owner fields, salts, owner address and treasury must agree before wallet creation (`Checkpoint keys file mismatch` on drift). Keep `keys.json` for recovery and back it up offline. Owner private values also remain in `state.json` under the unchanged checkpoint schema. Treasury is an initializerless Schnorr address that can receive payments before deployment; losing its keys prevents spending. Do not print either private file.

部署默认从 keys 文件取财库；显式 `--treasury` 不一致时，在网络访问前报错。testnet 新部署必须有 keys；没有 keys 的旧检查点仍可续跑。local 无 keys 时保留随机生成 owner 的行为。创建钱包前校验 keys 和检查点中的 owner 私值、部署 salt、owner 地址及财库一致，否则报 `Checkpoint keys file mismatch`。保留并离线备份 `keys.json`；现有检查点 schema 不变，owner 私值也保存在 `state.json`。财库是可在部署前收款的 initializerless Schnorr 地址，密钥丢失后无法花费。禁止打印两个私有文件。

## Read-only public preflight / 公网只读预检

```sh
npm run deploy:v6 -- --network testnet-v6 --registrar tiered --price-version 1 --treasury 0x0000000000000000000000000000000000000000000000000000000000000001 --state-dir /tmp/ans-v6-public-dryrun --dry-run
```

The treasury above is a placeholder and priceVersion=1 is a rehearsal input; choose both deliberately for a real deployment. A dry run sends no transaction.

上例 treasury 只是占位地址，priceVersion=1 只是演练输入，正式部署须明确选择两者。dry-run 不发送交易。

The default RPC is https://aztec-testnet.drpc.org. A node URL override still requires exact identity: nodeVersion 6.0.0, chainId 11155111, rollupVersion 679261766, rollup 0x1f435a7f2da358caf887a470faeee7d5d5f4efba and realProofs=true. SponsoredFPC must exist and match the derived class/address. Identity rejection occurs before wallet/PXE/state creation. Dry runs call only getNodeInfo/getContract, print the methods used, and generate no keys or salts. Without a keys file, owner/deployer and dependent contract addresses are shown as "pending: derived after formal local key generation". With a keys file, dry-run uses its public address/salt projection to predict all six owner, treasury and contract addresses, and prints no private values. Class IDs, network identity, SponsoredFPC, prices, steps and the confirmation string remain available; confirmation does not depend on the owner. Dry runs create no wallet, state, lock or manifest. Do not change RPC providers to work around a failed public preflight.

默认 RPC 为 drpc。覆盖 URL 后仍必须完整匹配上述身份及 realProofs=true，SponsoredFPC 地址和 class 必须匹配。身份不符在创建 wallet/PXE/state 前拒绝。dry-run 仅调用 getNodeInfo/getContract，打印实际方法，不生成密钥或 salt。无 keys 文件时，owner/deployer 及依赖它的合约地址显示为 "pending: derived after formal local key generation"；有 keys 文件时，dry-run 使用公开地址及部署 salt 投影预测 owner、treasury 和四个合约地址，不打印任何私值。仍输出 class ID、网络身份、SponsoredFPC、价格、步骤和不依赖 owner 的确认串；不创建 wallet、state、锁或清单。公网预检失败时不要擅换节点。

For a public deployment, the runner requires `--confirm` exactly matching the string printed by dry-run. It binds network identity, registrar kind, priceVersion, token source and treasury. Missing/wrong confirmation fails before network I/O.

公网部署时必须传入与 dry-run 输出完全一致的 `--confirm`，绑定网络、Registrar、priceVersion、Token 来源及 treasury。缺少或错误确认在网络请求前拒绝。

## Recovery and data / 恢复与数据

State defaults to `~/.local/share/ans/local-aztec6-6.0.0/` or `~/.local/share/ans/testnet-aztec6-6.0.0/`. `--state-dir` must remain outside the repository and legacy default directories. Keep local and public state separate. Directory mode is 0700; atomic state writes use 0600. Keys and salts stay only in private state and wallet storage; never copy them into logs, manifests or the repository. The manifest contains public addresses, identity, classes, prices, transaction hashes and deployment time; schema is `ans-deployment-v6/1`. Public display metadata and chain state are distinct from private recovery data. A local manifest cannot be written into deployments/.

state 默认目录如上，`--state-dir` 必须在仓库及旧版默认目录外，本地与公网分开保存。目录 0700，state 原子写入 0600。密钥和 salt 只保存在私有 state 和钱包存储，禁止复制到日志、清单或仓库。公开清单包含地址、身份、class、价格、交易哈希、时间；schema 为 `ans-deployment-v6/1`。公开元数据、链上状态与私有恢复数据各有用途。本地清单禁止写入 deployments/。

Rerun the same command and directory after interruption. Hashes are saved before sendTx; the runner prints SKIP for completed steps and RESUME for saved pending hashes. It tracks existing hashes without automatic resending. Changes to policy or network identity reject the checkpoint. A stale lock is removed only when its owner process no longer exists. Stop the entire process group when testing interruption.

中断后使用完全相同参数和目录续跑。哈希在 sendTx 前落盘；已完成步骤打印 SKIP，待确认哈希打印 RESUME，只追踪已有哈希，不自动重发。策略或网络不符会拒绝续跑。仅在原进程已不存在时清理旧锁。测试中断应停止整个进程组。

If a receipt is dropped, the runner checks the deterministic deployment address or bootstrap bindings. An existing matching effect is recorded as published-without-receipt. If absent, it stops. Only explicit `--rebroadcast <step>` can clear that hash, and only after a dropped receipt and absent effect are both confirmed. An RPC failure does not establish absence. Reverted receipts and unknown timeouts remain stopped for inspection. Never delete private checkpoints to recover a pending public transaction.

receipt dropped 时检查确定性地址或 bootstrap 绑定；匹配效果存在则记录 published-without-receipt，否则停止。仅显式 `--rebroadcast <step>` 且确认 dropped 和效果不存在，才允许清除该哈希。RPC 错误不能证明效果不存在。回滚和未知超时需停下检查，不能删私有检查点来恢复待确认公网交易。

`check:deployment` always validates the V5 Workers first. Missing deployments/testnet-v6.json prints a skip notice. It validates a canonical V6 testnet manifest when present; sample=true is forbidden there. `--v6-manifest` validates an explicit local rehearsal or sample without comparing V6 against V5 Workers. Proof-disabled local success does not establish real-proof or public-network readiness. CI only verifies the official Token pin; the repo Token pin is checked locally after `npm run build:contracts`.

`check:deployment` 总是先检查 V5 Worker。未部署 V6 清单时提示跳过；存在时严格校验且禁止 sample=true。显式 `--v6-manifest` 可检查本地演练或样例，不把 V6 与 V5 Worker 比对。本地关闭证明的成功不代表真实证明或公网就绪。CI 仅验证官方 Token 的固定类 ID；仓库 Token 的固定类 ID 在本地运行 `npm run build:contracts` 后验证。
