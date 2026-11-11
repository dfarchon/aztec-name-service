# Changelog

## Unreleased — V7 / SDK 0.7 compatibility

The public test deployment (testnet-v6) is now free. On 2026-11-11 a new Registry `0x2d4dcccfab0afa50d15d4ec3fd7c3ef4beac112a0379bb51102ffd8a18969bd7`, Resolver `0x0f737886154ada69533177a70a65da2194f1bf2771d4bc07eb05e11536eee12f` and NameRegistrarLaunch `0x210cd05dde1ae6e37894c5a4f632acf85a09a49f1445bc0190d18cc26a952f34` were deployed under new administrator keys: no payment token, one-year leases, a public minimum of 5 characters, the shared reserved list, not paused, no renewal horizon. It replaces the previous paid tiered deployment; names registered there are not migrated, and the site, monitor and docs now point only at the new Registry. The deployment, reserved-list and bootstrap transactions are listed below; every readback check passed. The previous paid manifest is archived as `deployments/legacy/testnet-v6-tiered.json`; the paid V6 acceptance runner (`test:testnet:v6`, which mints mAZTEC and pays) and the no-FPC rehearsal now load it and refuse the free manifest, so there is no public acceptance runner for the free deployment yet. Verification boundary: the deploy runner's readbacks and local checks; no real-wallet registration has been run on the new deployment yet.

公开测试部署（testnet-v6）改为免费。2026-11-11 用新管理员密钥部署了新的 Registry `0x2d4dcccfab0afa50d15d4ec3fd7c3ef4beac112a0379bb51102ffd8a18969bd7`、Resolver `0x0f737886154ada69533177a70a65da2194f1bf2771d4bc07eb05e11536eee12f` 与 NameRegistrarLaunch `0x210cd05dde1ae6e37894c5a4f632acf85a09a49f1445bc0190d18cc26a952f34`：无支付 Token，租期一年，公开注册至少 5 个字符，使用共用保留名单，未暂停，不限续费上限。它替换此前收费的 tiered 部署；旧部署上的名字不迁移，网站、监控和文档只指向新 Registry。部署、保留名单和初始化交易见下表，全部回读检查通过。此前收费部署的清单存档为 `deployments/legacy/testnet-v6-tiered.json`；收费 V6 验收脚本（`test:testnet:v6`，会铸造 mAZTEC 并付费）和无 FPC 演练改为读取该存档，并拒绝免费清单，因此免费部署暂无公网验收脚本。验证边界：部署脚本回读和本地检查；新部署上尚未用真实钱包完成注册。

| Step / 步骤 | Transaction / 交易 |
| --- | --- |
| deploy-registry | `0x1955ac9756e8a2b62f1fc7fc801f7716d9af5a48a10e5b35fe0fe3e5c0ac3543` |
| deploy-resolver | `0x0c62a31337c8e1354378530c14a18d2c2d2217af897fa22f6a069429f2057b36` |
| deploy-registrar | `0x143d34840e189def611a0562404dde0967b3cecb1b55cfcc5475dd98b9a6c232` |
| seed-reserved-0 | `0x0f609062eb0501f50ca73b255ccb0919bd4f198c37d53cd92577224e3bf07fa1` |
| seed-reserved-1 | `0x2aed642f598eae3a8bb196bd37fc8da34a39638595c76b259f4e14378b81e167` |
| seed-reserved-2 | `0x165a0c5c907471b9905448817e6153798ab84758f7449623125b320a1ba2f403` |
| seed-reserved-3 | `0x0ef118ca47a6242472799bd573152f0ce69c6eb89d52b7a6b7601fa21377a173` |
| seed-reserved-4 | `0x29f7100b52eb0b347ab4fd331a2ea97625a6bbdf3390ed483883f1196b75ee3b` |
| seed-reserved-5 | `0x04335b87774480b2b4d0f090979f093fa564c10e0ca419e45e5b3b512cad05c4` |
| seed-reserved-6 | `0x2a0b084a437b8db8cccc885edb7dc12df6c544f41cc1b5def95fbb6e254a611b` |
| bootstrap | `0x1368f0429b6a52691810ee8b1938402d6ee202e786763e7cd210f87be880d11b` |

Names now display with the `.fog` suffix (Fully Obfuscated Glyph): `alice.fog`, `team.alice.fog`. The suffix is presentation only, so contracts, hashes, records and existing names are unchanged. The SDK exports `NAME_SUFFIX` and `formatName(label)`; strip user input with `normalizeName(input, { suffix: NAME_SUFFIX })` and keep passing canonical labels to every other call. `normalizeName` still treats `.fog` as a parent label unless the option is given. The website shows `.fog` everywhere, accepts input with or without it, adds a drifting fog background (static under reduced motion), and shows “Free to mint” only when the live Registrar has no payment token. `VITE_NAME_SUFFIX` is removed.

