# V8 核心升级 / Core upgrades

V8 是独立的新 Registry，基于冻结的 V7 公开业务规则。V2–V7 的源码、存储基线、类 ID 和已有部署不变。当前 V6 没有核心升级入口，不能补装本机制；旧名字不迁移。本文件描述待独立审核的实现，不能作为生产或主网就绪证明。未来配置见 `deployments/future-v8.template.json`，独立演练配置见 `e2e/v8-rehearsal.json`；它们都禁止本轮公网执行与站点发布。

V8 is a fresh independent registry retaining frozen V7 public business rules. V2–V7 sources, storage baselines, class IDs and existing deployments remain unchanged. Existing V6 has no core upgrade entry and cannot be retrofitted; old names are not migrated. This describes implementation awaiting independent review, not production or mainnet readiness. Both new profiles prohibit public execution and site publication this round.

## 管理权限与信任 / Authority and trust

产品选择为受信任的**单一管理员**，不要求多签。占位地址仍不允许上线；`adminPlaceholder`、占位地址拒绝表、RPC/链身份/版本/真实证明/地址/预算与站点发布阻塞项都必须保留。管理员可批准恶意代码并给出虚假的 family/sequence；链上批准不证明代码安全、存储兼容或业务语义。安全边界仍是精确源码、编译产物与类 ID 的独立审核、冻结布局测试、SDK 精确允许列表和公开等待期。

The product uses a **trusted single administrator**; multisig is optional. Placeholder administrators remain blocked, as do unresolved RPC/network/version/real-proof/address/budget/site requirements. The administrator can approve malicious code and attest false family/sequence labels. On-chain approval proves process constraints only. Reviewing the exact artifact and class ID, frozen-layout tests and SDK allowlists remain necessary.

`configure_modules` 仍立即生效，不受核心升级的 48 小时约束。管理员可立即影响后续注册、重发和接收转移所用的默认解析器以及新 Registrar 的费用策略。这是明确接受的独立风险，不能宣称核心延迟保护了所有管理操作。

`configure_modules` still takes effect immediately. Core delays do not protect Registrar fee policy or the default Resolver used by future registrations, reissues and accepted transfers. This remains a separate accepted administrative risk.

## 流程与取消 / Lifecycle and cancellation

| 操作 / Action | 要求与效果 / Preconditions and effect |
| --- | --- |
| `approve_release` | 管理员、当前 nonce、已实际注册的精确类 ID、固定 family、正整数 sequence；撤销后可显式重新批准，但不能重贴该类的 family/sequence 标签。 / Admin, current nonce, registered exact class, fixed family and positive sequence. Explicit reapproval preserves its original labels. |
| `approve_edge_pair` | 两个已批准发布，sequence 严格递增；记录正向和回滚两条有向边。两条边都可撤销。 / Records reviewed forward and reverse edges between approved releases; either direction is revocable. |
| `propose_upgrade` | 当前运行类和 `from` 一致、精确目标和有向边仍被批准；保存目标、来源、nonce 与 `now + 86400`。 / Pins runtime source, target, live edge and an application-ready time 86400 chain seconds later. |
| `execute_upgrade` | 管理员和新 nonce、与保存提案完全匹配、应用等待已满、再次验证运行类与实时批准；实例内静态读取协议延迟必须恰好 86400。只将保存的目标提交协议。 / Rechecks all policy and the exact protocol delay, then submits only the stored target. |
| `cancel_upgrade` | 执行前取消应用提案。 / Cancels the application proposal before execution. |
| `cancel_scheduled_upgrade` | 仅在 `now < activation_at` 且运行类仍为保存的 `from` 时，用该 `from` 覆盖协议计划。T 时刻及之后失败。 / Strictly before activation, schedules the still-running source as a no-op; fails at and after T. |
| `settle_upgrade` | 任何人可核对已激活的运行类并更新记账，不增加 nonce。 / Anyone may settle confirmed activation bookkeeping without changing the nonce. |
| 撤销 / Revoke | 清除受影响的应用提案；未激活的协议计划涉及的发布或边不能撤销，须先安全取消。重新批准后须新提案与完整等待。 / Clears affected proposals; scheduled policy cannot be revoked until safe cancellation. Reapproval needs a fresh proposal and full wait. |
| 管理员交接 / Handoff | 提名和接受均绑定 nonce；接受清除应用提案并增加 nonce。已提交的协议计划保留，新管理员可在严格边界内取消。 / Nonce-bound nomination/acceptance clears proposals on acceptance. An existing protocol schedule survives. |

