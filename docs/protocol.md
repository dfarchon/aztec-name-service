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
