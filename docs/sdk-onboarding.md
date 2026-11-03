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
