# ANS — Aztec 名字服务

Aztec 上类似 ENS 的名字注册与解析服务：Noir 合约、TypeScript SDK（`@ans/sdk`）、React 网站和 Cloudflare 监控，放在同一个 npm workspaces 仓库中。支持公开名字与持有人、Aztec 解析地址、双向确认的主名字、转移、编辑权限、子域、公开资料和多链地址记录。

> **English.** ANS is an ENS-like name service for Aztec: Noir contracts, a TypeScript SDK, a web app and a Cloudflare monitor in one npm-workspace repository. It currently runs on the Aztec public testnet only, and the contracts are unaudited. See [Development](#开发) for commands, [docs/sdk-onboarding.md](docs/sdk-onboarding.md) for SDK integration (bilingual) and [SECURITY.md](SECURITY.md) for vulnerability reports.

**状态**：仅部署在 Aztec 公共测试网，合约未经审计。测试网收费使用无价值的项目测试币 mAZTEC。

## 名字规则

| 项目 | 行为 |
| --- | --- |
| 名字 | 3–31 个小写 ASCII 字母、数字或连字符；连字符不能位于首尾；输入转小写 |
| 后缀 | 名字统一显示为 `<标签>.fog`（Fully Obfuscated Glyph）。后缀只用于展示：合约只哈希和存储标签本身，`alice.fog` 即根标签 `alice`；输入可带或不带 `.fog` |
| 新注册限制 | 不能包含连续的 `--`（防 `xn--` 一类冒充），不能以 `0x` 开头（防伪装成地址）；由分档 Registrar 在链上检查，已注册的旧名字照常解析和续期 |
| 注册 | commit → 等待链上 60 秒 → reveal；commit 在 24 小时后失效 |
| 租期 | 1–5 个整年；每年按 365 天计算 |
| 过期 | 到期立即停止解析；30 天宽限期内原持有人可续期；之后允许重新注册 |
| 收费 | Registrar 固定 Token、年费和 treasury；管理员可立即启用新的 Registrar。分档 Registrar 按名字长度收费，续期按同一档位 |
| 控制权 | 公开存储 owner，由调用账户授权；改地址和续期同时检查 generation、revision |
| 主名字 | 目标账户确认；读取时校验名字仍有效、generation 相同、正向地址一致及 bindingVersion 相同 |
| 重新注册 | 增加 generation，使用全新地址记录；旧主名字不会复活 |
| 名字清单 | 分页读取公开注册事件，再回读当前持有人；错误与未查完均不显示为“没有名字” |

| 名字管理 | 行为 |
| --- | --- |
| 转移 | 持有人发起，接收方七天内确认；可取消；确认后递增 generation |
| 记录重置 | 转移后旧地址、资料、编辑者、主名字确认及子域失效 |
| 编辑者 | 一名，可修改默认地址及资料；不能续期、转移、发子域、改解析器或分配权限 |
| 子域 | 父域持有人签发、撤销或重发；最多四层；租期不超过祖先；祖先 generation 变化后不可恢复旧记录 |
| 资料 | 每代 64 个不同键，键最多 31 字节；每值 248 字节 UTF-8，删除值不回收键配额 |
| 多链地址 | 例如 `address:eip155:1` / `address:eip155:8453`，Ethereum / Base 地址；另有默认 Aztec 地址。只保存地址，不执行跨链转账 |

模块、管理员配置与 V6/V7 变化见 [协议](docs/protocol.md)。

## 定价

注册和续期按名字长度分档，目标年费为 **3 个字符 128、4 个字符 32、5 个字符及以上 1 AZTEC**（18 位精度）。定价事实源为 `deployments/aztec-pricing.json`，实际报价始终从当前 Registrar 读取。测试网用 mAZTEC 演练同样的价格；官方 AZTEC 的 L2 可转账资产尚未接入，Fee Juice 只用于网络费。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `contracts/name_registry_v6` | 当前核心 Registry（Aztec 6 测试网，冻结） |
| `contracts/name_registry_v7` | 主网目标 Registry；转移重置解析器、记录修订号独立 |
| `contracts/name_registry`、`_v3`、`_v4`、`_v5` | 旧部署的源码与冻结存储布局，只读兼容 |
| `contracts/name_registrar`、`name_registrar_tiered` | 单价 / 按长度分档的收费模块 |
| `contracts/name_resolver` | 默认解析模块 |
| `contracts/ans_common` | 共享哈希、标签打包与生命周期规则 |
| `contracts/test_token` | TXE 收费测试用的 Aztec 标准 Token（见 `third-party/`） |
| `sdk` | 无钱包查询（`@ans/sdk/read`）、双向解析、名字发现、交易、收费授权与注册恢复 |
| `web` | 查询 / 注册、我的名字、名字管理、文档中心与运行状态 |
| `ops` | Cloudflare 站点 Worker 与每分钟监控（D1） |
| `e2e` | 本地链与公共测试网验收、V6 部署脚本 |
| `examples/consumer` | 独立安装 SDK 的消费示例 |
| `deployments` | 测试网部署清单与定价 |

模块职责与扩展规则见 [代码结构](docs/code-structure.md)。

## 开发

需要 Node 24（≥ 24.12）和 npm。SDK 的合约 artifact 已随仓库提交，只改 SDK / 网站时无需安装 Aztec 工具链。

```sh
npm ci
npm run check    # 构建 SDK，检查所有 workspace 类型
npm test         # SDK、web、e2e、ops 单元测试及定价、包体积、部署配置检查
npm run build    # SDK + 网站生产构建
npm run dev      # 构建 SDK 并启动网站开发服务
```

文档与集成检查：`npm run check:docs`、`npm run check:format`、`npm run test:consumer`（需要 `zip` 命令）。CI 运行以上全部检查及 `npm audit --audit-level=high`，不运行合约、链上或浏览器测试。

### 合约

工具链固定为 Aztec **6.0.0**（`.aztecrc`）。npm 脚本通过 `scripts/aztec.mjs` 调用 `~/.aztec/versions/6.0.0`，不依赖全局 Aztec 版本；非标准安装路径可设置 `ANS_AZTEC_TOOLCHAIN_DIR`。

```sh
npm run build:contracts
npm run generate:sdk     # 同步 artifact、生成 wrapper 与 modular-metadata.json
npm run test:contracts   # TXE，占用 8081 端口
npm run check:brillig
npm run check && npm test
```

同一工具链版本内合约类 ID 必须不变，存储布局与旧版本基线（`contracts/*/storage-layout.json`）永不重新生成。

### 本地链

```sh
NO_PROXY=127.0.0.1,localhost node scripts/aztec.mjs start --local-network   # 8080
NO_PROXY=127.0.0.1,localhost npm run test:e2e
```

模块、收费与扩展功能使用隔离节点（8082，调试 RPC 8882）：

```sh
ANVIL_PORT=8547 node scripts/aztec.mjs start --local-network --port 8082 --admin-port 8882
npm run test:modular
npm run test:extensions
```

本地网络关闭证明，结果不代表真实证明或公共测试网可用。网站本地运行时，复制 `web/.env.example` 为 `web/.env` 并填入 `VITE_REGISTRY`。浏览器检查使用 `npm run smoke:* -w @ans/web`，需先构建 SDK 并启动开发服务（`BASE=<vite 地址>`）。

## 公共测试网

当前部署见 `deployments/testnet-v6.json`（Aztec 6 测试网，V6 Registry、分档 Registrar、mAZTEC）。Aztec 5.2.1 测试网上的 V2–V5 部署为只读存档，见 `deployments/testnet.json` 与 `deployments/legacy/`。

```sh
# 只读预检：只调用 getNodeInfo / getContract，不生成密钥、不发送交易
npm run deploy:v6 -- --network testnet-v6 --registrar tiered --price-version 1 --treasury 0x0000000000000000000000000000000000000000000000000000000000000001 --state-dir /tmp/ans-v6-public-dryrun --dry-run
# 对现有部署做真实证明验收（会广播交易）
ANS_V6_E2E_REPORT=/path/to/report.json npm run test:testnet:v6
```

所有公网脚本在广播前核对节点身份（chainId、rollup 版本与地址、节点版本、真实证明），在仓库外的私有目录（默认 `~/.local/share/ans/`）保存密钥与检查点，并在发送前记录交易哈希；中断后用同一目录续跑，不自动重发。完整流程见 [V6 部署](docs/deploy-v6.md)。

## 网站与监控

[测试网站](https://ans-testnet.huantian233.workers.dev) · [运行状态](https://ans-testnet.huantian233.workers.dev/#/status) · [文档中心](https://ans-testnet.huantian233.workers.dev/#/docs)

站点 Worker 与监控 Worker 共用一个 D1：监控每分钟检测网站、RPC、网络身份、出块、合约类与代付余额，连续三次失败记告警。Web Vitals 只提交指标名、数值与代码版本，不提交地址、名字或交易信息。文档中心的中英文指南、Markdown 下载与 `/llms-full.txt` 由 `web/src/docs-content.ts` 统一生成。

```sh
npm install --global wrangler@4.147.0
wrangler login
wrangler d1 execute ans-testnet-monitor --config ops/wrangler-monitor.jsonc --remote --file ops/schema.sql
npm run deploy:testnet
```

`ops/wrangler*.jsonc` 中的 D1 id 属于现有测试环境；在其他账户部署时，先新建 D1 并修改两份配置。部署脚本要求工作区已提交，发布版本为当前提交的短哈希。

## SDK

```sh
npm run pack:sdk                       # 生成 ans-sdk-<version>.tgz
npm install /path/to/ans-sdk-<version>.tgz
```

SDK 尚未发布到 npm。它按链上准确类 ID 识别 V2–V7 与三种 Registrar，未知类返回 `wrong_deployment`。注册流程在发送前加密保存计划，已知交易哈希优先查询回执，只有回执证明失败才清除，不重复付款。接口、单位、错误与恢复规则见 [SDK 接入](docs/sdk-onboarding.md)，依赖边界见 [依赖安全](docs/dependency-security.md)。

## 安全与许可证

漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。代码以 [Apache-2.0](LICENSE) 许可发布；第三方来源见 [third-party/](third-party/README.md)。

## Launch Registrar

`NameRegistrarLaunch` 是 V6/V7 可选的收费模块，当前测试网清单不变，也不表示主网已部署。公开注册默认至少 7 个字符，管理员可在 3–31 内调整；短名显示 “Not yet available”，保留名显示 “Reserved”。保留表按 node 存储，32 个 node 一批，零值跳过；仓库 `deployments/reserved-labels.json` 为 v1 分类名单，共 195 项且全部至少 7 个字符；加载器校验合法性和跨分类重复，排序后的规范哈希随部署策略固定，分类和变更流程见 `deployments/reserved-labels.md`。

每次注册和续期固定 365 天。`max_renew_ahead` 单位为秒，构造时须在 0–315360000（10 年）内：0（本地/测试网脚本默认值）不限制提前续期，可重复续期；非零时只有当前到期时间 `<= 链上时间 + max_renew_ahead` 才能续期。主网配置 `maxRenewAhead = 31536000`，到期前 1 年内可续期。管理员和 treasury 为占位地址 `0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68`（离线生成，从未部署），带 `adminPlaceholder: true`；正式启动前必须替换为多签并通过 readiness。暂停只阻止公开注册，持有人续期和管理员铸造继续开放，以免宽限期内丢失名字。

免费实例要求 Token 地址和三档年费均为 0，不转 Token、不创建 AuthWit、不读私有 Token 余额；网络费仍由 Fee Juice 或代付承担。付费实例使用同一代码、不可变 Token/treasury 和 3/4/5+ 年费，长度、保留、暂停规则同样生效。管理员权限每次读取 Registry 的当前 administrator，提名者接受两步移交后立即生效，旧管理员失权。

管理员可通过独立域的 commit-reveal 直接为接收方注册合法短名或保留名；至少等待 60 秒，最多 24 小时，固定一年，付费实例中也免注册费。管理员仍受标签字符和禁止 `--` / `0x` 的新注册规则约束。切换实例前，运维脚本合并规范名单和完整 ReservedChanged 事件发现的 node，复制策略、核对存储及不可变续期上限；price_version 必须递增，任何不一致阻止切换。原持有、generation 和记录不迁移，旧实例的注册计划失效，重新报价。

## Launch Registrar (English)

`NameRegistrarLaunch` is an optional V6/V7 module. It does not change the current testnet manifest or announce a mainnet deployment. Public registration defaults to at least 7 characters; the live administrator can choose 3–31. Short names show “Not yet available”; reserved names show “Reserved”. Reservations use node keys, batches of 32 and zero padding. `deployments/reserved-labels.json` contains the categorized v1 list of 195 labels, all at least 7 characters. The loader rejects illegal labels and duplicates before hashing the sorted flat list; categories and change procedure are in `deployments/reserved-labels.md`.

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

### Resolver integration / 解析器接入

```typescript
import { resolveAddress, type RegistryReader } from '@ans/sdk/read';
import { setResolver, type AnsContext } from '@ans/sdk';

export async function receivingAddress(reader: RegistryReader, name: string) {
  const result = await resolveAddress(reader, name);
  if (result.status === 'untrusted_resolver') throw new Error('Verify the resolver before using this address');
  return result.status === 'resolved' ? result.address : undefined;
}

export async function restoreDefaultResolver(ctx: AnsContext, name: string) {
  const modules = await ctx.reader.getModules();
  return setResolver(ctx, { name, resolver: modules.resolver });
}
```

`setPrimary(ctx, { name, acceptUnverifiedResolver? }, opts?)` 默认拒绝未验证解析器（`invalid_argument`），显式 `true` 可确认风险；此选择不绕过网络错误、有效期或正向地址校验，也不会使 `resolvePrimary` 返回可信结果。仅 `resolveAddress` 和 `resolvePrimary` 校验解析器信任；原始 `RegistryReader.getAddress` / `@ans/sdk/read` 返回链上公开记录，调用方需自行检查信任。

`setPrimary(ctx, { name, acceptUnverifiedResolver? }, opts?)` refuses an unverified resolver with `invalid_argument` unless explicitly opted in with `true`. The override preserves transport, active-lease and forward-address checks and cannot make `resolvePrimary` report trust. Only `resolveAddress` and `resolvePrimary` validate resolver trust; raw `RegistryReader.getAddress` / `@ans/sdk/read` returns public chain records for callers to validate.

L-02 仍待主网上线前处理：管理员更换默认解析器立即生效，V7 的注册、重发和接收转移均采用当前默认值。管理员被攻破会影响未来接收方；采用多签或时间锁管理是待办事项，监控继续关注 `configure_modules`。

L-02 remains open before mainnet: administrator changes to the default resolver take effect immediately, and V7 registrations, reissues and accepted transfers use that current default. Administrator compromise therefore affects future recipients. Multisig or timelock administration remains pending; monitoring continues to watch `configure_modules`.

`AddressChangedV3.revision` 在 V3–V6 表示共用的名字修订号，在 V7 表示当前代的记录修订号。索引器必须按协议版本解释，不应将 V7 事件计数器当作持有人修订号。

`AddressChangedV3.revision` is the shared name revision on V3–V6 and the generation's record revision on V7. Indexers must select the meaning by protocol version and keep the V7 holder revision separate.
