# Mainnet site on Netlify

The mainnet site lives at `https://fog.dfarchon.xyz`, hosted by a Netlify project that builds from this repository's `main` branch. Everything else stays on Cloudflare. This runbook covers the setup, previews, a release in two halves (Netlify, then Cloudflare), checks and rollback.

| Part | Address | Where |
| --- | --- | --- |
| Static site (`web/dist`) | `https://fog.dfarchon.xyz` | Netlify project, built from `main` with `netlify.toml` |
| `/api/status`, `/api/metrics`, `/api/rpc`, `/api/probe` | `https://fog-mainnet.huantian233.workers.dev` (`API_ORIGIN`) | Cloudflare Worker `fog-mainnet` |
| Monitor, D1 database, rate limits | Worker `fog-mainnet-monitor`, D1 `fog-mainnet-monitor`, `RUM_LIMITER` and `RPC_LIMITER` | Cloudflare |
| Former site address | `https://fog-mainnet.huantian233.workers.dev` | Same Worker, same build, with a notice that the site moved |

The site calls `API_ORIGIN` directly. The RPC address (`nodeUrl`) and `API_ORIGIN` do not change, so SDK consumers and wallets that already use them are unaffected. Testnet stays on `https://fog-testnet.huantian233.workers.dev`, and `npm run deploy:testnet` still deploys its two Workers only.

**Merging to `main` publishes the mainnet site.** Netlify builds every new `main` commit and publishes it. The Cloudflare half must then be deployed from the same commit, or the monitor reports a release mismatch.

## How Netlify builds

`netlify.toml` sets the build command to `node scripts/build-site.mjs --network mainnet` and the publish directory to `web/dist`, with Node 24. This overrides the build settings in the Netlify UI. Only this build produces a releasable site:

- `/health.txt` with the release ID (the short commit hash) that the monitor compares;
- `_headers` with the isolation headers (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`) and the `Content-Security-Policy`;
- `_redirects` for typed app paths such as `/docs/pricing`;
- the SDK downloads and the Markdown docs (`llms-full.txt`).

A plain `npm run build` has none of these. The build sets every `VITE_*` value from the committed deployment config, so `VITE_*` variables in the Netlify UI have no effect and are not needed. `FOG_PUBLIC_WALLET_URLS` must stay unset. A `package-lock.json` rewritten by Netlify's dependency install does not mark the release `-dirty`; any other change does.

## One-time Netlify setup

1. Import the GitHub repository into a Netlify project in the team that manages the `dfarchon.xyz` DNS zone, with `main` as the production branch. Leave plugins, forms and snippet injection off.
2. In the project's domain management, add `fog.dfarchon.xyz` and make it the primary domain. The `dfarchon.xyz` zone is on Netlify DNS (NS1 name servers `dns1.p09.nsone.net`); when the zone belongs to the same team, Netlify creates the record. Otherwise add `fog CNAME <project-name>.netlify.app` in the zone.
3. Wait until Netlify shows an active HTTPS certificate for `fog.dfarchon.xyz`.

A machine whose DNS goes through a local proxy (for example Clash in TUN mode) may keep a cached "no such domain" answer for up to an hour after the record appears. Check with DNS over HTTPS instead:

```sh
curl -s 'https://dns.google/resolve?name=fog.dfarchon.xyz&type=A' | jq -c '.Answer'
```

## Previews

Netlify deploy previews of pull requests use the same build, on their own URL. They change neither the live site nor either Worker. `npm run deploy:frontend-preview -- --network mainnet` uploads a local build as a draft instead (`NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN`, `netlify-cli@27.16.1`). With `D` set to the preview URL:

```sh
curl -s "$D/health.txt"                                                # fog:<release>
curl -sI "$D/" | grep -i -E 'cross-origin|content-security|x-fog-release'
curl -s -o /dev/null -w '%{http_code}\n' "$D/docs/pricing"             # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$D/favicon.ico"  # 302 …/favicon.svg
```

In a desktop browser, `$D/docs/pricing` must turn into `#/docs/pricing`, `$D/#/status` must list the service checks (read from `API_ORIGIN`), and a name lookup must work. The console shows a refused `/api/metrics` request: only `SITE_URL` may send performance metrics. Do not register or manage real names on a preview address, because browser data belongs to that address.

## Release

1. Merge to `main`. Netlify builds and publishes the merge commit. Wait until the site serves it:

   ```sh
   R=$(git rev-parse --short origin/main)   # the commit Netlify built
   curl -s https://fog.dfarchon.xyz/health.txt   # fog:$R
   ```

2. Deploy the Cloudflare half from the same commit. Use `wrangler@4.147.0`, logged in to the account that owns `fog-mainnet` and `fog-mainnet-monitor` (set `CLOUDFLARE_ACCOUNT_ID` when the login reaches several accounts). Existing Worker secrets, such as the RPC upstream, are kept.

   ```sh
   git checkout "$R" && npm ci
   git status --porcelain                           # empty
   npm run check:deployment
   node scripts/build-site.mjs --network mainnet    # web/dist/health.txt must read fog:$R
   wrangler deploy --config ops/wrangler-monitor-mainnet.jsonc --var "RELEASE:$R"
   wrangler deploy --config ops/wrangler-mainnet.jsonc --var "RELEASE:$R"
   ```

Do not use `npm run deploy:mainnet` for this project: it uploads its own build to Netlify outside the Git build.

## Checks after the release

```sh
curl -s https://fog.dfarchon.xyz/health.txt                     # fog:$R
curl -s https://fog-mainnet.huantian233.workers.dev/health.txt  # fog:$R
curl -s https://fog-mainnet.huantian233.workers.dev/api/status \
  | jq '{release, checkedRelease, website: (.checks[] | select(.name == "website"))}'
# Metrics from the site are allowed (this empty sample is rejected with 400 and nothing is stored); other origins get 403.
curl -s -o /dev/null -D - -X POST -H 'Origin: https://fog.dfarchon.xyz' -H 'Content-Type: text/plain' \
  --data '{}' https://fog-mainnet.huantian233.workers.dev/api/metrics | grep -i -E '^HTTP|access-control-allow-origin'
```

Within two minutes `checkedRelease` equals `release` and the `website` check is `ok` with `HTTPS / release matches`. In a browser, `https://fog.dfarchon.xyz` loads, connects a wallet and looks up names, and `https://fog-mainnet.huantian233.workers.dev` shows "Fog Names has moved" with a link to the new address.

## Rollback

- A faulty release: revert the change on `main` (Netlify publishes the revert commit), then deploy the Cloudflare half from that commit. Publishing an older Netlify deploy in the UI alone leaves the monitor reporting a release mismatch.
- Moving the site back: revert the `SITE_URL` and `domain` change on `main`, then deploy the two Workers from that commit. Keep the Netlify site online until registrations started on `fog.dfarchon.xyz` are finished.

## Rules

- Keep `fog-mainnet.huantian233.workers.dev` serving the current build, without a redirect, while registrations saved in browsers on that address may still be in progress.
- Do not change `API_ORIGIN` or `nodeUrl`; consumers already call them.
- Netlify uses credits for builds, production deploys and bandwidth on credit-based plans; check the team's plan before frequent releases.
- `netlify deploy` creates a local `.netlify/` directory, which is ignored by Git.
