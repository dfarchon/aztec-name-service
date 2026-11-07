# 协议：管理员配置、模块与部署

ANS 的核心是 Registry，费用与解析由可替换模块负责。名字归属、租期与资料保存在 Registry 中，模块更换不迁移名字。

## 模块职责

| 模块 | 负责 | 配置规则 |
| --- | --- | --- |
| Registry | 名字归属、租期、代与修订号、权限、主名字确认 | 管理员直接配置 Registrar 和默认 Resolver |
| Registrar | 报价、commit-reveal、精确付款授权和私有收款 | Registry、Token、金库、年费、priceVersion 在构造时固定 |
| Resolver | 默认 Aztec 地址写入，转交原始调用账户 | 所属 Registry 固定；持有人可选择兼容解析器 |

部署账户为初始管理员。`bootstrap` 完成一次性初始化；之后 `configureModules` 配置模块，确认后立即生效。模块必须绑定同一 Registry，SDK 同时核对支持的合约类；配置写入核对模块修订号，避免旧状态覆盖新配置。

管理员配置不改变名字归属、租期或资料。默认 Resolver 变化只影响之后注册或签发的名字，既有名字保留自己的 Resolver。持有人主动更换解析器时，清空默认地址并推进绑定版本，目标账户需重新确认主名字。

## 收费变更

Registrar 的收费参数不可变。调整价格或收款资产时：

1. 核验网络、支付资产、精度、金库、年费及获取路径。
2. 部署绑定当前 Registry 的新 Registrar，核对其不可变收款参数。
3. 管理员调用 `configureModules(ctx, { registrar, resolver })`，保留不需要调整的模块地址。
4. 确认交易并回读配置，对注册和续期分别核对准确扣款与金库到账。

无需更换 Registry 或迁移名字。旧 Registrar 停止被核心接受，旧报价及未消费的注册计划失效，付款前须重新读取并确认。已完成交易先回读回执，不能因为配置变化重复付款。

## V6 与网络

| 合约 | 网络 | 状态 |
| --- | --- | --- |
| `name_registry_v6` | Aztec 6 测试网 | 当前核心，`deployments/testnet-v6.json`；legacy 为零地址，不迁移旧名字 |
| `name_registry_v5` 及更早 | Aztec 5.2.1 测试网 | 只读存档，`deployments/testnet.json`、`deployments/legacy/` |

V6 相对 V5 的变化：

- 管理员移交改为两步：当前管理员 `nominate_administrator(addr)`（传零地址撤销），被提名者 `accept_administrator()` 后生效；`get_administrator` / `get_pending_administrator` 可读。存储字段 `pending_administrator` 追加在末尾。
- 已过期（≥ MAX_COMMIT_AGE）且未消费的 commitment 可重新提交并刷新时间；未过期或已消费的不变。
- 存储布局、commit-reveal、精确付款授权、generation/revision、编辑者、祖先租期与双向主名字校验保持不变。

SDK 同时识别重新编译的 V2–V5 类与 V6，并按链上准确类 ID 选择存储布局。注册计划绑定网络、Registry、Registrar、付款资产、准确金额与 rollup 版本，不能跨部署复用。V6 部署流程见 [V6 部署](deploy-v6.md)。

## V5 持有人迁移（历史部署）

V5 支持从旧部署迁移顶级名字，迁移源固定在构造参数中：

| 项目 | 行为 |
| --- | --- |
| 入口 | 旧顶级名字持有人可在租期或 30 天宽限期内迁移 |
| 名字占用 | 可续期的旧名字在目的部署保留，其他账户不能抢注 |
| 保留 | 持有人、到期时间、默认 Aztec 地址 |
| 重新设置 | 主名字确认、编辑者、资料、多链地址和子域 |
| 旧部署 | 保留原记录和原能力 |
| 重复迁移 | 目的部署已初始化过该名字时拒绝 |

## 验证

`npm run test:contracts` 检查权限与状态边界；`npm run test:extensions` 在隔离本地链验证即时配置、旧计划失效、权限移交、准确收款和名字功能。本地链关闭证明，不代表真实证明或公网就绪。

## Worker 部署

