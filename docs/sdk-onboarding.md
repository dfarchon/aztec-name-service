# SDK 接入与注册链路

接入方只需安装 SDK、核对部署配置并连接用户授权的钱包账户。管理员可即时启用收款配置；费用预检和报价仍以链上读取为准。

## 开发者入口

完整示例内运行：

```sh
npm install
npm run check
npm run doctor
npm run read
npm run dev
```

`doctor` 读取网络身份、Registry 类、注册器、默认解析器、支付 Token、精度和赞助合约。`read` 无需钱包，验证正向解析和主名字。浏览器示例实现钱包发现、图案核对、账户选择、费用预检、加密计划存储、承诺、等待、付款及恢复；`npm run build` 生成独立浏览器产物。

| 接口 | 输入与结果 |
| --- | --- |
| `connectAns` | 已授权的钱包、账户与部署配置；校验网络及赞助合约，返回 AnsContext |
| `readFeeTokenMetadata` | 精确 Token 地址；返回已核对的标准合约类、decimals、symbol |
| `getPrivateFeeBalance` | 当前上下文与准确支付 Token；注册制品后读取私有余额 |
| `getFeeReadiness` | 上下文与已接受报价；返回余额、差额、元数据和 ready，读取失败不假定为零 |
| `createRegistrationFlow` | 上下文与持久存储适配器；串行准备、承诺、付款和回执恢复 |
| `getModules` / `getAdministrator` / `getLegacyRegistry` | 读取模块、管理员与迁移源 |
| `configureModules` / `setAdministrator` | 当前管理员上下文与新模块或账户地址；返回可按哈希恢复的交易结果 |
| `migrateName` | 当前持有人上下文与顶级名字；迁移后目标账户重新确认主名字 |

金额均使用 bigint 基础单位。页面展示时按实际 Token 精度换算；mAZTEC 为 18 位精度，`10^18` 单位显示为 1 mAZTEC。注册费与网络费独立，赞助网络费不会补足注册费余额。

价格按名字长度分档：报价需传入名字（`flow.quote(duration, name)`，或 `getFeeQuote` 的 `labelLength`），名字改变后重新报价；分档 Registrar 收到不带长度的报价请求返回 `invalid_argument`。报价的 `labelLength` 与金额一起绑定，不能用于其他长度的名字。新注册的名字不能包含 `--`，也不能以 `0x` 开头，SDK 在请求钱包前返回 `invalid_name`；已有名字照常解析和续期。SDK 0.5.0 及更早版本不认识分档 Registrar，会返回 `wrong_deployment`，需升级到当前版本。

## 持久化与恢复

`RegistrationPlanStore.load` 必须返回同一 key 最近一次成功 `save` 的结果（写后读一致性）。存储返回旧数据可能导致注册流程重复广播交易。

`prepare` 返回前保存注册秘密；首次提交前再次核对并保存。交易哈希回调立即排入持久化队列，调用结束前等待写入完成。存储失败后的已知哈希保留在流程内存中；恢复时先修复持久化，再跟踪回执。旧计划副本和同一流程内的并发点击不会重复付款。

钱包网络错误且没有返回哈希时，保存 `broadcastUnknown`，重新加载后也不会自动再发。接入方必须核对钱包活动和实际结果后才能明确解除该状态。已知 dropped/reverted 哈希也不自动清除。

浏览器示例仅将加密计划写入 localStorage。口令、私钥及注册秘密不进入 URL 或诊断输出。存储读取失败、写入失败及错误口令均阻止覆盖恢复数据。多个标签页或独立实例需要接入方提供共享租约。

## 配置与迁移

SDK 保留旧部署的名字读取与管理兼容。管理员直接配置费用 Registrar 或默认 Resolver，确认后生效。原有名字保持归属、期限和自己的解析器；费用变更会使旧报价及未消费的计划失效，重新读取后再付款。核心实现变更使用新部署地址，应用需重新建立上下文，旧计划不能跨部署复用。迁移保留顶级名字的归属、期限和默认地址，其余资料、编辑者、子域及主名字确认需要重新设置。详见 [协议](protocol.md)。