所有时间为链上 Unix 秒，不是本地机器时间。正常升级至少需要 24 小时应用延迟 + 24 小时协议延迟。兼容回滚也是同样流程，来回至少 96 小时，另加包含与确认时间。没有紧急缩短、任意调用、协议延迟设置器或单向冻结。

Times are chain Unix seconds. Forward upgrade and compatible rollback each require 24 application hours plus 24 protocol hours. A round trip takes at least 96 hours plus inclusion/confirmation. There is no emergency bypass, arbitrary-call entry, delay setter or freeze operation.

**回滚保留所有业务写入。** 它只替换实现代码，不撤销交易、注册、转移、事件或新实现写入的数据。演练 successor 仅改变版本输出与发布序号，业务和治理布局完全相同，没有新状态。未来改变旧字段意义的版本不能仅凭“追加布局”声称可安全回滚。核心无私有 note 或私有存储；Token 的 notes 保持独立且不变，不据此推断任意未来 notes 兼容。

**Rollback preserves business writes.** It changes code without undoing transactions, registrations, transfers, events or successor writes. The rehearsal successor changes only version output and release sequence, with exactly identical business/governance layout and no new state. Appending fields does not prove semantic rollback safety. The core has no private notes/storage; separate Token notes are unchanged and establish no arbitrary future-note compatibility.

## 读取与钱包 / Reads and wallet execution

决策读取使用一个区块 N：header、`getContract(address, N)`、应用原始 slots、协议原始 slots，以及 N 的 canonical hash 复核。允许最新链头继续前进；只要求 N 未重组。根据原始快照计算当前有效类，不能把 public simulation 的“下一块预测”当作 N 的状态。未知根类、当前类、目标、有向边或应用/协议不一致均关闭写入，不猜测新版本。

Decision reads pin header, instance and application/protocol raw slots to block N and recheck hash(N). Advancing latest head is allowed. Public simulation is a **next-block prediction**, not snapshot evidence. Unknown roots/classes/targets/edges or inconsistent bookkeeping fail closed.

`RegistryReader.connect(node, address, { allowRehearsalSuccessor: true })` 仅在显式演练配置下接受精确 rehearsal successor。SDK 管理操作 `administerCoreUpgrade(ctx, action, options)` 的 nonce 为 uint64 bigint、类 ID/family 为 Field bigint、sequence 为正 uint32 number；结果包含交易哈希、回执状态和只读 readback。`wrong_deployment` 表示类/边/原始快照不一致，`invalid_argument` 表示 nonce/参数错误，临近激活返回 `unsupported`。readback 异常保留已跟踪的哈希，用 `unknown_tx_state` 返回，不能因此重发。

The explicit rehearsal flag permits only the exact known successor. SDK actions take a uint64 bigint nonce, Field bigint class/family and positive uint32 sequence. Results include hash, tracked receipt status and readback. Unknown/inconsistent state raises `wrong_deployment`, invalid inputs raise `invalid_argument`, and insufficient activation margin raises `unsupported`. Readback failure carries the known hash in `unknown_tx_state`; it never authorizes resend.

钱包队列内先校验 chain ID 与 rollup version，再刷新当前类和私有 artifact。激活前至少保留 900 秒 proving/inclusion 安全余量；这是保守下限，不是真实证明延迟的测量或保证。公网审核后还需实测并视情况提高余量。激活后刷新 artifact 才恢复。网络不可用不能写入，不回退到其他网络，不清除未知广播标记或已保存哈希。

