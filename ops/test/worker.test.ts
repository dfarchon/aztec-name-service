import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import worker, { probe, deliverAlerts, readBounded, tokenMatches, appRedirect, ALERT_OUTBOX_MAX, type Env } from '../src/worker.js';
import { deploymentConfigMismatches } from '../../scripts/deployment-config.mjs';
import metadata from '../../web/src/public-metadata.json' with { type: 'json' };
import registry from '../../sdk/src/artifacts/read-metadata.json' with { type: 'json' };

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new NodeURL('../schema.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string) => {
    let values: any[] = [];
    const statement = {
      sql,
      bind: (...args: any[]) => { values = args; return statement; },
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => { const r = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(r.changes) } }; },
    };
    return statement;
  };
  const DB = { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => {
    sqlite.exec('BEGIN');
    try { const values = await Promise.all(statements.map(s => /^\s*SELECT/i.test(s.sql) ? s.all() : s.run())); sqlite.exec('COMMIT'); return values; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } } as unknown as D1Database;
  const env: Env = { DB, ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    MONITOR: { fetch: async () => Response.json({ checkedAt: Date.now() }) } as unknown as Fetcher,
    RUM_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    RPC_URL: 'https://rpc.test', SITE_URL: 'https://ans.test', REGISTRY: 'registry', SPONSORED_FPC: metadata.fpcAddress,
    CHAIN_ID: '11155111', ROLLUP_VERSION: '679261766', ROLLUP: '0xrollup', RELEASE: 'a123abc',
    FPC_LOW_WATERMARK: '1000000000000000000', BLOCK_STALE_SECONDS: '600', ADMIN_TOKEN: 'test-only-token' };
  let broken = '', block = 100;
  const fetcher = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(env.SITE_URL)) return new Response(`ans:${env.RELEASE}`, { headers: { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' } });
    const req = JSON.parse(init!.body as string);
    let result: unknown;
    if (req.method === 'aztec_getNodeInfo') result = { nodeVersion: '6.0.0', l1ChainId: 11155111, rollupVersion: broken === 'chain' ? 0 : 679261766, realProofs: true, l1ContractAddresses: { rollupAddress: env.ROLLUP } };
    else if (req.method === 'aztec_getBlockNumber') result = block;
    else if (req.method === 'aztec_getContract') result = { currentContractClassId: broken === 'class' ? 'bad' : req.params[0] === 'registry' ? registry.classId : metadata.fpcClassId };
    else if (req.method === 'aztec_getPublicStorageAt') {
      assert.deepEqual(req.params, [block, metadata.feeJuice, metadata.fpcBalanceSlot]);
      result = broken === 'balance' ? '0x0' : '0x1bc16d674ec80000';
    } else throw new Error(`Unexpected method: ${req.method}`);
    return Response.json({ result });
  }) as typeof fetch;
  return { env, sqlite, fetcher, break: (value: string) => { broken = value; }, advance: () => { block++; } };
}

test('monitor persists class, network, low-balance alerts and recovery across probe invocations', async () => {
  const f = fixture();
  const start = Date.now();
  try {
    const healthy = (await probe(f.env, start, f.fetcher))!;
    assert.equal(healthy.checks.length, 7); assert.ok(healthy.checks.every(c => c.ok));
    for (const failure of ['class', 'balance', 'chain']) {
      f.break(failure);
      for (let i = 1; i <= 3; i++) { f.advance(); await probe(f.env, start + i * 60000, f.fetcher); }
      const rows = f.sqlite.prepare('SELECT * FROM incidents WHERE kind=\'alert\'').all();
      assert.ok(rows.length >= 1);
      f.break(''); f.advance();
      const recovered = await probe(f.env, start + 240000, f.fetcher);
      assert.deepEqual(recovered!.open, []);
    }
    const response = await worker.fetch(new Request(`${f.env.SITE_URL}/api/status`), f.env);
    const data = await response.json() as any;
    assert.equal(data.checks.length, 7); assert.ok(data.incidents.some((e: any) => e.kind === 'recovered'));
    assert.ok(!JSON.stringify(data).includes(f.env.ADMIN_TOKEN));
  } finally { f.sqlite.close(); }
});