`ops/wrangler*.jsonc` 支持注释和尾随逗号，不包含 `account_id` 与 `RELEASE`。`npm run deploy:testnet` 核对 Worker 的 RPC、Registry、FPC、chain ID、rollup 版本和 L1 Rollup 地址与部署清单一致，并通过 `--var RELEASE:<commit>` 注入版本。Cloudflare 账户由 `CLOUDFLARE_ACCOUNT_ID` 或当前 wrangler 登录决定。配置中的 D1 `database_id` 属于现有测试环境，在其他账户部署时需新建 D1 并替换两份配置的绑定。

配置网页钱包时，将逗号分隔的钱包 URL 传入 `ANS_PUBLIC_WALLET_URLS`。构建将相同 URL 写入前端，并只在 CSP `frame-src` 中放行对应来源；未配置时只允许同源 iframe。

---

# Protocol: administration, modules and deployments

The Registry owns names, leases, generations, permissions and primary consent. A Registrar fixes its token, treasury, annual price and price version at construction; a Resolver writes default Aztec addresses. The administrator configures modules with `configureModules(ctx, { registrar, resolver })`, and a confirmed transaction takes effect immediately. Changing payment policy means deploying a new Registrar and configuring it; names never migrate. Obsolete quotes and unconsumed plans must be prepared again, and completed payments recover their existing receipts.

A new default Resolver applies to subsequent registrations and subname issuance. Existing names keep their selected Resolver. Holder-controlled Resolver changes clear the default address and require fresh primary consent.

V6 (`name_registry_v6`) is the core on the Aztec 6 testnet (`deployments/testnet-v6.json`), deployed fresh with a zero legacy address. V5 and earlier deployments on the Aztec 5.2.1 testnet are a read-only archive. V6 adds two-step administrator transfer (`nominate_administrator` / `accept_administrator`) and lets an expired, unconsumed commitment be refreshed; storage layout and all registration invariants are unchanged. The SDK recognizes the recompiled V2–V5 classes and V6 by exact class ID. Registration plans bind the deployment and rollup version and cannot cross deployments. See [V6 deployment](deploy-v6.md).

`npm run deploy:testnet` validates Worker network fields, including the L1 Rollup address, against the deployment manifest and injects the release id. The D1 `database_id` in `ops/wrangler*.jsonc` belongs to the existing test environment; create your own D1 database when deploying to another account. Configure comma-separated web wallet URLs through `ANS_PUBLIC_WALLET_URLS`; the build permits only their origins in CSP `frame-src`.

## Launch Registrar

`NameRegistrarLaunch` 是 V6/V7 可选的收费模块，当前测试网清单不变，也不表示主网已部署。公开注册默认至少 7 个字符，管理员可在 3–31 内调整；短名显示 “Not yet available”，保留名显示 “Reserved”。保留表按 node 存储，32 个 node 一批，零值跳过；仓库 `deployments/reserved-labels.json` 为 v3 内容策略分类名单，共 325 项（保留 v2 原有 276 项，新增 49 项；文件 schema 仍为 `ans-reserved-labels/1`）且全部至少 7 个字符；加载器校验合法性和跨分类重复，排序后的规范哈希随部署策略固定，分类、企业身份来源和变更流程见 `deployments/reserved-labels.md`。support/official 组合词是本项目的防冒用策略，不表示企业官方服务、背书、所有权或合作关系。

每次注册和续期固定 365 天。`max_renew_ahead` 单位为秒，构造时须在 0–315360000（10 年）内：0（本地/测试网脚本默认值）不限制提前续期，可重复续期；非零时只有当前到期时间 `<= 链上时间 + max_renew_ahead` 才能续期。主网配置 `maxRenewAhead = 31536000`，到期前 1 年内可续期。管理员和 treasury 为占位地址 `0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68`（离线生成，从未部署），带 `adminPlaceholder: true`；正式启动前必须替换为多签并通过 readiness。暂停只阻止公开注册，持有人续期和管理员铸造继续开放，以免宽限期内丢失名字。

免费实例要求 Token 地址和三档年费均为 0，不转 Token、不创建 AuthWit、不读私有 Token 余额；网络费仍由 Fee Juice 或代付承担。付费实例使用同一代码、不可变 Token/treasury 和 3/4/5+ 年费，长度、保留、暂停规则同样生效。管理员权限每次读取 Registry 的当前 administrator，提名者接受两步移交后立即生效，旧管理员失权。

