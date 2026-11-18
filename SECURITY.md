# Security

## Status

Fog Names runs only on the Aztec public testnet. The contracts and SDK have **not been audited**. Testnet payment tokens (`mAZTEC`, `FOGF`) are project test tokens with no value, and no mainnet deployment exists. Do not use Fog Names to hold or move real assets.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include the affected component (contract, SDK, web app or monitor), the version or commit, reproduction steps and the impact you expect. Reports about these areas are especially useful:

- registration commit-reveal, fee authorization or treasury payment;
- ownership, editor, subname or primary-name checks (generation/revision, ancestor lifetime, bidirectional verification);
- SDK registration recovery that could resend a transaction or pay twice;
- leakage of registration secrets or wallet data from the web app.

There is no bug bounty. Fixes to deployed testnet contracts follow the module model described in [docs/protocol.md](docs/protocol.md): a new Registrar or Resolver can be configured, while a Registry implementation change needs a new deployment.
