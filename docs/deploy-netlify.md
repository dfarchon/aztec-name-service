# Mainnet site on Netlify

The mainnet site moves to `https://fog.dfarchon.xyz`, hosted on Netlify. Everything else stays on Cloudflare. This runbook covers the one-time setup, a draft check, the release and rollback. Run it from a clean checkout of the commit that sets mainnet `SITE_URL` to `https://fog.dfarchon.xyz`.

| Part | Address | Where |
| --- | --- | --- |
| Static site (`web/dist`) | `https://fog.dfarchon.xyz` | Netlify project |
| `/api/status`, `/api/metrics`, `/api/rpc`, `/api/probe` | `https://fog-mainnet.huantian233.workers.dev` (`API_ORIGIN`) | Cloudflare Worker `fog-mainnet` |
| Monitor, D1 database, rate limits | Worker `fog-mainnet-monitor`, D1 `fog-mainnet-monitor`, `RUM_LIMITER` and `RPC_LIMITER` | Cloudflare |
| Former site address | `https://fog-mainnet.huantian233.workers.dev` | Same Worker, same build, with a notice that the site moved |

The site calls `API_ORIGIN` directly. The RPC address (`nodeUrl`) and `API_ORIGIN` do not change, so SDK consumers and wallets that already use them are unaffected. Testnet stays on `https://fog-testnet.huantian233.workers.dev`, and `npm run deploy:testnet` still deploys its two Workers only.

## Access and tools

- Node 24 (>=24.12) and `npm ci` in the repository.
- Cloudflare: `wrangler@4.147.0`, logged in (`wrangler login`) to the account that owns `fog-mainnet` and `fog-mainnet-monitor`. Set `CLOUDFLARE_ACCOUNT_ID` when the login can reach several accounts. Existing Worker secrets, such as the RPC upstream, are kept by `wrangler deploy`.
- Netlify: membership of the team that manages the `dfarchon.xyz` DNS zone, `netlify-cli@27.16.1`, and a personal access token (Netlify user settings, Applications) in `NETLIFY_AUTH_TOKEN`. Keep the token in the shell environment only; never write it into a repository file.

```sh
npm install --global wrangler@4.147.0 netlify-cli@27.16.1
export NETLIFY_AUTH_TOKEN=<personal access token>
```

## One-time Netlify setup

1. Create the project without linking it to this directory or to Git. `<team-slug>` appears in the team's Netlify URL (`app.netlify.com/teams/<team-slug>`). The `id` in the JSON output is `NETLIFY_SITE_ID`.

   ```sh
   netlify sites:create --name <project-name> --account-slug <team-slug> --disable-linking --json
   export NETLIFY_SITE_ID=<id>
   ```

2. Leave builds unconfigured: no Git repository, no build command, no plugins, forms or snippet injection. Releases are built locally from a verified commit and uploaded with `--no-build`; the release ID in `/health.txt` must match that commit.
3. In the project's domain management, add `fog.dfarchon.xyz` and make it the primary domain. The `dfarchon.xyz` zone uses NS1 name servers (`dns1.p09.nsone.net`), as Netlify DNS does; when the zone belongs to the same team, Netlify creates the record. Otherwise add `fog CNAME <project-name>.netlify.app` in the zone.
4. Wait until Netlify shows an active HTTPS certificate for `fog.dfarchon.xyz`. Before the first deploy, Netlify answers with its own 404 page:

   ```sh
   dig +short fog.dfarchon.xyz
   curl -sI https://fog.dfarchon.xyz | head -1
   ```

The domain must serve HTTPS before the release: the monitor fetches `https://fog.dfarchon.xyz/health.txt` every minute once its new configuration is deployed, and alerts after three consecutive failures.

## Draft check

A draft deploy gets its own URL and changes neither the live site nor either Worker.

```sh
npm run check:deployment
npm run deploy:frontend-preview -- --network mainnet
```

With `D` set to the draft URL the command prints:

```sh
curl -s "$D/health.txt"                                                # fog:<release>
curl -sI "$D/" | grep -i -E 'cross-origin|content-security|x-fog-release'
curl -s -o /dev/null -w '%{http_code}\n' "$D/docs/pricing"             # 200
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$D/favicon.ico"  # 302 …/favicon.svg
```

The headers must include `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless` and the `Content-Security-Policy`. In a desktop browser, `$D/docs/pricing` must turn into `#/docs/pricing`, `$D/#/status` must list the service checks (read from `API_ORIGIN`), and a name lookup must work. The console shows a refused `/api/metrics` request: only `SITE_URL` may send performance metrics, so this is expected on a draft address. Do not register or manage real names on the draft address, because browser data belongs to that address. A release ID ending in `-dirty` means the working tree has changes; the production release refuses to run in that state. A `package-lock.json` rewritten by `npm install` is the one exception and does not count, but the release then no longer pins the committed dependency set, so install with `npm ci`.

## Release

```sh
export NETLIFY_SITE_ID=<id> NETLIFY_AUTH_TOKEN=<token>
npm run deploy:mainnet
```

The command refuses a dirty tree (apart from `package-lock.json`), checks the configuration, builds `web/dist`, then publishes in this order: Netlify production deploy, monitor Worker, site Worker. All three carry the short `HEAD` commit as the release ID. If the Netlify upload fails, neither Worker changes. If a Worker step fails afterwards, fix the cause and run the same command again from the same commit.

## Checks after the release

```sh
R=$(git rev-parse --short HEAD)
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

- A faulty release: deploy an earlier commit that already has the new `SITE_URL`, with `npm run deploy:mainnet`, so the site, the monitor and the site Worker share one release ID. Publishing an older Netlify deploy alone leaves the monitor reporting a release mismatch.
- Moving the site back: revert the `SITE_URL` and `domain` change and run `npm run deploy:mainnet`, which then deploys the two Workers only. Keep the Netlify deploy online until registrations started on `fog.dfarchon.xyz` are finished.

## Rules

- Keep `fog-mainnet.huantian233.workers.dev` serving the current build, without a redirect, while registrations saved in browsers on that address may still be in progress.
- Do not change `API_ORIGIN` or `nodeUrl`; consumers already call them.
- Netlify uses credits for production deploys and bandwidth on credit-based plans; check the team's plan before frequent releases.
- `netlify deploy` creates a local `.netlify/` directory, which is ignored by Git.
