# 依赖安全

CI 运行 `npm audit --audit-level=high`，新增 high 或 critical 告警会阻断检查。告警数是 npm 依赖图的统计，不是实际可利用路径的数量；“无 high”不等于通过安全审计。

## 根 workspace overrides

| 依赖 | 固定版本 | 原因 |
| --- | --- | --- |
| `ws` | 8.22.0 | 覆盖上游精确锁定的旧版本 |
| `systeminformation` | 5.33.16 | 系统信息采集中的命令注入（含 [GHSA-3f7j-7jwc-fxfj](https://github.com/advisories/GHSA-3f7j-7jwc-fxfj)） |
| `@opentelemetry/propagator-jaeger` | 2.9.0 | [Jaeger propagator 公告](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-45rx-2jwx-cxfr)，保留 Aztec 使用的其他 OpenTelemetry 版本 |
| `zod` 4.x | 4.6.7 | Aztec 6 迁移时固定，使依赖图中的 zod 4.x 解析为同一版本 |

传递依赖 `follow-redirects` 在锁文件中为 1.16.2，修复跨源重定向时的凭据泄漏（[GHSA-q3jh-wrc6-jgq8](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8)、[GHSA-8r9p-f939-6h3c](https://github.com/advisories/GHSA-8r9p-f939-6h3c)、[GHSA-mrwp-f3q8-3g9p](https://github.com/advisories/GHSA-mrwp-f3q8-3g9p)）。

## SDK 消费方边界

npm 只识别安装项目根目录的 overrides，根 workspace 的锁文件也不会随 `@ans/sdk` tarball 传播。消费 SDK 的项目需要自行评估并设置相同 overrides，再验证其完整依赖图和运行结果。

## 公开读取依赖

名字、承诺和公开存储槽的 Poseidon2 哈希使用精确锁定的 [`@zkpassport/poseidon2@0.6.2`](https://github.com/zkpassport/poseidon2)，公开查询因此无需加载 Barretenberg 证明运行库。输入仍通过 Aztec `Fr` 校验字段范围。`sdk/test/hash-compatibility.test.ts` 将 ANS 域分隔符、不同输入长度、字段边界及公开 Map 槽与 Aztec 官方实现对比；这是兼容性检查，不构成对该依赖的独立安全审计。

---

# Dependency security

CI runs `npm audit --audit-level=high`; a new high or critical advisory blocks the build. Advisory counts describe the npm dependency graph, not exploitable paths, and "no high" is not a security audit.

The root workspace pins `ws`, `systeminformation`, `@opentelemetry/propagator-jaeger` and `zod` 4.x through `overrides`, and the lockfile resolves `follow-redirects` 1.16.2. npm applies overrides only at the installing project's root, and this lockfile does not ship with the `@ans/sdk` tarball: SDK consumers must evaluate and set their own overrides.

Public reads hash with the exactly pinned `@zkpassport/poseidon2@0.6.2`, so lookups do not load the Barretenberg proving runtime. `sdk/test/hash-compatibility.test.ts` compares it against the official Aztec implementation; this checks compatibility, not the dependency's security.
