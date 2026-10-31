// Real public reads. Delay only the fee-policy response; no wallet signatures or broadcasts.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import deployment from '../../deployments/testnet.json' with { type: 'json' };

const base = process.env.BASE ?? 'http://127.0.0.1:5284';
const name = process.env.NAME ?? deployment.exampleName;
const registrar = process.env.REGISTRAR ?? deployment.registrar;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const results = [];
try {
  for (const delayFeePolicy of [false, true]) {
    const page = await browser.newPage(), errors = [], requested = new Set(), held = [];
    let broadcasts = 0, policyReads = 0, holdPolicy = delayFeePolicy;
    const policyPending = Promise.withResolvers();
    await page.setCacheEnabled(false);
    await page.setBypassServiceWorker(true);
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: 200000, uploadThroughput: 200000, latency: 150 });
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      requested.add(request.url());
      const post = request.postData() ?? '';
      if (/(?:aztec|node)_sendTx/.test(post)) { broadcasts++; void request.abort(); return; }
      if (['/api/vitals', '/api/metrics'].includes(new URL(request.url()).pathname)) { void request.respond({ status: 204 }); return; }
      const body = /^[\[{]/.test(post) ? JSON.parse(post) : undefined;
      const calls = Array.isArray(body) ? body : body ? [body] : [];
      const readsPolicy = calls.some(rpc => /^(?:aztec|node)_getPublicStorageAt$/.test(rpc.method) && rpc.params[1] === registrar && BigInt(rpc.params[2]) >= 3n && BigInt(rpc.params[2]) <= 6n);
      if (readsPolicy) policyReads++;
      if (holdPolicy && readsPolicy) {
        held.push(request); policyPending.resolve(); return;
      }
      void request.continue();
    });
    try {
      const started = Date.now();
      await page.goto(`${base}/#/name/${encodeURIComponent(name)}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      const domMs = Date.now() - started;
      await page.waitForSelector('#wallet-menu', { timeout: 90000 });
      const shellMs = Date.now() - started;
      await page.waitForFunction(() => document.body.innerText.includes('Active'), { timeout: 90000 });
      const activeMs = Date.now() - started;
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /\.(js|css)(\?|$)/.test(r.name)).map(r => ({ name: r.name.split('/').pop(), encodedBytes: r.encodedBodySize })));
      assert.equal(policyReads, 0, 'Public startup must not fetch the payment configuration');
      if (delayFeePolicy) {
        await client.send('Network.emulateNetworkConditions', { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 });
        await page.evaluate(() => { location.hash = '/register'; });
        const timeout = setTimeout(() => policyPending.reject(new Error('Fee-policy fixture intercepted no configuration read')), 60000);
        try { await policyPending.promise; } finally { clearTimeout(timeout); }
        assert.equal(await page.evaluate(() => document.body.innerText.includes('Registration fee for one year:')), false, 'An unknown fee is not displayed as free');
        await page.evaluate(name => { location.hash = `/name/${name}`; }, name);
        await page.waitForFunction(() => document.body.innerText.includes('Active'), { timeout: 15000 });
        holdPolicy = false;
        await Promise.all(held.map(request => request.continue()));
      }
      await page.waitForFunction(() => document.querySelector('#wallet-menu > summary')?.getAttribute('aria-disabled') === 'false', { timeout: 60000 });
      assert.equal([...requested].some(url => /barretenberg|\.wasm(?:$|\?)/.test(url)), false, 'Public resolution must not fetch the proving runtime');
      assert.deepEqual(errors, []);
      assert.equal(broadcasts, 0);
      const result = { checkedAt: new Date().toISOString(), base, name, cold: true, downloadBytesPerSecond: 200000, latencyMs: 150, delayFeePolicy, feePolicyRemovedFromStartup: true, domMs, shellMs, activeMs, provingRuntimeDeferred: true, broadcasts, errors, resources };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      holdPolicy = false;
      await Promise.allSettled(held.filter(request => !request.isInterceptResolutionHandled()).map(request => request.continue()));
      await page.close();
    }
  }
  const page = await browser.newPage(), errors = [];
  let broadcasts = 0, storageReads = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const post = request.postData() ?? '';
    if (/(?:aztec|node)_sendTx/.test(post)) { broadcasts++; await request.abort(); return; }
    if (/_getPublicStorageAt/.test(post)) storageReads++;
    if (/_getNodeInfo/.test(post)) {
      const response = await fetch(request.url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: post, signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      for (const call of body) if (call.result?.l1ChainId !== undefined) call.result.l1ChainId = 1;
      await request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    } else await request.continue();
  });
  await page.goto(`${base}/#/name/${encodeURIComponent(name)}`);
  await page.waitForFunction(() => document.body.innerText.includes('Configuration error'), { timeout: 60000 });
  assert.equal(await page.$eval('#wallet-menu > summary', e => e.getAttribute('aria-disabled')), 'true');
  assert.equal(await page.$('form button:disabled') !== null, true);
  assert.equal(await page.$('.status-badge'), null);
  assert.equal(storageReads, 0, 'Wrong network must not expose a public reader');
  assert.equal(broadcasts, 0);
  assert.deepEqual(errors, []);
  const result = { checkedAt: new Date().toISOString(), wrongNetworkFixture: true, readerBlocked: true, walletBlocked: true, storageReads, broadcasts, errors };
  results.push(result); console.log(JSON.stringify(result));
  await page.close();
  if (process.env.ANS_RESOLUTION_REPORT) await writeFile(process.env.ANS_RESOLUTION_REPORT, JSON.stringify(results, null, 2) + '\n');
} finally { await browser.close(); }
