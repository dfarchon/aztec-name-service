import metadata from "../../web/src/public-metadata.json";
import registryMetadata from "../../sdk/src/artifacts/read-metadata.json";
import { inspectModules, modularClass, type ModulesState } from "./modular";
import { metricSample, transition, type Check, type State } from "./monitor";

export interface MonitorEnv {
  DB: D1Database;
  RPC_URL: string; REGISTRY: string; SPONSORED_FPC?: string; SITE_URL: string;
  CHAIN_ID: string; ROLLUP_VERSION: string; ROLLUP: string; RELEASE: string;
  FPC_LOW_WATERMARK: string; BLOCK_STALE_SECONDS: string;
  FEE_PAYMENT?: 'sponsored' | 'fee-juice'; NETWORK_LABEL?: string;
  OPERATOR?: string; OPERATOR_BALANCE_SLOT?: string; OPERATOR_LOW_WATERMARK?: string;
  ALERT_WEBHOOK?: string;
}
export interface Env extends MonitorEnv {
  ASSETS: Fetcher; RUM_LIMITER: RateLimit; MONITOR: Fetcher; ADMIN_TOKEN: string;
}

type NodeInfo = { nodeVersion: string; l1ChainId: number; rollupVersion: number; realProofs: boolean; l1ContractAddresses: { rollupAddress: string } };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
export async function rpc<T>(env: Pick<Env, "RPC_URL">, method: string, params: unknown[] = [], fetcher: typeof fetch = fetch): Promise<T> {
  const r = await fetcher(env.RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: `aztec_${method}`, params }), signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error("rpc_http_error");
  const body = await r.json<{ error?: unknown; result?: T }>();
  if (body.error || body.result === undefined) throw new Error("rpc_response_error");
  return body.result;
}

async function previousState(env: MonitorEnv) {
  const row = await env.DB.prepare("SELECT payload FROM monitor_state WHERE id=1").first<{ payload: string }>();
  return row ? JSON.parse(row.payload) as State : undefined;
}

/** Shorter than the one-minute cron so an interrupted probe never blocks the next scheduled run. */
const LOCK_MS = 55000;

export async function probe(env: MonitorEnv, at = Date.now(), fetcher: typeof fetch = fetch) {
  const owner = crypto.randomUUID();
  const claimed = await env.DB.prepare("INSERT INTO monitor_lock(id,owner,until) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until=excluded.until WHERE monitor_lock.until < ?").bind(owner, at + LOCK_MS, at).run();
  if (!claimed.meta.changes) return await previousState(env) ?? { checkedAt: 0, checks: [], failures: {}, open: [] };
  try { return await runProbe(env, at, fetcher); }
  finally { await env.DB.prepare("DELETE FROM monitor_lock WHERE id=1 AND owner=?").bind(owner).run(); }
}