Within the shared wallet queue, identity checks precede current-class/artifact refresh. A minimum 900-second preactivation proving/inclusion margin is a conservative floor, not measured real-proof latency or a guarantee. Public preflight must measure and raise it if needed. Refresh after activation before resuming. Network outages never enable writes or cross-network fallbacks.

## 独立演练与后续迁移 / Rehearsal and future migration

演练须部署独立 V8、Launch、Resolver，使用新账户和仓库外私有 checkpoint。完整 325 个保留标签的 hash 固定为 `743b1b4c3ab4762cb2d12662765406fdf91971845a5ec6137b1f7444223657fa`。保留免费、1–6 字符拒绝、7+ 允许、管理员 mint、暂停/恢复、续期上限、300 秒报价余量及转移后旧 Resolver 写入拒绝等用例，并增加真实 V8 延迟、取消、状态保持和回滚。

Use a fresh V8/Launch/Resolver suite, new accounts and a private checkpoint outside the repository. Retain the full 325-label hash above and all existing launch cases, plus actual V8 upgrades, strict cancellation, state preservation and rollback. Local debug time changes wall-clock duration only; neither 86400-second constant is shortened.

等待步骤保存状态后退出，给出 Asia/Taipei 最早恢复时间；恢复时重新检查链状态、实时批准、nonce 和保存哈希。已知哈希只追踪，广播不明停止，不自动重发；bridge 的 proven-block 恢复必须有界，不通过 SSH 重复 bridge。本轮不执行任何公网交易、bridge、充值或站点发布。

Waiting saves state and exits with earliest Asia/Taipei resume time. Resume rechecks chain state, live approvals, nonce and hashes. Known hashes are tracked only; ambiguous broadcast stops. Bridge proven-block recovery is bounded and never duplicated via SSH. No public transaction, bridge, funding or site publication occurs this round.

费用准备必须包含两个大类的发布、独立账户与套件部署、批准、提案、执行、取消与回滚。当前未测量，不得把旧分配当成上限。独立安全审核及 Sonnet 后，才可做公网 realProofs/链身份/余额和测量估算阶段；显著超过 90 FJ 或 0.006 Sepolia ETH 时，在充值前停止并报告。主网继续阻塞，直至新鲜真实证明证据、管理员、RPC、地址、费用与预算等均解决。

Fee planning includes both class publications, new accounts/suite, approvals, proposals, execution, cancellation and rollback. Estimates remain unmeasured; historical allowances are not bounds. Public real-proof/identity/balance/measured-estimate preflight follows independent safety and Sonnet review. Significant overrun of 90 FJ or 0.006 Sepolia ETH stops before funding. Mainnet remains blocked pending fresh real-proof evidence and all operational requirements.

未来跨地址迁移仅是策略范围：先决定新旧命名空间冲突和到期/保留策略，按固定旧部署和可验证快照核对当前持有人，由持有人显式选择迁移，重新确认主名字和解析器，处理 generation、转移、子域和提交中的状态。不复制旧授权或私有秘密，不宣称 V6 可升级，不自动迁移旧名字；完整迁移系统不在本任务内。

A future cross-address migration needs a separate design: namespace conflicts and expiry/reservation policy, pinned legacy identity and verifiable ownership, holder opt-in, fresh primary consent/resolver choices, and explicit generation/transfer/subname/pending-commit treatment. Do not copy old permissions or private secrets. No retroactive V6 upgrade or automatic name migration is claimed; implementing that system is out of scope.

旧的 V7 `deployments/mainnet.template.json` 本轮按边界保持原样，其历史多签 note 不改变 V8 的单一管理员产品选择。V8 使用新独立 future 模板；不能把历史 note 当作移除占位管理员阻塞项的理由。`verifyClass: false` 现在返回 `invalid_argument`，不能用来绕过精确类或演练 profile 校验。

The historical V7 mainnet template is deliberately unchanged this round. Its old multisig note does not override the V8 single-administrator decision or remove the placeholder block. V8 uses the new independent future template. `verifyClass: false` now raises `invalid_argument`; exact-class/profile checks cannot be disabled.

