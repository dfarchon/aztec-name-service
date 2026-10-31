// Production assets and headers, real wallet-sdk transport, read-only wallet; no keys or transactions.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { WalletSchema } from '@aztec-labs/aztec.js/wallet';
import { createSafeJsonRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import { createServer as createViteServer } from 'vite';
import puppeteer from 'puppeteer-core';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const deployment = JSON.parse(
  await readFile(new URL('../../deployments/testnet.json', import.meta.url), 'utf8'),
);
const appOrigin = 'http://127.0.0.1:5290',
  walletOrigin = 'http://127.0.0.1:5291';
const walletUrl = `${walletOrigin}/scripts/fixtures/external-wallet.html`;
const account = AztecAddress.fromBigIntUnsafe(42n);
let broadcasts = 0;
const wallet = new Proxy(
  {
    getAccounts: async () => [{ alias: 'CSP review account', item: account }],
    getChainInfo: async () => ({
      chainId: new Fr(BigInt(deployment.chainId)),
      version: new Fr(BigInt(deployment.rollupVersion)),
    }),
    registerContract: async () => {},
  },
  {
    get: (target, key) =>
      key in target
        ? target[key]
        : async () => {
            if (key === 'sendTx') broadcasts++;
            throw new Error('Read-only CSP wallet refuses signing and transaction submission');
          },
  },
);

let rpcServer, walletServer, appServer, browser;
try {
  const rpc = createSafeJsonRpcServer(wallet, WalletSchema, {
    corsAllowedOrigins: [walletOrigin],
    corsAllowedHeaders: ['content-type', 'x-ans-wallet-token'],
    maxBodySizeBytes: '8mb',
  });
  rpcServer = createServer(rpc.getApp().callback());
  rpcServer.listen(0, '127.0.0.1');
  await once(rpcServer, 'listening');
  const cfg = {
    rpc: `http://127.0.0.1:${rpcServer.address().port}`,
    token: 'readonly-csp-fixture',
    appOrigin,
    chainId: deployment.chainId,
    rollupVersion: deployment.rollupVersion,
  };
  walletServer = await createViteServer({
    root: resolve(repository, 'web'),
    cacheDir: resolve(repository, 'web/node_modules/.vite-security-wallet'),
    plugins: [
      {
        name: 'security-wallet-config',
        transformIndexHtml(html, context) {
          return context.path.includes('external-wallet')
            ? html.replace(
                '<script type="module"',
                `<script>window.__ANS_WALLET_TEST_CONFIG__=${JSON.stringify(cfg)}</script><script type="module"`,
              )
            : html;
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port: 5291,
      strictPort: true,
      headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' },
    },
  });
  await walletServer.listen();
  execFileSync(process.execPath, ['scripts/build-testnet.mjs'], {
    cwd: repository,
    env: { ...process.env, ANS_PUBLIC_WALLET_URLS: walletUrl },
    stdio: 'inherit',
  });
  const dist = resolve(repository, 'web/dist');
  const headersFile = await readFile(resolve(dist, '_headers'), 'utf8');
  const headers = {};
  for (const line of headersFile.split('\n').slice(1)) {
    if (!line.startsWith('  ')) break;
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  assert.ok(headers['Content-Security-Policy'].includes(`frame-src 'self' ${walletOrigin}`));
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
  };
  appServer = createServer(async (req, res) => {
    if (req.url === '/api/metrics') {
      res.writeHead(204);
      res.end();
      return;
    }
    const pathname = new URL(req.url, appOrigin).pathname;
    const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(dist + sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const bytes = await readFile(path);
      res.writeHead(200, {
        ...headers,
        'Content-Type': types[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  appServer.listen(5290, '127.0.0.1');
  await once(appServer, 'listening');
  browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage(),
    errors = [],
    checks = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const pass = (name) => {
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  const click = async (label) => {
    await page.waitForFunction(
      (label) =>
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent.trim() === label && !button.disabled,
        ),
      { timeout: 60000 },
      label,
    );
    for (const button of await page.$$('button'))
      if (await button.evaluate((element, value) => element.textContent.trim() === value, label)) {
        await button.click();
        return;
      }
  };
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(walletUrl);
  await page.waitForFunction(() => document.body.dataset.walletReady === 'true', {
    timeout: 180000,
  });
  const response = await page.goto(`${appOrigin}/#/name/${deployment.exampleName}`);
  assert.equal(response.headers()['content-security-policy'], headers['Content-Security-Policy']);
  await page.waitForFunction(
    () =>
      document.querySelector('#wallet-menu > summary')?.getAttribute('aria-disabled') === 'false',
    { timeout: 90000 },
  );
  pass('Production build boots with its emitted CSP and isolation headers');
  await page.evaluate(
    (url) => {
      window.deniedFrames = [];
      addEventListener('securitypolicyviolation', (event) => {
        if (event.violatedDirective === 'frame-src') window.deniedFrames.push(event.blockedURI);
      });
      const frame = document.createElement('iframe');
      frame.src = url;
      frame.id = 'unconfigured-wallet';
      document.body.append(frame);
    },
    walletUrl.replace('127.0.0.1', 'localhost'),
  );
  await page.waitForFunction(() => window.deniedFrames.length === 1);
  await page.$eval('#unconfigured-wallet', (frame) => frame.remove());
  pass('An unconfigured cross-origin frame is blocked');
  await page.locator('#wallet-menu > summary').click();
  await click('ANS Test Wallet');
  const matchAndConfirm = async () => {
    const element = await page.waitForSelector('.web-wallet-host iframe');
    const frame = await element.contentFrame();
    assert.ok(frame);
    await frame.waitForFunction(() => !!document.querySelector('#verification')?.textContent);
    const emoji = await frame.$eval('#verification', (element) => element.textContent);
    await page.waitForFunction((value) => document.body.innerText.includes(value), {}, emoji);
    await click('Confirm and connect');
    await page.waitForSelector('select[aria-label="Wallet account"]', { timeout: 60000 });
    assert.equal(
      await page.$eval('select[aria-label="Wallet account"]', (select) => select.value),
      account.toString(),
    );
  };
  await matchAndConfirm();
  pass('Configured wallet discovery, encrypted channel and account authorization succeed');
  await page.$eval('#wallet-menu', (element) => {
    element.open = true;
  });
  await click('Disconnect wallet');
  await click('Find wallets again');
  await click('ANS Test Wallet');
  await click('Cancel');
  await click('ANS Test Wallet');
  await matchAndConfirm();
  pass('Disconnect, cancelled connection and retry recover under the same CSP');
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  pass('Wallet account controls fit a mobile viewport');
  assert.deepEqual(errors, []);
  assert.equal(broadcasts, 0);
  pass('No browser runtime errors, signing or transaction broadcasts');
  const output = process.env.ANS_SECURITY_REPORT_DIR ?? '/tmp/ans-security-smoke';
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, 'browser.json'),
    JSON.stringify(
      { checks, errors, broadcasts, csp: headers['Content-Security-Policy'] },
      null,
      2,
    ) + '\n',
  );
  console.log(`ALL ${checks.length} SECURITY BROWSER CHECKS PASSED`);
  const docs = await promisify(execFile)(process.execPath, ['web/scripts/docs-smoke.mjs'], {
    cwd: repository,
    env: { ...process.env, BASE: appOrigin, ANS_DOCS_REPORT_DIR: resolve(output, 'docs') },
    timeout: 180000,
  });
  console.log(docs.stdout);
} catch (error) {
  console.error('Security browser acceptance failed:', error);
  if (browser)
    for (const page of await browser.pages())
      console.error(
        'Page diagnostics:',
        page.url(),
        await page
          .evaluate(() => document.body?.innerText?.slice(-1600))
          .catch(() => 'Page unavailable'),
      );
  throw error;
} finally {
  await browser?.close();
  await walletServer?.close();
  for (const server of [appServer, rpcServer])
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
}
