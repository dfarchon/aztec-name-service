# Isolated V7 launch rehearsal on the Aztec 6 testnet

This runner prepares an independent Registry V7, the frozen NameResolver, and NameRegistrarLaunch. It does not edit or reuse `deployments/testnet-v6.json`. The default is read-only, with no wallet creation, key loading, checkpoint creation or transaction submission:

```sh
umask 077
npm run testnet:v7-launch-rehearsal -w ans-e2e -- --dry-run
```

The public configuration is `e2e/launch-rehearsal.json`. The plan checks Aztec 6.0.0, Sepolia chain 11155111, rollup version 679261766, the pinned rollup and Fee Juice portal, and real proving. It reads only public Fee Juice balances, Sepolia ETH balance and gas price. Estimates are planning allowances: the prior approximately 3.96 FJ per user registration is the only measured input; the deployment and per-call allocations are unmeasured. The ETH allowance covers mint, approve and deposit gas, assuming testnet mint-handler availability. It does not price Fee Juice in ETH.

The deployment operator must first create a **new**, owned, private checkpoint directory under `~/.local/share/ans/testnet-v7-launch-rehearsal-<suffix>`, generate independent testnet owner and treasury accounts with the existing offline key initializer, and bridge Fee Juice to both public addresses. The treasury account acts as the transfer recipient. Prior rehearsal balances shown in the plan do not fund these new accounts automatically. Do not reuse an existing deployment's keys or checkpoints. The old deployment CLI's `--network testnet-v6 --init-keys --state-dir <new-directory>` supports offline initialization; do not run its deployment path, which intentionally permits only Registry V6 on testnet.

Only after separate authorization, rerun this planner with the intended `--state-dir`, then supply **both** `--send` and the exact printed `--confirm` value. This document does not authorize that action. There is no automatic bridging or key generation in the rehearsal runner. The send path requires existing private keys and positive public Fee Juice balances; account publication and any bridge claim setup are prerequisites, outside the rehearsal budget.

The confirmed execution deploys fresh Registry V7, resolver and launch registrar, configures modules, seeds and verifies reservations, and resumes public registration. It registers a name of at least seven characters, selects a second holder-chosen NameResolver, writes through it, transfers the name, and verifies that the former resolver cannot write in the new generation. `evil_resolver_test` is explicitly a TXE-only fixture, so this testnet rehearsal uses the supported custom-resolver fallback. That probe establishes retired-resolver rejection; it does not establish the arbitrary forged-owner coverage of the local evil-resolver regression.

Reserved and short public names must fail SDK preflight with their specific error codes. The administrator commits and mints a short name directly to the recipient. Pause must reject public preparation, and resume must restore the live policy. Negative probes use simulation or SDK preflight, without paid reverted transactions; they do not replace the contract or local chain regressions.

Quote windows of 60, 120, 180, 240 and 300 seconds are tested through read-only SDK preparation. The SDK requires 300 seconds remaining before commit, so the shorter windows are expected to fail before sending. The actual registration uses the normal 86400-second quote. Its elapsed time from commit submission preparation to L1 checkpoint is recorded separately from the subsequent wait for a proven receipt. The report computes each short window's remaining lifetime after both checkpoint latency and the 60-second minimum commit age, and compares it with the 60-second reveal margin. These are measured margins, not attempts to broadcast five short-lived commitments. A resumed measurement may include downtime; inspect its original start timestamp before interpreting latency.

The private `rehearsal-checkpoint.json` contains registration recovery material and must remain outside the repository. `rehearsal-report.json` exposes only addresses, class IDs, transaction hashes, verified completion history, receipt fees and quote measurements. The runner locks the directory and persists each computed hash **before** forwarding `sendTx`. On resume it checks all saved receipts, then resumes hashes instead of creating new transactions. Reverted, dropped, timed-out and ambiguous hashes are retained; operator investigation is required. A completed historical step rechecks its receipt without repeating state assertions superseded by later transfers or pause changes.