管理员可通过独立域的 commit-reveal 直接为接收方注册合法短名或保留名；至少等待 60 秒，最多 24 小时，固定一年，付费实例中也免注册费。管理员仍受标签字符和禁止 `--` / `0x` 的新注册规则约束。切换实例前，运维脚本合并规范名单和完整 ReservedChanged 事件发现的 node，复制策略、核对存储及不可变续期上限；price_version 必须递增，任何不一致阻止切换。原持有、generation 和记录不迁移，旧实例的注册计划失效，重新报价。

## Launch Registrar (English)

`NameRegistrarLaunch` is an optional V6/V7 module. It does not change the current testnet manifest or announce a mainnet deployment. Public registration defaults to at least 7 characters; the live administrator can choose 3–31. Short names show “Not yet available”; reserved names show “Reserved”. Reservations use node keys, batches of 32 and zero padding. `deployments/reserved-labels.json` contains the categorized v3 content-policy list of 325 labels (all original v2 276 plus 49 additions; file schema remains `ans-reserved-labels/1`), all at least 7 characters. The loader rejects illegal labels and duplicates before hashing the sorted flat list; categories, corporate identity sources and change procedure are in `deployments/reserved-labels.md`. Support/official compounds are our anti-impersonation policy and do not claim an official company service, endorsement, ownership or partnership.

Each registration and renewal is exactly 365 days. `max_renew_ahead` is seconds, bounded at construction to 0–315360000 (10 years): 0 (the local/testnet script default) allows repeated renewal without a horizon; otherwise current expiry must be at most chain time plus the horizon. Mainnet sets `maxRenewAhead = 31536000`: renewal opens 1 year before expiry. Admin and treasury use placeholder address `0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68` (offline-generated, never deployed), with `adminPlaceholder: true`; replace with a multisig and pass readiness before launch. Pause blocks only public registration; holder renewal and administrator mint stay available, protecting holders during the grace period.

Free mode requires a zero token and all three prices zero: no token transfer, AuthWit or private token balance read. Fee Juice or sponsorship still pays network fees. Paid mode uses the same code with immutable token, treasury and 3/4/5+ prices; all public policy gates still apply. Authority is read from the Registry on every operation, so the nominee gains authority only after accepting the two-step handoff and the old administrator immediately loses it.

Administrator mint uses a separate commit-reveal domain, waits 60 seconds to 24 hours, writes the recipient directly, and grants one year without registration fees even in paid mode. Label rules, including no `--` or `0x`, still apply. Before switching instances, operator tooling combines the canonical list with every node discovered in the complete ReservedChanged history, copies policy and verifies storage parity and the immutable renewal cap. Price version must increase; any mismatch prevents the switch. Holdings, generations and records do not migrate. Old registration plans become invalid and need a fresh quote.

## V7 resolver and revision rules / V7 解析器与修订号

主网使用新部署的 V7（`protocol: 7`，清单仍为 `ans-deployment-v6/1`）；当前测试网继续使用冻结的 V6，V2–V5 仅为旧网络存档，不迁移到 Aztec 6。V7 接收转移时将解析器重置为当时的默认解析器，并发出 ResolverChanged；旧 generation 的地址、资料、编辑者、主名字确认及子域不能复用。解析器只能在当前持有人选择或默认策略绑定的 generation 内写入，仍需校验当前持有人或编辑者身份。SDK/网站另外校验解析器类和 Registry 归属。

V7 的 `NameRecord.revision` 用于持有人操作；`Holding.recordRevision` 用于地址和资料写入。编辑者写入不会使续期、移除编辑者、换解析器或接收转移的持有人修订号过时。持有人换解析器会清除地址并推进记录修订号，使待执行的旧编辑操作失效。V3–V6 仍共用名字修订号。`get_record_revision(node, generation)` / `getRecordRevision(node, generation, snapshot)` 返回当前代记录修订号（u32 / number）。

解析器未经验证时，`resolveAddress` 返回 `untrusted_resolver`，不返回可信付款地址；`resolvePrimary` 返回 `stale`，reason 为 `untrusted_resolver`。`inspectResolver` 返回公开地址、verified、isDefault 及可选原因 zero / unknown_class / other_registry；网络错误继续抛出。V6 的 `acceptTransfer` 默认拒绝未经验证的继承解析器；显式 `acceptUnverifiedResolver: true` 才可接收；V6 的旧解析器还可通过共享修订号干扰重置，无法保证买方可靠恢复，测试网名字不应被视为有价值的资产。V7 返回 `resolverReset: true`。更换解析器不要求原解析器可信，但目标解析器必须通过校验。

