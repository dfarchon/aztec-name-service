# ANS SDK 接入

[English](README.md) · 中文

示例包含 SDK 0.7.0、接入代码和公开测试网配置。先运行无钱包的名字解析，再接入钱包，完成注册与中断恢复。

## 环境与启动

- Node：24.12 及以上版本。
- Aztec 依赖：6.0.0，在应用根 `package.json` 中保留版本约束。
- 依赖覆盖：保留根 `overrides`；SDK 包中的覆盖配置不会传递给应用。
- 交付形式：压缩包内含 `ans-sdk.tgz`，SDK 尚未发布到公共 npm。

进入解压后的 `ans-consumer` 目录，执行：

```sh
npm install
npm run check
npm run doctor
npm run read
```

| 命令                                      | 结果                                           |
| ----------------------------------------- | ---------------------------------------------- |
| `npm run check`                           | 检查示例的 TypeScript 类型。                   |
| `npm run doctor`                          | 读取网络身份、支付 Token、当前模块与赞助合约。 |
| `npm run read`                            | 无需钱包，解析示例名字并验证主名字。           |
| `npm run dev`                             | 启动浏览器示例，打开输出的 localhost 地址。    |
| `npm run build`                           | 生成可部署的浏览器示例。                       |
| `npm audit --omit=dev --audit-level=high` | 检查应用实际安装的依赖。                       |

## 示例文件

| 文件                                       | 用途                                        |
| ------------------------------------------ | ------------------------------------------- |
| `deployment.json`                          | RPC、注册表、chain、rollup 与赞助合约配置。 |
| `pricing.json`                             | 发布时的定价方案。                          |
| `read.ts` / `doctor.ts`                    | 公开解析示例与部署诊断。                    |
| `wallet-connection.ts` / `registration.ts` | 钱包连接与注册接口封装。                    |
| `plan-store.ts`                            | 加密计划并保存到浏览器 `localStorage`。     |
| `browser/main.ts`                          | 连接表单、钱包确认与已保存计划。            |

浏览器首屏使用 `@ans/sdk/read`，钱包发现与注册代码在用户操作时加载。示例和网站共用 `bundle-budget.ts` 构建检查：首屏 JavaScript 上限为 gzip 400 kB，禁止提前加载 ANS 合约执行代码；测量结果写入 `bundle-budget.json`。

