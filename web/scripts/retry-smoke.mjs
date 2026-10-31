// Read-only UI regressions. Failure injection never calls a wallet or sends a transaction.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage();
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(60000);
const errors = [];
let broadcasts = 0;
page.on('pageerror', (error) => errors.push(error.message));
await page.setRequestInterception(true);
page.on('request', (request) => {
  if (/(?:aztec|node)_(?:sendTx|proveTx|sign)/.test(request.postData() ?? '')) {
    broadcasts++;
    void request.abort();
  } else void request.continue();
});
const base = process.env.BASE ?? 'http://localhost:5179';
const name = process.env.NAME ?? 'alice';
let checks = 0;
const pass = (label) => console.log(`PASS ${++checks}: ${label}`);
const wait = (text, selector = '[data-query-error]') =>
  page.waitForFunction(
    (text, selector) => document.querySelector(selector)?.innerText.includes(text),
    {},
    text,
    selector,
  );
const noAvailability = async () => {
  assert.equal(await page.$('.status-badge'), null);
  assert.equal(
    await page.$$eval('main button', (buttons) =>
      buttons.some((button) => ['Register name', '注册名字'].includes(button.textContent.trim())),
    ),
    false,
  );
};
try {
  await page.goto(`${base}/#/name/${encodeURIComponent(name)}`);
  // The public fixture supplies one active name (alice by default).
  await page.waitForFunction(
    () => document.querySelector('.status-badge')?.textContent === 'Registered · Active',
    { timeout: 60000 },
  );
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    if (!path) throw new Error('session module path not found; retry smoke requires Vite dev');
    const { getSession } = await import(path);
    const reader = getSession().reader;
    const original = reader.snapshot.bind(reader);
    const { makeRpcFetch } = await import('/src/rpc.ts');
    window.retryFixture = {
      reader,
      original,
      originalProtocol: reader.deployment.protocolVersion,
      attempts: 0,
      elapsed: 0,
    };
    const transport = makeRpcFetch(
      undefined,
      async (_url, init) => {
        window.retryFixture.attempts++;
        const request = JSON.parse(init.body);
        return Response.json({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: 30, message: 'Request timeout on the free plan' },
        });
      },
      {
        now: () => window.retryFixture.elapsed,
        random: () => 0.5,
        sleep: async (ms) => {
          window.retryFixture.elapsed += ms;
        },
      },
    );
    reader.snapshot = async () => {
      const { response } = await transport('http://127.0.0.1', {
        jsonrpc: '2.0',
        id: 17,
        method: 'aztec_getPublicStorageAt',
        params: [],
      });
      throw new Error(response.error.message, { cause: response.error });
    };
  });
  await page.click('form button');
  await wait('Automatically retried 3 times');
  assert.equal(await page.evaluate(() => window.retryFixture.attempts), 4);
  assert.equal(await page.evaluate(() => window.retryFixture.elapsed), 1050);
  await noAvailability();
  await page.waitForFunction(
    () => document.querySelector('[data-query-error] button')?.disabled === false,
  );
  pass('exhausted code 30 shows three automatic retries, a local retry button and no availability');
  assert.match(await page.$eval('footer', (el) => el.innerText), /Node connected · periodic check/);
  await wait('Node connection status is checked separately; this lookup failed.');
  pass('lookup failure is distinct from periodic node connection status');
  await page.evaluate(async () => {
    (await import('/src/i18n.ts')).setLocale('zh-CN');
  });
  await wait('节点暂时超时，已自动重试 3 次，请稍后重试。');
  assert.equal(await page.$eval('[data-query-error] button', (el) => el.innerText), '重试');
  assert.match(await page.$eval('footer', (el) => el.innerText), /节点已连接 · 定期检查/);
  pass('timeout feedback, count, retry action and connection status are translated');
  await page.evaluate(() => {
    window.retryFixture.reader.snapshot = window.retryFixture.original;
  });
  await page.click('[data-query-error] button');
  await wait('已注册 · 有效', '.status-badge');
  assert.equal(await page.$('[data-query-error]'), null);
  pass('manual retry succeeds and removes the previous error');
  await page.evaluate(async () => {
    (await import('/src/i18n.ts')).setLocale('en');
    window.retryFixture.reader.snapshot = async () => {
      throw new Error('fetch failed');
    };
  });
  await page.click('form button');
  await wait('Unable to read the network');
  await noAvailability();
  assert.ok(await page.$('[data-query-error] button'));
  assert.ok(
    !(await page.$eval('[data-query-error]', (el) => el.innerText)).includes(
      'Automatically retried',
    ),
  );
  pass('ordinary lookup failures also offer retry without inventing retry counts');
  await page.evaluate(() => {
    window.retryFixture.reader.snapshot = window.retryFixture.original;
    location.hash = '/docs/deployments';
  });
  await page.waitForSelector('.doc-deployment');
  const expected = await page.evaluate(() => window.retryFixture.reader.deployment.protocolVersion);
  if (expected >= 5)
    assert.equal(
      await page.$eval('.doc-deployment', (el) => [...el.querySelectorAll('dd')][2].textContent),
      `V${expected}`,
    );
  // Also exercise V6 rendering with the connected reader's verified capability field.
  await page.evaluate(() => {
    window.retryFixture.reader.deployment.protocolVersion = 6;
    location.hash = '/docs/tokens';
  });
  await wait('Getting test tokens', '.doc-article');
  const tokens = await page.$eval('.doc-article', (el) => el.innerText);
  assert.doesNotMatch(tokens, /TODO|待补充/);
  assert.match(tokens, /no public self-serve faucet/);
  pass('English token article explains the operator flow without TODO');
  await page.evaluate(async () => {
    (await import('/src/i18n.ts')).setLocale('zh-CN');
  });
  await wait('没有公开自助水龙头', '.doc-article');
  assert.doesNotMatch(await page.$eval('.doc-article', (el) => el.innerText), /TODO|待补充/);
  pass('Chinese token article explains the same funding boundary');
  await page.evaluate(async () => {
    (await import('/src/i18n.ts')).setLocale('en');
    location.hash = '/docs/deployments';
  });
  await page.waitForSelector('.doc-deployment');
  assert.equal(
    await page.$eval('.doc-deployment', (el) => [...el.querySelectorAll('dd')][2].textContent),
    'V6',
  );
  pass('Connected deployment renders V6 for protocol 6');
  assert.equal(broadcasts, 0);
  assert.deepEqual(errors, []);
  pass('read-only retry and documentation checks never broadcast or raise runtime errors');
  console.log(`ALL ${checks} RETRY/DOCS UI CHECKS PASSED`);
} finally {
  await page
    .evaluate(() => {
      const fixture = window.retryFixture;
      if (fixture) {
        fixture.reader.snapshot = fixture.original;
        fixture.reader.deployment.protocolVersion = fixture.originalProtocol;
      }
    })
    .catch(() => {});
  await browser.close();
}