SDK 创建计划及发送 commit 前要求报价至少剩余 300 链上秒：60 秒最小承诺年龄 + 60 秒 reveal 余量 + 180 秒证明、包含交易与检查点延迟余量。`COMMIT_QUOTE_MARGIN = 300n`，`REVEAL_MARGIN = 60n`；不足时在请求钱包前返回 `quote_expired`，仍需为实际证明和上链时间留出充足时间。恢复计划继续使用原有加密存储与回执证据规则。

Mainnet targets a fresh V7 (`protocol: 7`, retaining schema `ans-deployment-v6/1`). The current testnet stays on frozen V6; V2–V5 remain archives on the old rollup, with no migration to Aztec 6. Acceptance on V7 resets the resolver to the current default and emits ResolverChanged. Old-generation addresses, profiles, editors, primary consent and descendants cannot revive. A resolver can write only in the generation bound by that holder or default policy, and the supplied actor must be the current holder or editor. The SDK and web also verify its class and Registry binding.

V7 separates holder `NameRecord.revision` from editor `Holding.recordRevision`: editor writes cannot stale holder renewal, editor removal, resolver replacement or transfer acceptance. Resolver replacement clears the address and advances record revision, invalidating pending editor writes. V3–V6 retain a shared revision. `get_record_revision(node, generation)` / `getRecordRevision(node, generation, snapshot)` returns the generation's record revision as u32 / number.

An unverified resolver produces `resolveAddress.status = 'untrusted_resolver'` and `resolvePrimary.status = 'stale'` with reason `untrusted_resolver`. `inspectResolver` returns public address, verified, isDefault and optional zero / unknown_class / other_registry reason; transport errors still throw. V6 `acceptTransfer` refuses an unverified inherited resolver unless `acceptUnverifiedResolver: true` is explicit; the inherited resolver can also block recovery by pumping the shared revision. V6 testnet names must not be treated as holding value. V7 reports `resolverReset: true`. Reset checks the target resolver without requiring trust in the inherited one.

Before creating a plan or sending commit, the SDK requires 300 chain seconds of quote lifetime: 60 minimum commit age + 60 reveal margin + 180 proving, inclusion and checkpoint slack. `COMMIT_QUOTE_MARGIN = 300n`; `REVEAL_MARGIN = 60n`. Insufficient lifetime returns `quote_expired` before wallet submission. Allow adequate time for actual proving/inclusion; encrypted recovery and receipt-evidence rules still apply.

`setPrimary(ctx, { name, acceptUnverifiedResolver? }, opts?)` 默认拒绝未验证解析器（`invalid_argument`），显式 `true` 可确认风险；此选择不绕过网络错误、有效期或正向地址校验，也不会使 `resolvePrimary` 返回可信结果。仅 `resolveAddress` 和 `resolvePrimary` 校验解析器信任；原始 `RegistryReader.getAddress` / `@ans/sdk/read` 返回链上公开记录，调用方需自行检查信任。

`setPrimary(ctx, { name, acceptUnverifiedResolver? }, opts?)` refuses an unverified resolver with `invalid_argument` unless explicitly opted in with `true`. The override preserves transport, active-lease and forward-address checks and cannot make `resolvePrimary` report trust. Only `resolveAddress` and `resolvePrimary` validate resolver trust; raw `RegistryReader.getAddress` / `@ans/sdk/read` returns public chain records for callers to validate.

L-02 仍待主网上线前处理：管理员更换默认解析器立即生效，V7 的注册、重发和接收转移均采用当前默认值。管理员被攻破会影响未来接收方；采用多签或时间锁管理是待办事项，监控继续关注 `configure_modules`。

L-02 remains open before mainnet: administrator changes to the default resolver take effect immediately, and V7 registrations, reissues and accepted transfers use that current default. Administrator compromise therefore affects future recipients. Multisig or timelock administration remains pending; monitoring continues to watch `configure_modules`.

`AddressChangedV3.revision` 在 V3–V6 表示共用的名字修订号，在 V7 表示当前代的记录修订号。索引器必须按协议版本解释，不应将 V7 事件计数器当作持有人修订号。

`AddressChangedV3.revision` is the shared name revision on V3–V6 and the generation's record revision on V7. Indexers must select the meaning by protocol version and keep the V7 holder revision separate.
