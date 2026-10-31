import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';

/** Inspect the built independent consumer, not the workspace app. Public reads only; broadcasts are blocked. */
export async function checkConsumerBrowser(cwd) {
  const dist = resolve(cwd, 'browser/dist');
  const budget = JSON.parse(await readFile(resolve(dist, 'bundle-budget.json'), 'utf8'));
  assert.equal(budget.executionArtifactsDeferred, true);
  assert.ok(budget.executionArtifactChunks.length > 0);
  const initialBytes = await Promise.all(budget.chunks.map(name => readFile(resolve(dist, name))));
  assert.equal(initialBytes.reduce((total, bytes) => total + bytes.length, 0), budget.rawBytes);
  assert.equal(initialBytes.reduce((total, bytes) => total + gzipSync(bytes).length, 0), budget.gzipBytes);
  assert.ok(budget.gzipBytes <= budget.maxGzipBytes);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(dist + sep)) { response.writeHead(403).end(); return; }
      const bytes = await readFile(path);
      response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args:['--disable-background-timer-throttling'] });
    const page = await browser.newPage(), errors = []; let broadcasts = 0;
    const requested = new Set();
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      requested.add(new URL(request.url()).pathname.slice(1));
      if (/(?:aztec|node)_sendTx/.test(request.postData() ?? '')) { broadcasts++; void request.abort(); }
      else void request.continue();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Deployment connected.'), { timeout: 60000 });
    for (const chunk of budget.chunks) assert.ok(requested.has(chunk), `Initial chunk was not loaded: ${chunk}`);
    for (const chunk of budget.executionArtifactChunks) assert.equal(requested.has(chunk), false, `Execution artifact loaded before wallet action: ${chunk}`);
    await page.click('#discover');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('No compatible wallet found.'), { timeout: 60000 });
    for (const chunk of budget.executionArtifactChunks) assert.equal(requested.has(chunk), false, `Wallet discovery loaded execution artifact: ${chunk}`);
    assert.equal(await page.$eval('#unlock', button => button.disabled), true);
    assert.equal(await page.$eval('#prepare', button => button.disabled), true);
    assert.equal(await page.$eval('#finish', button => button.disabled), true);
    assert.equal([...requested].some(path => /barretenberg|\.wasm(?:$|\?)/.test(path)), false, 'Public reads and wallet discovery must not load the proving runtime');
    assert.deepEqual(errors, []); assert.equal(broadcasts, 0);
    const result = { independentBrowser: true, liveDeployment: true, walletDiscovery: true, unsignedPaymentDisabled: true, provingRuntimeDeferred: true, initialGzipBytes: budget.gzipBytes, maxGzipBytes: budget.maxGzipBytes, executionArtifactsDeferred: true, broadcasts, errors };
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const pages=await browser?.pages();
    console.error(JSON.stringify({consumerPage:await pages?.at(-1)?.evaluate(()=>document.body.innerText).catch(()=>''),failure:String(error)}));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
