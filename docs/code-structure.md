# 代码结构

本页说明 SDK 与 Web 的模块职责、交易恢复规则和扩展方式。

## 模块职责

| 模块                                        | 输入与结果                                                            |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `sdk/src/core/registry-protocol.ts`         | 根据合约类 ID 选择协议能力与存储布局。仅引用读取元数据。              |
| `sdk/src/client/reader.ts`                  | 读取指定快照中的公开状态，校验合约类与模块归属。                      |
| `sdk/src/wallet/context.ts`                 | 绑定钱包、账户和读取器；选择执行所需的合约信息。                      |
| `sdk/src/transactions/holding.ts`           | 查询名称持有状态，集中校验租期和所有者、编辑者权限。                  |
| `sdk/src/transactions/tx.ts`                | 在钱包队列内校验网络、建立调用、可选模拟和发送；按哈希跟踪回执。      |
| `sdk/src/transactions/registration-flow.ts` | 保存注册计划，串行处理提交与恢复，保留交易哈希和发送结果不明标记。    |
| `web/src/registration.ts`                   | 将当前账户的加密记录适配为 SDK 计划存储；每个账户上下文复用一个流程。 |
| `web/src/pages/Register.tsx`                | 展示报价、余额和注册进度，调用流程方法。                              |

## 交易与恢复

需要选择 Registrar 或 Resolver 的写入向 `runTx` 传入调用函数。SDK 先进入共享钱包队列，校验网络并刷新合约信息，再建立调用。直接传入已有调用的接口继续可用。

调用建立或模拟失败发生在发送之前，保留安全重试能力。发送后取得哈希就保存进度；发送结果不明且没有哈希时保存 `broadcastUnknown`，接入应用需核对钱包活动。

`flow.recover(plan, kind, options)` 只查询回执。确认交易丢弃或回滚后清除并保存对应哈希，再抛出相应错误；超时保留哈希。内存与持久化记录中的最新进度覆盖调用方的旧计划副本，包括已核实后清除的哈希。

## 扩展规则

- 新合约版本：补充协议元数据和对应钱包执行信息，沿用公开读取与交易流程。存储布局仍需符合既有基线。
- 新名称操作：复用持有状态和权限检查，再建立具体调用。转移接收者、正向地址确认者继续使用各自授权规则。
- 新接入应用：提供计划存储，复用注册流程；加密和跨实例协调由应用实现。

## English rules

Protocol metadata binds each supported class to its capabilities and storage layout. Public reads remain independent of executable contract artifacts. Wallet contexts bind accounts and deployments; transaction execution serializes wallet work and validates identity before building deferred calls.

Holding queries and lease/role checks are shared by name operations. Registration pages use the same SDK workflow as external consumers, with an adapter for encrypted account records. Receipt recovery never broadcasts, retains uncertain hashes, and clears only verified terminal failures. New versions, operations and storage integrations extend these existing boundaries.