This script has unit coverage for planning, dry-run method restrictions and confirmation refusal. A successful dry-run or local fixture is not real-proof acceptance. Record actual testnet results only after a separately authorized run.


The shipped configuration intentionally keeps its one-label `reservedlaunch` probe (one seed batch); it does not claim full production-list seeding. Content policy v2 has 276 labels, preserving the original 195 and adding 81, while retaining schema `ans-reserved-labels/1`. The pure planner now multiplies the seed allowance by `ceil(reservedLabels.length / 32)` for any supplied list. The full v2 list needs nine seed transactions versus seven for v1, with twelve zero-padding slots in the final batch. At the existing unmeasured 1.98 FJ allocation per seed batch, this is 17.82 FJ versus 13.86 FJ, an extra 3.96 FJ (+28.6% seed-batch budget). These are planning allowances, not measured fees or real fee quotes. No rehearsal configuration, confirmation, checkpoint or sender behavior is changed by this policy update; a full-list rehearsal would need its own reviewed configuration and authorization. See [reserved-list policy and source mapping](../deployments/reserved-labels.md).


Content policy v3 retains v2's exact 276 labels and adds 49 (325 total, unchanged schema and minimum 7). Full-list planning uses eleven batches of 32, versus v2's nine (+2, +22.2%), with 5 labels and 27 padding slots in the final batch. At the provisional unmeasured 1.98 FJ per batch, seed allowance is 21.78 FJ versus 17.82 (+3.96). Total allowances are 59.54 FJ / recommended 90 versus v2 55.58 / 84. The default one-label fixture remains 39.74 / 60. These are not measured fees, quotes or guaranteed bounds; account setup, funding and failures remain additional. This data update changes no configuration or sender behavior and authorizes no chain action.

v3内容策略保留v2全部276项及分类，新增49项，共325项，schema及最短长度7不变。完整名单按每批32需11批，比v2的9批增加2批（22.2%），末批5项补27个零。每批1.98 FJ仍为未实测占位，写入预算17.82→21.78 FJ，总预算55.58→59.54 FJ、建议84→90；单标签夹具仍为39.74、建议60。这不是实测费用、报价或保证上界，账户、资金和失败另计；此次不修改演练配置或发送行为，也不授权链上操作。

## 独立 V8 演练准备 / Independent V8 preparation

V7 演练配置与既有部署保持不变。新的 `e2e/v8-rehearsal.json` 和 `deployments/future-v8.template.json` 仅准备独立 V8/Launch/Resolver、新账户与仓库外私有 checkpoint；参见 [核心升级边界](core-upgrade-v8.md)。全量 325 个标签及固定 hash 不变。不得将 V7 的小型保留样本或历史费用分配直接当成 V8 公网预算。

Existing V7 rehearsal configuration and deployments remain unchanged. The new V8 profiles prepare a separate suite and accounts, preserving the full 325 reservations. Both class publications and all governance operations require measured estimates after independent reviews; historical V7 allocations are not bounds. Public execution and site publication remain prohibited this round.

等待时保存 stage、原始快照区块/哈希、nonce、固定 from/to、提案/协议 ready 时间和已知交易哈希，然后退出并打印 Asia/Taipei 最早恢复时间。恢复时重新校验网络、实时批准及 canonical 快照；已知哈希只追踪，广播不明停止，不自动重发。严格取消只在激活前保留运行类；激活后完整延迟回滚且保留业务写入。

Save stage, pinned block/hash, nonce, exact from/to, ready/activation times and known hashes before exiting a wait. Resume revalidates identity, canonical state and live approvals. Track known hashes only; stop ambiguous broadcasts. Cancellation cannot act at or after activation; compatible rollback takes the full delays and preserves writes. Bridge recovery remains bounded and checkpointed, with no duplicate SSH bridge. Mainnet remains blocked pending fresh real-proof evidence and operational readiness.