async function runProbe(env: MonitorEnv, at: number, fetcher: typeof fetch) {
  if (!env.RELEASE) throw new Error("RELEASE is not set; deploy with npm run deploy:testnet or pass --var RELEASE:<id>");
  const previous = await previousState(env);
  const checks: Check[] = [];
  let block: number | undefined;
  let modules: ModulesState | undefined;
  try {
    const website = await fetcher(`${env.SITE_URL}/health.txt`, { cache: "no-store", signal: AbortSignal.timeout(7000) });
    const health = (await website.text()).trim();
    const ok = env.SITE_URL.startsWith("https://") && website.ok && website.headers.get("cross-origin-opener-policy") === "same-origin" && website.headers.get("cross-origin-embedder-policy") === "credentialless" && health === `ans:${env.RELEASE}`;
    checks.push({ name: "website", ok, detail: ok ? "HTTPS / release matches" : `HTTP ${website.status} · ${health === `ans:${env.RELEASE}` ? "release matches" : "release mismatch"} · isolation headers ${website.headers.get("cross-origin-opener-policy") === "same-origin" && website.headers.get("cross-origin-embedder-policy") === "credentialless" ? "Operational" : "Unavailable"}` });
  } catch { checks.push({ name: "website", ok: false, detail: "Unreachable" }); }
  try {
    const started = Date.now();
    const [info, current] = await Promise.all([rpc<NodeInfo>(env, "getNodeInfo", [], fetcher), rpc<number>(env, "getBlockNumber", [], fetcher)]);
    block = Number(current);
    if (!Number.isSafeInteger(block) || block < 1) throw new Error();
    checks.push({ name: "rpc", ok: true, detail: `${Date.now() - started} ms` });
    const identity = String(info.l1ChainId) === env.CHAIN_ID && String(info.rollupVersion) === env.ROLLUP_VERSION && info.l1ContractAddresses.rollupAddress.toLowerCase() === env.ROLLUP.toLowerCase() && info.realProofs === true;
    checks.push({ name: "chain", ok: identity, detail: identity ? `${env.NETWORK_LABEL ?? "Sepolia"} · runtime ${info.nodeVersion}` : "Network identity or proving mode mismatch" });
    const advances = previous?.block === undefined || block > previous.block;
    const stale = !advances && at - (previous.blockAdvancedAt ?? at) > Number(env.BLOCK_STALE_SECONDS) * 1000;
    checks.push({ name: "blocks", ok: !stale, detail: `#${block}${stale ? " · No recent blocks" : ""}` });
    if (identity) {
      // Configuration drift is reported on its own check instead of masquerading as an RPC outage.
      const userPays = env.FEE_PAYMENT === "fee-juice";
      const operator = env.OPERATOR && env.OPERATOR !== "UNDECIDED" ? env.OPERATOR : undefined;
      const fpcMetadataOk = env.SPONSORED_FPC === metadata.fpcAddress;
      const settled = await Promise.allSettled([
        rpc<{ currentContractClassId: string } | null>(env, "getContract", [env.REGISTRY], fetcher),
        userPays ? Promise.resolve(null) : rpc<{ currentContractClassId: string } | null>(env, "getContract", [env.SPONSORED_FPC], fetcher),
        userPays && !operator ? Promise.resolve("0") : rpc<string>(env, "getPublicStorageAt", [block, metadata.feeJuice, userPays ? env.OPERATOR_BALANCE_SLOT : metadata.fpcBalanceSlot], fetcher),
      ]);
      const reg = settled[0], fpc = settled[1], balance = settled[2];
      checks.push({ name: "registry", ok: reg.status === "fulfilled" && !!reg.value && (reg.value.currentContractClassId === registryMetadata.classId || modularClass(reg.value.currentContractClassId)), detail: "6.0.0 contract class" });
      if (reg.status === "fulfilled" && reg.value && modularClass(reg.value.currentContractClassId)) {
        try {
          const inspected = await inspectModules((method, params) => rpc(env, method, params, fetcher), env.REGISTRY, reg.value.currentContractClassId, block);
          modules = inspected.modules; checks.push(...inspected.checks);
        } catch {
          // A failed module read must be visible on the first probe, and must not hide independent sponsor results.
          for (const name of ["registrar", "resolver"]) checks.push({ name, ok: false, detail: "Module state could not be verified" });
        }
      }
      if (userPays) {
        checks.push({ name: "sponsor", ok: true, detail: "N/A · users pay own Fee Juice" });
        if (!operator) checks.push({ name: "balance", ok: true, detail: "N/A · operator undecided" });
        else {
          let value: bigint | undefined;
          if (balance.status === "fulfilled") { try { value = BigInt(balance.value); } catch { /* Invalid response fails the check. */ } }
          const configured = /^0x[0-9a-f]{64}$/i.test(env.OPERATOR_BALANCE_SLOT ?? "") && /^[0-9]+$/.test(env.OPERATOR_LOW_WATERMARK ?? "");
          checks.push({ name: "balance", ok: configured && value !== undefined && value >= BigInt(env.OPERATOR_LOW_WATERMARK!), detail: !configured ? "Operator balance configuration invalid" : value === undefined ? "Unable to read" : `${value / 10n ** 18n} Fee Juice` });
        }
      } else {
      checks.push(fpcMetadataOk
        ? { name: "sponsor", ok: fpc.status === "fulfilled" && fpc.value?.currentContractClassId === metadata.fpcClassId, detail: "6.0.0 FPC class" }
        : { name: "sponsor", ok: false, detail: "FPC read metadata needs regeneration" });
      let value: bigint | undefined;
      if (fpcMetadataOk && balance.status === "fulfilled") { try { value = BigInt(balance.value); } catch { value = undefined; } }
      checks.push({ name: "balance", ok: value !== undefined && value >= BigInt(env.FPC_LOW_WATERMARK), detail: value === undefined ? "Unable to read" : `${value / 10n ** 18n} Fee Juice` });
      }
    } else for (const name of ["registry", "sponsor", "balance"]) checks.push({ name, ok: false, detail: "Network mismatch; reads stopped" });
  } catch {
    for (const name of ["rpc", "chain", "blocks", "registry", "sponsor", "balance"]) if (!checks.some(c => c.name === name)) checks.push({ name, ok: false, detail: "RPC unavailable" });
  }
  if (previous?.modules && !modules) for (const name of ["registrar", "resolver"]) if (!checks.some(c => c.name === name)) checks.push({ name, ok: false, detail: "Module state could not be verified" });
  const result = transition(previous, checks, at, block);
  result.state.release = env.RELEASE;
  result.state.modules = modules ?? previous?.modules;
  if (modules && previous?.modules && JSON.stringify(modules) !== JSON.stringify(previous.modules))
    result.incidents.push({ name: "modules", kind: "changed", at });
  // All state and events commit together; restart/deploy does not reset failure counts.
  const stmts = [
    env.DB.prepare("INSERT INTO monitor_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").bind(JSON.stringify(result.state)),
    env.DB.prepare("INSERT OR REPLACE INTO monitor_samples(at,ok,payload) VALUES(?,?,?)").bind(at, checks.every(c => c.ok) ? 1 : 0, JSON.stringify(checks)),
    ...result.incidents.filter(() => env.ALERT_WEBHOOK).map(e => env.DB.prepare("INSERT INTO alert_outbox(payload) VALUES(?)").bind(JSON.stringify({ service: "ANS", release: env.RELEASE, event: e }))),
    ...result.incidents.map(e => env.DB.prepare("INSERT INTO incidents(name,kind,at) VALUES(?,?,?)").bind(e.name, e.kind, e.at)),
    env.DB.prepare("DELETE FROM monitor_samples WHERE at < ?").bind(at - 7 * 86400000),
    env.DB.prepare("DELETE FROM incidents WHERE at < ?").bind(at - 90 * 86400000),
    env.DB.prepare("DELETE FROM vitals WHERE day < ?").bind(new Date(at - 30 * 86400000).toISOString().slice(0, 10)),
  ];
  await env.DB.batch(stmts);
  for (const event of result.incidents) console.log(JSON.stringify({ event: "ans_monitor", ...event }));
  await deliverAlerts(env, fetcher);
  return result.state;
}


