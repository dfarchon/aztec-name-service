# ANS — Aztec 名字服务

Aztec 上类似 ENS 的名字注册与解析服务：Noir 合约、TypeScript SDK（`@ans/sdk`）、React 网站和 Cloudflare 监控，放在同一个 npm workspaces 仓库中。支持公开名字与持有人、Aztec 解析地址、双向确认的主名字、转移、编辑权限、子域、公开资料和多链地址记录。

> **English.** ANS is an ENS-like name service for Aztec: Noir contracts, a TypeScript SDK, a web app and a Cloudflare monitor in one npm-workspace repository. It currently runs on the Aztec public testnet only, and the contracts are unaudited. See [Development](#开发) for commands, [docs/sdk-onboarding.md](docs/sdk-onboarding.md) for SDK integration (bilingual) and [SECURITY.md](SECURITY.md) for vulnerability reports.

**状态**：仅部署在 Aztec 公共测试网，合约未经审计。测试网收费使用无价值的项目测试币 mAZTEC。

## 名字规则

| 项目 | 行为 |
| --- | --- |
| 名字 | 3–31 个小写 ASCII 字母、数字或连字符；连字符不能位于首尾；输入转小写 |
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

模块、管理员配置与 V6 变化见 [协议](docs/protocol.md)。

## 定价

注册和续期按名字长度分档，目标年费为 **3 个字符 128、4 个字符 32、5 个字符及以上 1 AZTEC**（18 位精度）。定价事实源为 `deployments/aztec-pricing.json`，实际报价始终从当前 Registrar 读取。测试网用 mAZTEC 演练同样的价格；官方 AZTEC 的 L2 可转账资产尚未接入，Fee Juice 只用于网络费。

## 仓库结构

| 目录 | 内容 |
| --- | --- |
| `contracts/name_registry_v6` | 当前核心 Registry（Aztec 6 测试网） |
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

SDK 尚未发布到 npm。它按链上准确类 ID 识别 V2–V6 与两种 Registrar，未知类返回 `wrong_deployment`。注册流程在发送前加密保存计划，已知交易哈希优先查询回执，只有回执证明失败才清除，不重复付款。接口、单位、错误与恢复规则见 [SDK 接入](docs/sdk-onboarding.md)，依赖边界见 [依赖安全](docs/dependency-security.md)。

## 安全与许可证

漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。代码以 [Apache-2.0](LICENSE) 许可发布；第三方来源见 [third-party/](third-party/README.md)。
