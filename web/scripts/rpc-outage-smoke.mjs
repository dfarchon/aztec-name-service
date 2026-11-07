// Synthetic public fixture only. Intercept outages/identity changes; never signs or broadcasts.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
const base = process.env.BASE ?? 'http://127.0.0.1:5292';
const rpc = process.env.NODE_URL ?? 'http://127.0.0.1:5291';
for (const url of [base, rpc]) assert.equal(new URL(url).hostname, '127.0.0.1');
assert.match(await (await fetch(rpc)).text(), /synthetic-v6-public-only/);
const output = process.env.OUT_DIR;
if (output) await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(30000);
page.setDefaultNavigationTimeout(60000);
let mode = 'healthy', broadcasts = 0, attempts = 0, outageElapsedMs;
const hosts = new Set(), errors = [], stages = [];
page.on('pageerror', error => errors.push(error.message));
await page.setRequestInterception(true);
page.on('request', async request => {
  try {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return void request.continue();
    if (url.hostname !== '127.0.0.1') return void request.abort();
    const data = request.postData() ?? '';
    if (/\b(?:aztec|node)_(?:sendTx|proveTx|sign)\b/.test(data)) {
      broadcasts++;
      return void request.abort();
    }
    if (url.origin !== rpc) return void request.continue();
    hosts.add(url.origin);
    attempts++;
    if (mode === 'outage') return void request.abort('failed');
    if (mode !== 'healthy' && data.includes('aztec_getNodeInfo')) {
      const response = await fetch(request.url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data });
      const payload = await response.json();
      for (const reply of Array.isArray(payload) ? payload : [payload]) {
        if (reply.result?.l1ChainId) {
          if (mode === 'chain') reply.result.l1ChainId = 1;
          else reply.result.rollupVersion = 1;
        }
      }
      return void request.respond({ status: 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(payload) });
    }
    void request.continue();
  } catch (error) { errors.push(error.message); if (!request.isInterceptResolutionHandled()) void request.abort(); }
});
const stage = async label => {
  const state = await page.evaluate(() => {
    const s = window.rpcSession.getSession();
    return { status: s.status, reader: !!s.reader, ctx: !!s.ctx, hash: s.records?.txs[0]?.txHash };
  });
  stages.push({ label, ...state });
  if (output) await page.screenshot({ path: resolve(output, `${label}.png`) });
  console.log(`PASS ${label}: ${JSON.stringify(state)}`);
};
const reconnect = async () => {
  await page.evaluate(() => window.rpcSession.boot());
  await page.waitForFunction(() => window.rpcSession.getSession().status === 'ready');
  await page.waitForSelector('.status-badge');
  assert.equal(await page.$('.banner.err'), null);
  assert.equal(await page.$eval('form button', button => button.disabled), false);
  assert.equal(await page.evaluate(() => window.rpcSession.getSession().ctx === window.originalCtx), true);
};
const refused = async () => {
  const result = await page.evaluate(async () => {
    const s = window.rpcSession;
    let walletCalls = 0;
    const wallet = { getAccounts: async () => { walletCalls++; return []; } };
    const errors = [];
    for (const run of [() => s.selectAccount(window.originalCtx.account),
      () => s.connectExternal(wallet, { disconnect: async () => {} }), () => s.createAccount('refused')]) {
      try { await run(); } catch (e) { errors.push(e.message); }
    }
    return { errors, walletCalls, allowed: s.liveWritesAllowed(s.getSession().status) };
  });
  assert.equal(result.walletCalls, 0);
  assert.equal(result.errors.length, 3);
  assert.equal(result.allowed, false);
  assert.equal(await page.$eval('form button', button => button.disabled), true);
  assert.equal(await page.$('.status-badge'), null);
};
try {
  await page.goto(`${base}/#/name/alice`);
  await page.waitForSelector('.status-badge');
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    if (!path) throw new Error('Vite session module not found');
    const session = window.rpcSession = await import(path);
    const reader = session.getSession().reader;
    const account = reader.registry;
    await session.connectExternal({
      getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }),
      getAccounts: async () => [{ alias: 'Read-only outage fixture', item: account }],
      getContractMetadata: async () => ({}), registerContract: async () => {},
    }, { disconnect: async () => {}, onDisconnect: () => () => {} });
    window.originalCtx = session.getSession().ctx;
    await session.updateRecords(r => ({ ...r, txs: [{ id: 'fixture', label: 'Already confirmed fixture',
      at: Date.now(), txHash: '0x' + 'a'.repeat(64), state: 'confirmed' }] }));
  });
  await stage('healthy');
  mode = 'outage';
  const started = Date.now(), before = attempts;
  // Exercise the actual node transport via a lookup, without calling boot or mutating session state.
  await page.click('form button');
  // Invalidate the query while its read is failing: its catch must not supply outage feedback.
  await page.type('#name-query', 'x');
  await page.waitForFunction(() => window.rpcSession.getSession().status === 'offline');
  await page.waitForFunction(() => document.body.innerText.includes('Node unavailable') && document.body.innerText.includes('Connection lost. Retrying'));
  await page.waitForSelector('[data-query-unavailable]');
  assert.match(await page.$eval('[data-query-unavailable]', el => el.innerText), /Node unavailable/);
  assert.equal(await page.$('[data-query-error]'), null, 'outage explanation survives invalidated per-query errors');
  outageElapsedMs = Date.now() - started;
  assert(outageElapsedMs < 12000, 'read failure withdraws writes within the existing finite retry budget');
  assert(attempts - before >= 4);
  await refused();
  console.log('PASS: invalidated lookup still explains node unavailability; stale result and write controls are absent');
  await stage('outage');
  await page.focus('#name-query');
  await page.keyboard.press('Backspace');
  mode = 'healthy';
  // Recovery runs through the real retry watcher, without a manual boot or reloading the page.
  await page.waitForFunction(() => window.rpcSession.getSession().status === 'ready');
  await page.waitForSelector('.status-badge');
  assert.equal(await page.evaluate(() => window.rpcSession.getSession().ctx === window.originalCtx), true);
  assert.equal(await page.$('.banner.err'), null);
  await stage('automatic-recovery');
  for (const mismatch of ['chain', 'rollup']) {
    mode = mismatch;
    await page.evaluate(() => window.rpcSession.boot());
    await page.waitForFunction(() => window.rpcSession.getSession().status === 'misconfigured');
    await page.waitForFunction(() => document.body.innerText.includes('Configuration error'));
    await refused();
    await stage(`${mismatch}-mismatch`);
    mode = 'healthy';
    await reconnect();
    await stage(`${mismatch}-recovery`);
  }
  assert.equal(broadcasts, 0);
  assert.deepEqual([...hosts], [rpc]);
  assert.deepEqual(errors, []);
  const hash = await page.evaluate(() => window.rpcSession.getSession().records.txs[0].txHash);
  assert.equal(hash, '0x' + 'a'.repeat(64));
  console.log('PASS: one RPC host; zero signing/broadcast attempts; saved receipt hash preserved; no runtime errors');
  if (output) await writeFile(resolve(output, 'rpc-outage.json'), JSON.stringify({ stages, hosts: [...hosts], outageElapsedMs,
    invalidatedQueryOutageFeedback: true, broadcasts, attempts, errors }, null, 2));
} finally { await browser.close(); }