/** Failed deliveries remain in D1 and retry on the next minute. No webhook means no external messages. */
export const ALERT_BATCH = 20;
export const ALERT_OUTBOX_MAX = 500;
export async function deliverAlerts(env: MonitorEnv, fetcher: typeof fetch = fetch) {
  if (!env.ALERT_WEBHOOK) return;
  // Bound the outbox when the webhook keeps failing: keep only the newest ALERT_OUTBOX_MAX events.
  await env.DB.prepare("DELETE FROM alert_outbox WHERE id <= (SELECT MAX(id) FROM alert_outbox) - ?").bind(ALERT_OUTBOX_MAX).run();
  const rows = await env.DB.prepare("SELECT id,payload FROM alert_outbox ORDER BY id LIMIT ?").bind(ALERT_BATCH).all<{ id: number; payload: string }>();
  for (const row of rows.results) {
    try {
      const delivered = await fetcher(env.ALERT_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `ans-monitor-${row.id}` }, body: row.payload, signal: AbortSignal.timeout(7000) });
      if (!delivered.ok) throw new Error();
      await env.DB.prepare("DELETE FROM alert_outbox WHERE id=?").bind(row.id).run();
    } catch { console.warn("ans_monitor_alert_pending"); break; }
  }
}

/** Read at most `limit` bytes; undefined when the body is larger, without buffering the rest. */
export async function readBounded(request: Request, limit: number): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  const out = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(out);
}