本地复现先用 `node scripts/prepare-v8-local-fixtures.mjs <仓库外绝对目录>` 创建明确标记的 C 和 delay fixture，再在该目录用本仓库 `scripts/aztec.mjs compile` 编译。运行 `test:upgrade` 必须显式设置 `ANS_V8_LOCAL_FIXTURE_DIR`；fixture 不进入 SDK 或公网配置。delay fixture 是唯一额外暴露协议 setter 的测试类，生产 V8 永远没有该入口。它用于让实际执行路径拒绝 600 秒协议延迟，不充当缩短等待的目标验收。

Local reproduction prepares fixtures with `node scripts/prepare-v8-local-fixtures.mjs <absolute-directory-outside-repository>` and compiles there through this repository's pinned `scripts/aztec.mjs compile`. `test:upgrade` requires explicit `ANS_V8_LOCAL_FIXTURE_DIR`. Fixtures are excluded from SDK/public profiles. Only the labelled delay fixture exposes a protocol setter, solely to test the real mismatch rejection; production V8 has no such entry and actual target acceptance uses both full delays.

## Review clarifications

Release revocation leaves stored edge approvals intact but dormant while either release is revoked. Reapproving that release reactivates every stored live edge involving it, in both directions, without another edge approval. `approve_edge_pair` explicitly approves **both** directions again, including a direction separately revoked earlier. Operators must review both directions before either action. Neither action restores a cleared proposal: a fresh proposal, the full 86400-second application wait and the full 86400-second protocol wait are still required. The local policy gate reads both stored edge statuses and tests fresh proposals and premature execution rejection.

Execute checks the **current operation's** `expected_nonce` through the administrator authority check and bumps it. It does not compare that value with `pending.nonce`; the proposal's saved nonce is observability data. Release/edge revocation clears affected proposals; cancellation and administrator acceptance clear the proposal; proposal replacement saves a new one. These explicit state transitions invalidate a proposal, rather than a saved-nonce equality check at execute.

An approved future class that changes the instance's protocol update delay would prevent V8 from executing both forward upgrades and rollback: V8 requires exactly 86400 seconds and has no delay setter. Exact target review must reject a delay setter, indirect delay mutation, arbitrary-call path or delay bypass. Approving a class remains a trusted administrator decision; no emergency escape is added to V8.

The public initializer makes its first valid caller administrator. Safe deployment therefore requires a **nonzero bound deployer equal to the intended owner**, included in the instance address preimage, with initialization in the deployment transaction. Never use `universalDeploy`, a zero deployer or a separately exposed uninitialized instance for this suite. The pinned 6.0.0 SDK's pending deploy locks to the first send-time `from`; the local path now supplies an explicit bound owner through `v8BoundDeployment` instead of depending on that default. Before bootstrap, read back `instance.deployer` and the initialized administrator and check both with `assertV8DeploymentOwner`. The offline future operator plan requires this helper/readback/checkpoint policy; no public V8 executor exists or is enabled yet. Any future executor must preserve these checks, including on resume, before further sends.

All SDK transaction submission routes converge on `runTxOutcome` inside the shared wallet queue, including registration commit/reveal and core administration. Each operation refreshes the registry artifact after network checks. A final V8 identity/class/margin read after host validation and optional preflight rejects a changed class or a margin of 900 seconds or less before the recovery marker is set. The 900-second value is a conservative floor, **not measured proof latency** or an inclusion guarantee. Once the wallet receives the send request, protocol maximum inclusion rules remain the final bound; an indefinitely delayed wallet cannot be made safe by this pre-send check. Retry after activation uses fresh artifacts.

Ordinary `npm run test:contracts` applies the first-party `scripts/txe-loopback.cjs` preload through `scripts/aztec.mjs test` only. The pinned launcher has no TXE host argument and starts its own Node child on 8081. The helper constrains its TCP/UDP listeners to literal loopback, preserves Unix sockets/callbacks/backlogs and rejects external hosts or unsupported prebound handles. It changes no outbound RPC, deployment or `start` command. No job-local preload or global configuration is required for contract tests. This control does not erase the earlier wildcard-listener incident recorded in the job evidence.