配置文件记录发布时的状态，付款前需从链上读取当前注册器与报价。实际支付 Token 与当前收款配置见[价格与支付资产](https://ans-testnet.huantian233.workers.dev/#/docs/pricing)。

## 名字解析

从 `@ans/sdk/read` 导入公开读取接口，无需连接钱包或加载证明运行库。钱包执行接口在用户操作时加载。`RegistryReader.connect` 连接节点并校验注册表合约类。

`resolveAddress` 返回解析状态、成功时的地址及本次读取的区块快照。将快照传给 `resolvePrimary`，可在同一区块校验主名字是否在当前注册代内正向解析到该地址。完整示例见 `read.ts`。

## 钱包连接

1. 执行 `npm run dev`，在当前浏览器发现兼容钱包。
2. 核对页面与钱包中的连接图案，确认连接。
3. 选择授权账户。`connectAns` 校验 chain、rollup、注册表、账户授权与赞助手续费合约类，然后向钱包注册所需合约信息。

`connectAns` 返回包含读取器、钱包与账户的 `AnsContext`，注册合约信息前会核对钱包与读取器的 `chainId` 和 rollup 版本。私有余额读取、费用授权与交易提交在钱包队列内再次检查网络，不匹配时返回 `wrong_deployment`。切换网络后需重新连接；密钥保留在钱包中。

重复展示主名字时，从 `@ans/sdk/read` 导入 `Resolver`。它在内存中缓存结果、合并并发查询，并检查缓存区块是否发生重组。默认缓存 30 秒，最长不超过名字到期时间；切换账户或部署时需清空缓存。支付检查仍读取最新链上状态。持有名字的分页游标绑定账户、注册表、chain 和 rollup 版本；升级前保存的游标缺少 rollup 版本时，需不带游标重新查询。

## 注册数据

| 对象                    | 内容与用途                                           | 保存位置                                     |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `FeeQuote`              | 从链上读取的租期、金额、Token 与费用策略。           | 应用内存；接受后的报价写入计划。             |
| `RegistrationPlan`      | 账户、名字、注册秘密值、已接受费用与交易哈希。       | 由应用加密后保存。                           |
| `RegistrationPlanStore` | 应用提供 `load` 与 `save` 方法，按键保存和恢复计划。 | 示例使用浏览器 `localStorage` 中的加密数据。 |
| 注册流程                | `createRegistrationFlow` 处理计划保存与交易。        | 应用内存；刷新后重新建立。                   |

## 支付检查

通过 `flow.quote(duration, name)` 读取新报价，`duration` 使用秒，`31536000n` 表示一年。价格按名字长度分档（3 个字符、4 个字符、5 个字符及以上），需传入用户要注册的名字，名字改变后重新报价；分档 Registrar 收到不带名字的报价请求会返回 `invalid_argument`。调用 `flow.readiness(quote)` 检查所选账户的私有余额。用户接受付款前，应用需展示名字、租期、金额、Token 地址及以下字段：

| 字段        | 含义                                              |
| ----------- | ------------------------------------------------- |
| `ready`     | 私有余额是否足以支付本次报价。                    |
| `balance`   | 报价 Token 的私有余额，使用最小单位。             |
| `shortfall` | 还需补充的金额，使用同一单位。                    |
| `token`     | 支付 Token 地址、符号与精度；免费报价不返回此项。 |

当前测试支付币没有自助水龙头，需向测试网维护者获取报价 Token 对应的私有余额。Fee Juice 支付网络手续费，不能支付注册费。`doctor` 检查公开配置；`readiness` 检查所选账户的余额。

直接调用时可使用 `getFeeReadiness(ctx, quote)` 或 `getPrivateFeeBalance(ctx, token)`。SDK 在读取私有余额和授权付款前注册对应支付 Token 的合约信息，注册器切换后也会重新核对。读取失败返回错误。

## 注册流程

| 步骤     | 接口                                    | 结果                                             |
| -------- | --------------------------------------- | ------------------------------------------------ |
| 报价确认 | 应用界面                                | 用户接受展示的名字、租期、Token 与金额。         |
| 计划准备 | `flow.prepare({ name, acceptedQuote })` | 重新核对费用策略，保存计划后返回。               |
| 承诺提交 | `flow.commit(plan, { onUpdate })`       | 请求用户在钱包确认第一笔交易，保存并跟踪哈希。   |
| 等待注册 | `flow.check(plan)`                      | 读取链上时间，可注册时返回 `ready_to_register`。 |
| 注册提交 | `flow.finish(plan, { onUpdate })`       | 请求确认付款与注册，等待回执进入 checkpointed。  |

浏览器示例中，先输入至少八位的恢复口令并解锁计划存储，再准备计划。每笔新交易分别请求钱包确认。

`registration.ts` 中的 `registrationActions` 调用 `connectAns` 并建立流程。下方函数接收已连接的读取器、已确认连接的钱包、授权账户、恢复口令与要注册的名字，返回流程、存储、报价与支付检查结果，不提交交易：

```ts
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Wallet } from '@aztec/aztec.js/wallet';
import type { RegistryReader } from '@ans/sdk/read';
import { registrationActions } from './registration.js';
import { encryptedPlanStore } from './plan-store.js';
import deployment from './deployment.json' with { type: 'json' };

export async function connectRegistration(
  reader: RegistryReader,
  wallet: Wallet,
  account: AztecAddress,
  recoveryPassphrase: string,
  name: string,
) {
  const scope = deployment.chainId + ':' + deployment.registry + ':' + account;
  const store = encryptedPlanStore(localStorage, recoveryPassphrase, scope);
  const flow = await registrationActions(reader, wallet, account, store);
  const quote = await flow.quote(31536000n, name);
  const readiness = await flow.readiness(quote);
  return { flow, store, quote, readiness };
}
```

`readiness.ready` 为 true 时，展示报价并取得用户确认，再将报价传给 `commitAcceptedPlan`：

```ts
import type { FeeQuote, RegistrationPlan, TxUpdate } from '@ans/sdk';
import type { RegistrationFlow } from './registration.js';

export async function commitAcceptedPlan(
  flow: RegistrationFlow,
  name: string,
  acceptedQuote: FeeQuote,
  onUpdate?: (update: TxUpdate) => void,
): Promise<RegistrationPlan> {
  const plan = await flow.prepare({ name, acceptedQuote });
  return flow.commit(plan, { onUpdate });
}

export async function finishReadyPlan(
  flow: RegistrationFlow,
  plan: RegistrationPlan,
  onUpdate?: (update: TxUpdate) => void,
): Promise<RegistrationPlan> {
  const state = await flow.check(plan);
  if (state.state === 'commit_wait' && !plan.registerTx) return plan;
  return flow.finish(plan, { onUpdate });
}
```

`commitAcceptedPlan` 在承诺交易确认后返回已保存计划。等待期间 `finishReadyPlan` 返回原计划，可再次调用 `check` 展示剩余时间；可注册时提交注册，存在 `registerTx` 时跟踪原交易。`onUpdate` 接收 `TxUpdate`，展示交易进度。这两个函数是应用接入示例；回执进入 `checkpointed` 后，注册流程才完成。

## 计划保存与恢复

示例通过 SDK 的 `seal`/`unseal` 加密计划后写入 `localStorage`。计划含注册秘密值，不能写入 URL 或日志。需保留恢复口令与浏览器中的加密数据；清理浏览器存储会移除已保存计划，换设备恢复需同时携带加密数据与原口令。

操作中断后，重新连接同一账户，用原口令解锁存储、读取计划并重新建立流程，再调用 `check` 或继续对应步骤。

- `commit` 与 `finish` 读取最新保存的计划。存在哈希时先跟踪原交易，传入旧计划副本也会复用已保存哈希。
- 口令错误或保存失败时停止操作，保留已有恢复数据。
- 提交后保存哈希失败时，`unknown_tx_state` 会携带哈希；先查询交易并恢复保存，再继续。
- 钱包未返回哈希时，计划记录 `broadcastUnknown`；检查钱包活动后才能明确清除并保存标记，再重新建立流程。
- `flow.recover(plan, kind, options)` 查询已知回执，不广播交易。`kind` 为 `"commitTx"` 或 `"registerTx"`，分别对应承诺与注册交易。确认交易已丢弃或回滚后，流程清除并保存对应哈希，再抛出相应错误。超时保留哈希；传入旧计划副本重试时，使用最新保存的进度。

每个账户保留一个活动流程。多个标签页或应用实例需共享存储租约，避免并发提交。示例仅串行处理同一标签页内的操作，跨实例协调与测试币供给由接入应用实现。

## 记录修改

V4 提供 `setManager`、`offerTransfer`、`acceptTransfer`、`issueSubname`、`revokeSubname`、`setTextRecord` 和 `setChainAddress`。

SDK 在写入前读取当前注册代和修订号。注册代标识本次注册，修订号标识该代内的最新修改；提交前发生变化时，需重新读取记录再重试。各操作所需账户见[所有权与编辑权限](https://ans-testnet.huantian233.workers.dev/#/docs/permissions)。

## 异常处理

| 错误码                             | 处理方式                                                  |
| ---------------------------------- | --------------------------------------------------------- |
| `network`                          | 重试读取，保留表单与已保存计划。                          |
| `fee_changed`                      | 重新读取并展示报价，用户接受后准备新计划。                |
| `unknown_tx_state`                 | 按「计划保存与恢复」核对已保存哈希或 `broadcastUnknown`。 |
| `wallet_rejected`                  | 保留计划，由用户重试钱包确认。                            |
| `unsupported` / `wrong_deployment` | 签名前核对网络、合约类与 SDK 版本。                       |