/** Constant-time comparison via fixed-length digests, so neither content nor length leaks through timing. */
export async function tokenMatches(given: string | null, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given ?? "", expected].map(v => crypto.subtle.digest("SHA-256", enc.encode(v))));
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(a, b) && given !== null;
  const x = new Uint8Array(a), y = new Uint8Array(b); let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && given !== null;
}

const APP_ROUTES = new Set(["docs", "help", "changelog", "status", "names", "register", "manage", "name"]);
/** Map /docs/pricing to /#/docs/pricing and /favicon.ico to the SVG icon; undefined for anything else. */
export function appRedirect(url: URL): string | undefined {
  if (url.pathname === "/favicon.ico") return new URL("/favicon.svg", url).toString();
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (!parts.length || !APP_ROUTES.has(parts[0]) || parts.length > 2 || !parts.every(p => /^[A-Za-z0-9._-]{1,64}$/.test(p))) return;
  return new URL(`/#/${parts.join("/")}`, url).toString();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/status" && request.method === "GET") {
      if (!env.RELEASE) return json({ error: "release_unset" }, 503);
      // One D1 round trip for all status reads.
      const [stateRows, incidents, metrics] = await env.DB.batch([
        env.DB.prepare("SELECT payload FROM monitor_state WHERE id=1"),
        env.DB.prepare("SELECT name,kind,at FROM incidents ORDER BY at DESC LIMIT 30"),
        env.DB.prepare("SELECT name,SUM(samples) AS samples,SUM(total)/SUM(samples) AS average FROM vitals WHERE release=? GROUP BY name").bind(env.RELEASE),
      ]) as [D1Result<{ payload: string }>, D1Result<{ name: string; kind: string; at: number }>, D1Result];
      const stateRow = stateRows.results[0];
      const state = stateRow ? JSON.parse(stateRow.payload) as State : undefined;
      const incidentNames = new Set([...(state?.checks.map(check => check.name) ?? []), "modules"]);
      const current = state?.release === env.RELEASE;
      // Deployment and the scheduled probe are independent. Never relabel an older successful probe as this release.
      return json({ checkedAt: current ? state.checkedAt : 0,
        checks: current ? state.checks : [{ name: "website", ok: false, detail: "Current release has not been checked" }],
        incidents: incidents.results.filter(incident => incidentNames.has(incident.name)), metrics: metrics.results, release: env.RELEASE, checkedRelease: state?.release ?? null,
        open: state?.open ?? [], modules: current ? state.modules : undefined });
    }
    if (url.pathname === "/api/metrics" && request.method === "POST") {
      if (request.headers.get("origin") !== url.origin || Number(request.headers.get("content-length") ?? 0) > 512) return json({ error: "invalid_origin_or_size" }, 403);
      const { success } = await env.RUM_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "local" });
      if (!success) return json({ error: "rate_limit" }, 429);
      // Origin is advisory (non-browser clients can set it); telemetry is treated as untrusted and size-bounded while streaming.
      const body = await readBounded(request, 512);
      if (body === undefined) return json({ error: "invalid_size" }, 413);
      let metric;
      try { metric = metricSample(JSON.parse(body)); } catch { /* Invalid telemetry never reaches storage. */ }
      if (!metric || metric.release !== env.RELEASE) return json({ error: "invalid_metric" }, 400);
      await env.DB.prepare("INSERT INTO vitals(day,release,name,bucket,samples,total) VALUES(?,?,?,?,1,?) ON CONFLICT(day,release,name,bucket) DO UPDATE SET samples=samples+1,total=total+excluded.total").bind(new Date().toISOString().slice(0,10), metric.release, metric.name, metric.bucket, metric.value).run();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/probe" && request.method === "POST") {
      if (!env.ADMIN_TOKEN || !(await tokenMatches(request.headers.get("authorization"), `Bearer ${env.ADMIN_TOKEN}`))) return json({ error: "unauthorized" }, 401);
      return env.MONITOR.fetch(new Request("https://monitor.internal/probe", { method: "POST" }));
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
    // Unmatched asset paths reach the Worker. Typed or shared app paths go to the equivalent hash route instead of a blank 404.
    const route = appRedirect(url);
    if (route && (request.method === "GET" || request.method === "HEAD")) return Response.redirect(route, 302);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
