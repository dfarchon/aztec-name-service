# Security

## Status

ANS runs only on the Aztec public testnet. The contracts and SDK have **not been audited**. The payment token on testnet (mAZTEC) is a project test token with no value; no mainnet deployment exists. Do not use ANS to hold or move real assets.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include the affected component (contract, SDK, web app or monitor), the version or commit, reproduction steps and the impact you expect. Reports about these areas are especially useful:

- registration commit-reveal, fee authorization or treasury payment;
- ownership, editor, subname or primary-name checks (generation/revision, ancestor lifetime, bidirectional verification);
- SDK registration recovery that could resend a transaction or pay twice;
- leakage of registration secrets or wallet data from the web app.

There is no bug bounty. Fixes to deployed testnet contracts follow the module model described in [docs/protocol.md](docs/protocol.md): a new Registrar or Resolver can be configured, while a Registry implementation change needs a new deployment.

---

# 安全

ANS 仅运行在 Aztec 公共测试网，合约与 SDK **未经审计**。测试网支付 Token（mAZTEC）是无价值的项目测试币，目前没有主网部署。请勿用 ANS 持有或转移真实资产。

发现漏洞时，请在仓库的 **Security** 页选择 **Report a vulnerability** 私下报告，不要公开提 issue。请注明受影响组件（合约、SDK、网站或监控）、版本或提交、复现步骤和预期影响。本项目没有漏洞赏金。