test('stalled blocks become unhealthy while class reads retain a consistent block', async () => {
  const f = fixture(); const at = Date.now();
  try { await probe(f.env, at, f.fetcher); const stale = await probe(f.env, at + 601000, f.fetcher);
    assert.equal(stale!.checks.find(c => c.name === 'blocks')?.ok, false);
    f.advance(); const recovered = await probe(f.env, at + 602000, f.fetcher);
    assert.equal(recovered!.checks.find(c => c.name === 'blocks')?.ok, true);
  } finally { f.sqlite.close(); }
});

test('status does not present a prior release probe as current deployment evidence', async () => {
  const f = fixture();
  const status = async () => (await worker.fetch(new Request(`${f.env.SITE_URL}/api/status`), f.env)).json() as Promise<any>;
  try {
    await probe(f.env, Date.now(), f.fetcher);
    assert.equal((await status()).checkedRelease, 'a123abc');
    f.env.RELEASE = 'b456def';
    const pending = await status();
    assert.equal(pending.release, 'b456def');
    assert.equal(pending.checkedRelease, 'a123abc');
    assert.equal(pending.checkedAt, 0);
    assert.ok(pending.checks.every((c: any) => !c.ok));
    assert.equal(pending.modules, undefined);
    await probe(f.env, Date.now(), f.fetcher);
    const verified = await status();
    assert.equal(verified.checkedRelease, 'b456def');
    assert.ok(verified.checkedAt > 0);
    assert.ok(verified.checks.every((c: any) => c.ok));
  } finally { f.sqlite.close(); }
});