## 测试币获取

当前 mAZTEC 是项目测试 Token，尚无自助水龙头。外部开发者需获取准确 Token 的私有余额；`doctor` 输出资产地址，余额预检说明缺额。官方 AZTEC 收款仍需核验目标网络可转账资产。网站发布与 SDK 安装均不产生或兑换资产。

# SDK integration and registration

Install the SDK, verify the deployment and connect an authorized wallet account. Run `doctor` to check network identity, contract classes, active modules, the exact payment token and sponsorship. Run `read` without a wallet, then use the browser example for connection, balance preflight, encrypted recovery and registration.

Amounts use bigint base units. Token metadata determines display precision; 1 mAZTEC is `10^18` units. Registration fees and network fees are separate. Sponsorship does not fund the registration payment.

Prices are tiered by name length. Pass the name when quoting (`flow.quote(duration, name)`, or `labelLength` for `getFeeQuote`) and quote again when the name changes; a tiered Registrar rejects a quote without a length with `invalid_argument`. A quote binds its `labelLength` together with the amount. New registrations cannot contain `--` or start with `0x`; the SDK returns `invalid_name` before any wallet request, while existing names keep resolving and renewing. SDK 0.5.0 and earlier do not recognize the tiered Registrar and return `wrong_deployment`; upgrade to the current release.

`RegistrationPlanStore.load` must return the result of the last successful `save` for that key (read-your-writes). A store that serves stale reads can make the flow rebroadcast a transaction.

Persist the plan before sending. Track an existing transaction hash before retrying, and preserve an unknown-broadcast state until wallet activity is reconciled. Encrypted storage failures must block replacement of recovery data. Multiple tabs require a shared lease from the integrating application.

Administrators configure payment and default Resolver modules directly. A confirmed change takes effect immediately, preserves existing names and invalidates obsolete payment quotes. A replacement core deployment requires a new context and holder-authorized migration; plans cannot cross deployments. Migration preserves root ownership, expiry and the default address. Profiles, editors, subnames and primary consent are configured again on the destination. mAZTEC is a project test asset with no self-service faucet; official AZTEC settlement remains subject to asset verification.

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

### Launch read API / 读取接口

- `getConfig(snapshot?)`: returns optional `launch: { minPublicLength, paused, maxRenewAhead }`; length is characters and the horizon is bigint seconds. 返回可选 launch 策略；长度单位为字符，提前续期上限为 bigint 秒。
- `isReserved(node, snapshot?)`: bigint node → boolean for the active launch registrar; returns false on other registrar kinds. 输入 node，查询当前 launch 实例保留位；其他模块返回 false。
- `eligibility(name, snapshot?)`: canonical root name → `open | too_short | reserved | paused`, checked in pause/minimum/reservation order at one snapshot; this does not test ownership or reserve the name. 查询同一快照下的公开注册资格，顺序为暂停、长度、保留；不检查持有状态，也不锁定名称。
- `name_reserved`, `name_not_available_yet`, `registration_paused` are stable error codes before commit/reveal. Non-year launch quotes use `invalid_argument`. 注册前置核查使用上述稳定错误码；非一年报价返回 `invalid_argument`。链上仍最终核验，模拟不能保证状态不会变化。

See `examples/consumer/registration.ts (inspectLaunch)`, compiled against the independently installed SDK. No private wallet data enters these reads. Registration plans and saved hashes remain encrypted recovery data, separate from chain state; wallet/RPC/callback errors do not prove a reverted receipt.

完整模块示例 `examples/consumer/registration.ts (inspectLaunch)` 会对独立安装的 SDK 编译。公开读取不含私有钱包数据。计划和交易哈希属于加密恢复数据，与链上状态分别存储；钱包、RPC、回调异常都不能作为回滚回执。

Launch reveal defaults to `preflight: true`; a caller can explicitly override it when its wallet already guarantees simulation. A failed simulation occurs before the unknown-broadcast marker. Launch reveal 默认先模拟；钱包已保证模拟时调用方可显式覆盖 preflight。模拟失败发生在设置广播状态不明标记之前。
