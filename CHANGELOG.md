# Changelog

## Unreleased — V7 / SDK 0.7 compatibility

The SDK 0.7 release introduces a breaking `untrusted_resolver` branch in `AddressResolution`. Consumers must update exhaustive status switches before upgrading; use a minor version change while the SDK is pre-1.0. `resolvePrimary` can return stale with the same reason. `setPrimary` now refuses unverified resolvers by default; `acceptUnverifiedResolver: true` is an explicit risk override, without bypassing network, lifetime or forward-record checks. Raw `RegistryReader.getAddress` does not validate trust.

V7 `AddressChangedV3.revision` carries the generation's record revision; V3–V6 carry the shared name revision. Indexers must select by protocol version. V7 holder revisions remain separate. Quote creation and commit now require 300 chain seconds of remaining validity, including 180 seconds of proving/inclusion/checkpoint slack; this is a safety margin, not a latency guarantee.

SDK 0.7 新增 `AddressResolution.untrusted_resolver`，属于兼容性变化，穷尽状态分支的调用方升级前必须处理；1.0 前以次版本升级发布。`resolvePrimary` 可返回同原因的 stale。`setPrimary` 默认拒绝不可信解析器，显式 `acceptUnverifiedResolver: true` 只确认风险，不绕过网络、有效期或正向校验；原始 `getAddress` 不校验信任。V7 的 `AddressChangedV3.revision` 是当前代记录修订号，V3–V6 为共用名字修订号，索引器需按版本解释。创建报价计划与 commit 要求至少剩余300链上秒，其中180秒用于证明、包含和检查点延迟余量；这不是时延保证。