test('monitor API rejects unauthorized probes and telemetry abuse without persisting inputs', async () => {
  const f = fixture();
  const post = (path: string, value: unknown, origin = f.env.SITE_URL) => new Request(`${f.env.SITE_URL}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  try {
    assert.equal((await worker.fetch(post('/api/probe', {}), f.env)).status, 401);
    assert.equal((await worker.fetch(post('/api/metrics', {}, 'https://other.test'), f.env)).status, 403);
    assert.equal((await worker.fetch(post('/api/metrics', { name: 'LCP', value: 30, release: f.env.RELEASE, secret: 'never-store' }), f.env)).status, 400);
    assert.equal((await worker.fetch(post('/api/metrics', { name: 'LCP', value: 30, release: 'old' }), f.env)).status, 400);
    assert.equal((await worker.fetch(post('/api/metrics', { name: 'LCP', value: 30, release: f.env.RELEASE }), f.env)).status, 204);
    const saved = f.sqlite.prepare('SELECT * FROM vitals').all();
    assert.equal(saved.length, 1); assert.equal(saved[0].samples, 1);
    f.env.RUM_LIMITER = { limit: async () => ({ success: false }) } as RateLimit;
    assert.equal((await worker.fetch(post('/api/metrics', { name: 'LCP', value: 30, release: f.env.RELEASE }), f.env)).status, 429);
  } finally { f.sqlite.close(); }
});

test('webhook delivery retries durable outbox without losing a failed event', async () => {
  const f = fixture(); f.env.ALERT_WEBHOOK = 'https://alerts.test';
  try {
    f.sqlite.prepare('INSERT INTO alert_outbox(payload) VALUES(?)').run('{"event":{"name":"rpc","kind":"alert"}}');
    await deliverAlerts(f.env, (async () => new Response(null, { status: 503 })) as typeof fetch);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get()?.n, 1);
    await deliverAlerts(f.env, (async (_input, init) => { assert.ok((init?.headers as Record<string,string>)['Idempotency-Key']); return new Response(null, { status: 204 }); }) as typeof fetch);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get()?.n, 0);
  } finally { f.sqlite.close(); }
});


test('an overlapping or crashed probe retains persisted state and releases its lease on expiry', async () => {
  const f = fixture();
  try {
    await probe(f.env, Date.now(), f.fetcher);
    f.sqlite.prepare('INSERT INTO monitor_lock VALUES(1,?,?)').run('other-probe', Date.now() + 60000);
    const calls: string[] = [];
    await probe(f.env, Date.now(), (async () => { calls.push('unexpected'); throw Error(); }) as typeof fetch);
    assert.deepEqual(calls, []);
    f.sqlite.prepare('UPDATE monitor_lock SET until=0').run();
    const next = await probe(f.env, Date.now(), f.fetcher);
    assert.ok(next!.checks.every(c => c.ok));
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM monitor_lock').get()?.n, 0);
  } finally { f.sqlite.close(); }
});

import modular from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
test('first modular probe reports module failures without hiding healthy sponsorship', async () => {
  const f = fixture();
  const fetcher = (async (input: any, init?: RequestInit) => {
    if (String(input).startsWith(f.env.SITE_URL)) return f.fetcher(input, init);
    const req = JSON.parse(init!.body as string);
    if (req.method === 'aztec_getContract' && req.params[0] === f.env.REGISTRY)
      return Response.json({ result: { currentContractClassId: modular.extended.classId } });
    if (req.method === 'aztec_getPublicStorageAt' && req.params[1] === f.env.REGISTRY)
      return new Response(null, { status: 503 });
    return f.fetcher(input, init);
  }) as typeof fetch;
  try {
    const state = await probe(f.env, Date.now(), fetcher);
    assert.equal(state.checks.length, 9);
    for (const name of ['registrar', 'resolver']) assert.equal(state.checks.find(c => c.name === name)?.ok, false);
    for (const name of ['registry', 'sponsor', 'balance']) assert.equal(state.checks.find(c => c.name === name)?.ok, true);
  } finally { f.sqlite.close(); }
});
test('V6 module monitor tracks tiered deployment bindings and rejects a foreign resolver', async () => {
  const f=fixture(), start=Date.now();
  const hex=(v:bigint)=>`0x${v.toString(16).padStart(64,'0')}`;
  f.env.REGISTRY=hex(1n);
  let registrar=2n, administrator=7n, binding=1n, classId=modular.v6.classId;
  const fetcher=(async(input:any,init?:RequestInit)=>{
    if(String(input).startsWith(f.env.SITE_URL)) return f.fetcher(input,init);
    const req=JSON.parse(init!.body as string), [address]=req.params;
    if(req.method==='aztec_getContract' && address!==f.env.SPONSORED_FPC) return Response.json({result:{currentContractClassId:address===f.env.REGISTRY?classId:address===hex(13n)?modular.resolver.classId:address===hex(5n)?modular.registrarTiered.classId:modular.registrar.classId}});
    if(req.method==='aztec_getPublicStorageAt' && req.params[1]!==metadata.feeJuice){
      const [,a,s]=req.params, slot=BigInt(s); let value=0n;
      const values=new Map<bigint,bigint>();
      const put=(base:string, items:bigint[])=>items.forEach((v,i)=>values.set(BigInt(base)+BigInt(i),v));
      if(a===f.env.REGISTRY){put(modular.v6.storage.modules,[registrar,13n,1n]);put(modular.v6.storage.administrator,[administrator]);}
      else if(a===hex(13n)) put(modular.resolver.storage.registry,[binding]);
      else put(modular.registrar.storage.registry,[1n]);
      value=values.get(slot)??0n;return Response.json({result:hex(value)});
    }
    return f.fetcher(input,init);
  }) as typeof fetch;
  try {
    const initial=await probe(f.env,start,fetcher);assert.equal(initial.checks.length,9);assert.ok(initial.checks.every(c=>c.ok));
    registrar=4n;
    const changed=await probe(f.env,start+1,fetcher);assert.equal(changed.modules?.registrar,hex(4n));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind='changed'").get()?.n,1);
    await probe(f.env,start+2,fetcher);assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind='changed'").get()?.n,1);
    registrar=5n;
    const tiered=await probe(f.env,start+2,fetcher);assert.equal(tiered.checks.find(c=>c.name==='registrar')?.ok,true);
    registrar=4n;await probe(f.env,start+2,fetcher);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind='changed'").get()?.n,3);
    administrator=8n;
    const handoff=await probe(f.env,start+2,fetcher);assert.equal(handoff.modules?.administrator,hex(8n));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE kind='changed'").get()?.n,4);
    binding=99n;
    for(let i=3;i<6;i++) await probe(f.env,start+i,fetcher);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE name='resolver' AND kind='alert'").get()?.n,1);
    classId='0xunknown'; const unsupported=await probe(f.env,start+6,fetcher);
    assert.equal(unsupported.checks.find(c=>c.name==='registry')?.ok,false);
    assert.equal(unsupported.checks.find(c=>c.name==='registrar')?.ok,false);
    const data=await (await worker.fetch(new Request(`${f.env.SITE_URL}/api/status`),f.env)).json() as any;
    assert.equal(data.modules.registrar,hex(4n));assert.ok(data.incidents.some((e:any)=>e.kind==='changed'));
  } finally { f.sqlite.close(); }
});

test('status exposes supported events while preserving retired event history in storage', async () => {
  const f=fixture();
  try {
    await probe(f.env,Date.now(),f.fetcher);
    for (const name of ['rpc','modules','retired-check'])
      f.sqlite.prepare("INSERT INTO incidents(name,kind,at) VALUES(?,?,?)").run(name,'changed',Date.now());
    const data=await (await worker.fetch(new Request(`${f.env.SITE_URL}/api/status`),f.env)).json() as any;
    assert.deepEqual(data.incidents.map((item:any)=>item.name).sort(),['modules','rpc']);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM incidents WHERE name='retired-check'").get()?.n,1);
  } finally {f.sqlite.close();}
});

test('review fixes: constant-time token check and bounded body reads', async () => {
  assert.equal(await tokenMatches('Bearer a', 'Bearer a'), true);
  assert.equal(await tokenMatches('Bearer b', 'Bearer a'), false);
  assert.equal(await tokenMatches(null, 'Bearer '), false);
  assert.equal(await readBounded(new Request('https://x', { method: 'POST', body: 'x'.repeat(512) }), 512), 'x'.repeat(512));
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(200)); c.close(); } });
  assert.equal(await readBounded(new Request('https://x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), 512), undefined);
});

test('review fixes: unset RELEASE is refused instead of mislabelled', async () => {
  const f = fixture(); f.env.RELEASE = '';
  const r = await worker.fetch(new Request('https://ans.test/api/status'), f.env);
  assert.equal(r.status, 503);
  await assert.rejects(probe(f.env, Date.now(), f.fetcher), /RELEASE is not set/);
});

test('review fixes: FPC metadata drift is reported on sponsor, not as an RPC outage', async () => {
  const f = fixture(); f.env.SPONSORED_FPC = '0xdrift';
  const state = (await probe(f.env, Date.now(), f.fetcher))!;
  const by = Object.fromEntries(state.checks.map(c => [c.name, c]));
  assert.equal(by.rpc.ok, true);
  assert.equal(by.sponsor.ok, false); assert.match(by.sponsor.detail, /metadata/);
  assert.notEqual(by.registry.detail, 'RPC unavailable');
});

test('review fixes: alert outbox is bounded while the webhook fails', async () => {
  const f = fixture(); f.env.ALERT_WEBHOOK = 'https://hook.test';
  for (let i = 0; i < ALERT_OUTBOX_MAX + 30; i++) f.sqlite.prepare('INSERT INTO alert_outbox(payload) VALUES(?)').run('{}');
  await deliverAlerts(f.env, (async () => new Response(null, { status: 500 })) as typeof fetch);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS n FROM alert_outbox').get() as { n: number }).n, ALERT_OUTBOX_MAX);
});

test('review fixes: Worker configs agree with the deployment manifest', () => {
  assert.deepEqual(deploymentConfigMismatches(), []);
});

test('UX: direct app paths redirect to hash routes, other paths fall through', async () => {
  assert.equal(appRedirect(new URL('https://ans.test/docs')), 'https://ans.test/#/docs');
  assert.equal(appRedirect(new URL('https://ans.test/docs/pricing/')), 'https://ans.test/#/docs/pricing');
  assert.equal(appRedirect(new URL('https://ans.test/favicon.ico')), 'https://ans.test/favicon.svg');
  assert.equal(appRedirect(new URL('https://ans.test/unknown')), undefined);
  assert.equal(appRedirect(new URL('https://ans.test/docs/a/b')), undefined);
  const f = fixture();
  const r = await worker.fetch(new Request('https://ans.test/status'), f.env);
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'https://ans.test/#/status');
});

test('fee-juice monitor skips FPC reads and marks unconfigured operator N/A without false alarms', async () => {
  const f = fixture(); f.env.FEE_PAYMENT = 'fee-juice'; delete f.env.SPONSORED_FPC; f.env.NETWORK_LABEL = 'mainnet';
  const calls: string[] = [];
  const fetcher = (async (input: any, init?: RequestInit) => {
    if (init?.body) { const req = JSON.parse(String(init.body)); calls.push(req.method); if (req.method === 'aztec_getContract') assert.equal(req.params[0], f.env.REGISTRY); assert.notEqual(req.method, 'aztec_getPublicStorageAt'); }
    return f.fetcher(input, init);
  }) as typeof fetch;
  try {
    const state = await probe(f.env, Date.now(), fetcher);
    assert(state.checks.every(c => c.ok));
    assert.deepEqual(state.checks.find(c => c.name === 'sponsor'), { name: 'sponsor', ok: true, detail: 'N/A · users pay own Fee Juice' });
    assert.deepEqual(state.checks.find(c => c.name === 'balance'), { name: 'balance', ok: true, detail: 'N/A · operator undecided' });
    assert.match(state.checks.find(c => c.name === 'chain')!.detail, /^mainnet/);
  } finally { f.sqlite.close(); }
});
test('fee-juice monitor enforces operator watermark at its precomputed slot', async () => {
  const f = fixture(); Object.assign(f.env, { FEE_PAYMENT: 'fee-juice', OPERATOR: 'public-operator', OPERATOR_BALANCE_SLOT: '0x' + '1'.repeat(64), OPERATOR_LOW_WATERMARK: '100' });
  let balance = '99';
  const fetcher = (async (input: any, init?: RequestInit) => {
    if (init?.body) { const req = JSON.parse(String(init.body)); if (req.method === 'aztec_getPublicStorageAt') { assert.deepEqual(req.params, [100, metadata.feeJuice, f.env.OPERATOR_BALANCE_SLOT]); return Response.json({ result: balance }); } }
    return f.fetcher(input, init);
  }) as typeof fetch;
  try {
    assert.equal((await probe(f.env, Date.now(), fetcher)).checks.find(c => c.name === 'balance')!.ok, false);
    balance = '100'; assert.equal((await probe(f.env, Date.now(), fetcher)).checks.find(c => c.name === 'balance')!.ok, true);
    f.env.OPERATOR_LOW_WATERMARK = 'UNDECIDED'; assert.equal((await probe(f.env, Date.now(), fetcher)).checks.find(c => c.name === 'balance')!.ok, false);
  } finally { f.sqlite.close(); }
});
