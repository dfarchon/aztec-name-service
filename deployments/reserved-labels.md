# Reserved labels v1 / 保留名单 v1

`reserved-labels.json` uses `ans-reserved-labels/1`. Categories are public review information; enforcement uses the union of their node keys. Every label is 7–31 ASCII characters, lowercase letters/digits/hyphens only, with no edge hyphen, `--`, `0x` prefix or dot. Short names are already closed to public registration and are excluded here. Categories and the flattened list must have no duplicates.

| Category / 分类 | Scope / 范围 |
| --- | --- |
| aztec | Aztec/Noir project, infrastructure and official-looking variants / Aztec、Noir 项目及基础设施和官方身份变体 |
| ans | ANS and dfarchon identity, administration and service labels / ANS、dfarchon 身份及管理、服务名称 |
| system | Administrative, support, security and impersonation-sensitive words / 管理、客服、安全及易被冒用的身份词 |
| ecosystem | Major chain, exchange, wallet and infrastructure identities / 主要链、交易所、钱包及基础设施身份 |

The deployment loader rejects malformed files and duplicates before hashing. The canonical SHA-256 input is `JSON.stringify(sortedFlatLabels)`; category order does not affect it. Legacy arrays remain supported with the same validation. Reservation bits are seeded and verified before bootstrap. Administrator mint and renewal retain their existing authorization and bypass public reservations.

部署加载器先校验标签和跨分类重复，再计算规范哈希：对排序后的扁平数组执行 `JSON.stringify`，然后 SHA-256；分类顺序不影响结果。旧数组格式继续支持，并接受同样校验。bootstrap 前必须写入并核验保留状态。管理员铸造和持有人续期继续使用原有权限，不受公开保留规则限制。

Propose changes by editing the categorized file with a rationale for each addition/removal, running loader and pinned-hash tests, and updating the deployment policy hash for review. A file edit does not change chain state; applying a reservation change requires the current administrator's explicit transaction.

变更时在对应分类中编辑，并逐项说明增删理由；运行加载器和哈希测试，更新部署策略哈希后提交审阅。修改文件不会自动修改链上状态；生效需要当前管理员明确发送交易。

Ruling 7 adds 22 labels (195 total): hyphenated Aztec product and official/support/admin/team variants prevent impersonation; ANS service names protect the service identity; airdrop/giveaway/rewards/staking/claim-airdrop and noreply/webmaster protect solicitation and sender identities; ethereumfoundation pairs with its existing hyphenated form. Look-alike spellings remain out of scope. Readiness requires this file's minLength to equal deployment minPublicLength.

裁定7补充22项（合计195）：Aztec 产品连字符与官方、客服、管理、团队变体防止身份冒用；ANS 服务名称保护服务身份；空投、奖励、质押、领取与发件人身份词减少钓鱼冒用；ethereumfoundation 补齐现有连字符形式。近似拼写不在本次范围。就绪检查要求本文件 minLength 等于部署 minPublicLength。