名字统一显示 `.fog` 后缀（Fully Obfuscated Glyph）：`alice.fog`、`team.alice.fog`。后缀只用于展示，合约、哈希、记录和已有名字都不变。SDK 导出 `NAME_SUFFIX` 与 `formatName(label)`；用户输入用 `normalizeName(input, { suffix: NAME_SUFFIX })` 去掉后缀，其他调用继续传规范标签。不带该选项时 `normalizeName` 仍把 `.fog` 当父标签。网站各处显示 `.fog`，输入可带可不带；新增缓慢流动的雾气背景（减少动态效果时静止）；只有当前 Registrar 没有支付 Token 时才显示 “Free to mint”。移除 `VITE_NAME_SUFFIX`。

Aztec 6 wallets (for example Nulo) refuse account and contract calls until the app holds matching capabilities. `requestAnsCapabilities(reader, wallet, { app, sponsoredFpc })` checks the wallet network, then asks once for account reads, payment authorizations and the deployment's named contracts (Registry, active Registrar and Resolver, payment token, sponsor), with no wildcard contract, address book or private events. Pass its returned wallet to `connectAns`; it requests any later contract (a name's own Resolver, a new Registrar) before registering it, and ends the session with `wallet_rejected` if account permissions narrow. `scopeAnsWallet`, `ansCapabilityManifest`, `ansSessionContracts` and `grantsAnsContract` are exported for custom flows. Fee authorizations are now requested as a CallIntent for the exact `transfer_in_private` call instead of a raw hash, so wallets that reject opaque hashes can show and sign the payment; the SDK verifies the intent hashes to the bound authorization and returns `unsupported` otherwise. The SDK sets no transaction salt and pins no protocol-contract address.

Aztec 6 钱包（如 Nulo）在应用取得对应权限前拒绝账户和合约调用。`requestAnsCapabilities(reader, wallet, { app, sponsoredFpc })` 先核对钱包网络，再一次性申请读取账户、签付款授权，以及部署中具名的合约（Registry、当前 Registrar 与 Resolver、支付 Token、赞助合约），不申请通配合约、地址簿或私有事件。把返回的钱包交给 `connectAns`；之后注册新合约（名字自己的 Resolver、新 Registrar）前会先补申请，账户权限收窄时以 `wallet_rejected` 结束会话。`scopeAnsWallet`、`ansCapabilityManifest`、`ansSessionContracts` 与 `grantsAnsContract` 供自定义流程使用。手续费授权改为以精确 `transfer_in_private` 调用的 CallIntent 申请，不再提交原始哈希，拒绝不透明哈希的钱包因此可以展示并签署付款；SDK 校验该意图与绑定授权哈希一致，否则返回 `unsupported`。SDK 不设置交易 salt，也不固定协议合约地址。

The SDK 0.7 release introduces a breaking `untrusted_resolver` branch in `AddressResolution`. Consumers must update exhaustive status switches before upgrading; use a minor version change while the SDK is pre-1.0. `resolvePrimary` can return stale with the same reason. `setPrimary` now refuses unverified resolvers by default; `acceptUnverifiedResolver: true` is an explicit risk override, without bypassing network, lifetime or forward-record checks. Raw `RegistryReader.getAddress` does not validate trust.

V7 `AddressChangedV3.revision` carries the generation's record revision; V3–V6 carry the shared name revision. Indexers must select by protocol version. V7 holder revisions remain separate. Quote creation and commit now require 300 chain seconds of remaining validity, including 180 seconds of proving/inclusion/checkpoint slack; this is a safety margin, not a latency guarantee.

SDK 0.7 新增 `AddressResolution.untrusted_resolver`，属于兼容性变化，穷尽状态分支的调用方升级前必须处理；1.0 前以次版本升级发布。`resolvePrimary` 可返回同原因的 stale。`setPrimary` 默认拒绝不可信解析器，显式 `acceptUnverifiedResolver: true` 只确认风险，不绕过网络、有效期或正向校验；原始 `getAddress` 不校验信任。V7 的 `AddressChangedV3.revision` 是当前代记录修订号，V3–V6 为共用名字修订号，索引器需按版本解释。创建报价计划与 commit 要求至少剩余300链上秒，其中180秒用于证明、包含和检查点延迟余量；这不是时延保证。
