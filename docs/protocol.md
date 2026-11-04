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

`NameRegistrarLaunch` 是可选的新 V6 收费模块，当前测试网清单不变，也不表示主网已部署。公开注册默认至少 7 个字符，管理员可在 3–31 内调整；短名显示 “Not yet available”，保留名显示 “Reserved”。保留表按 node 存储，32 个 node 一批，零值跳过；仓库 `deployments/reserved-labels.json` 当前为空列表，哈希随部署策略固定，后续由用户提供名单。

每次注册和续期固定 365 天。`max_renew_ahead` 单位为秒：0（脚本默认值）不限制提前续期，可重复续期；非零时只有当前到期时间 `<= 链上时间 + max_renew_ahead` 才能续期。主网模板仍为 null，等待最终决定。暂停只阻止公开注册，持有人续期和管理员铸造继续开放，以免宽限期内丢失名字。

免费实例要求 Token 地址和三档年费均为 0，不转 Token、不创建 AuthWit、不读私有 Token 余额；网络费仍由 Fee Juice 或代付承担。付费实例使用同一代码、不可变 Token/treasury 和 3/4/5+ 年费，长度、保留、暂停规则同样生效。管理员权限每次读取 Registry 的当前 administrator，提名者接受两步移交后立即生效，旧管理员失权。

管理员可通过独立域的 commit-reveal 直接为接收方注册合法短名或保留名；至少等待 60 秒，最多 24 小时，固定一年，付费实例中也免注册费。管理员仍受标签字符和禁止 `--` / `0x` 的新注册规则约束。切换实例前，运维脚本合并规范名单和完整 ReservedChanged 事件发现的 node，复制策略、核对存储及不可变续期上限；price_version 必须递增，任何不一致阻止切换。原持有、generation 和记录不迁移，旧实例的注册计划失效，重新报价。

## Launch Registrar (English)

`NameRegistrarLaunch` is an optional V6 module. It does not change the current testnet manifest or announce a mainnet deployment. Public registration defaults to at least 7 characters; the live administrator can choose 3–31. Short names show “Not yet available”; reserved names show “Reserved”. Reservations use node keys, batches of 32 and zero padding. `deployments/reserved-labels.json` is currently empty; its canonical SHA-256 hash binds deployment policy, and the user supplies the eventual list.

Each registration and renewal is exactly 365 days. `max_renew_ahead` is seconds: 0 (the script default) allows repeated renewal without a horizon; otherwise current expiry must be at most chain time plus the horizon. The mainnet template remains null pending the final choice. Pause blocks only public registration; holder renewal and administrator mint stay available, protecting holders during the grace period.

Free mode requires a zero token and all three prices zero: no token transfer, AuthWit or private token balance read. Fee Juice or sponsorship still pays network fees. Paid mode uses the same code with immutable token, treasury and 3/4/5+ prices; all public policy gates still apply. Authority is read from the Registry on every operation, so the nominee gains authority only after accepting the two-step handoff and the old administrator immediately loses it.

Administrator mint uses a separate commit-reveal domain, waits 60 seconds to 24 hours, writes the recipient directly, and grants one year without registration fees even in paid mode. Label rules, including no `--` or `0x`, still apply. Before switching instances, operator tooling combines the canonical list with every node discovered in the complete ReservedChanged history, copies policy and verifies storage parity and the immutable renewal cap. Price version must increase; any mismatch prevents the switch. Holdings, generations and records do not migrate. Old registration plans become invalid and need a fresh quote.
