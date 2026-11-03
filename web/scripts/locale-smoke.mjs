// Read-only English presentation and state-preservation checks. This fixture never signs or sends transactions.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base = process.env.BASE ?? 'http://127.0.0.1:5195';
const name = process.env.NAME ?? 'ans-muyxsdch';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const wait = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 90000 }, text);
let checks = 0;
const pass = message => console.log(`PASS ${++checks}: ${message}`);
try {
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' }));
  await page.goto(base);
  await wait('Name search');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await page.type('#name-query', 'Invalid_name!');
  await wait('Invalid name format');
  await page.click('.theme-toggle');
  await wait('Invalid name format');
  assert.equal(await page.$eval('#name-query', input => input.value), 'Invalid_name!');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  pass('English on a non-English browser; changing theme preserves input and validation');
  await page.reload();
  await wait('Name search');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await page.$('select[aria-label=Language]'), null);
  pass('English and the selected theme persist on refresh');
  for (const width of [1280, 768, 390, 320]) {
      await page.setViewport({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} overflows`);
      assert.ok(await page.$eval('.theme-toggle', el => el.getBoundingClientRect().height >= 44));
      if (width === 320) await page.screenshot({ path: `/tmp/ans-english-320.png`, fullPage: true });
  }
  pass('English fits desktop and mobile with accessible appearance controls');
  await page.goto(`${base}/#/name/${name}`);
  await wait('Registered · Active');
  const before = await page.$$eval('main .copy-value code', els => els.map(el => el.textContent));
  const dateBefore = await page.$eval('main dd', el => el.textContent);
  await page.click('.theme-toggle');
  assert.deepEqual(await page.$$eval('main .copy-value code', els => els.map(el => el.textContent)), before);
  assert.equal(await page.$eval('main dd', el => el.textContent), dateBefore);
  pass('lookup keeps English dates, names and full addresses unchanged across theme changes');
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    const session = await import(path); window.localeSession = session;
    const reader = session.getSession().reader;
    const account = reader.registry;
    const snap = await reader.snapshot('checkpointed');
    reader.snapshot = async () => snap;
    reader.getConfig = async () => ({ feeToken: account.constructor.ZERO, treasury: account.constructor.ZERO, annualPrice: 0n, priceVersion: 1 });
    reader.getName = async () => ({ generation: 0, revision: 0, expiresAt: 0n, owner: account.constructor.ZERO });
    await session.connectExternal({ getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }), getAccounts: async () => [{ alias: 'Search', item: account }], getContractMetadata: async () => ({}), registerContract: async () => {} }, { disconnect: async () => {}, onDisconnect: () => () => {} });
    window.originalLocaleContext = session.getSession().ctx;
    location.hash = '/register/locale-fixture';
  });
  await wait('Start registration');
  await page.select('main select', '3');
  await page.click('.fee-details summary');
  await page.click('.theme-toggle');
  await wait('Maximum fee');
  assert.equal(await page.$eval('main select', el => el.value), '3');
  assert.equal(await page.$eval('main input', el => el.value), 'locale-fixture');
  assert.equal(await page.$eval('.fee-details', el => el.open), true);
  assert.ok(await page.evaluate(() => window.localeSession.getSession().ctx === window.originalLocaleContext));
  await page.click('#wallet-menu > summary');
  assert.equal(await page.$eval('.wallet-popover select option', el => el.textContent), 'Search');
  pass('registration period, fee disclosure, wallet context and user alias survive appearance changes');
  await page.evaluate(() => { location.hash = '/status'; });
  await wait('Service status');
  pass('lazy-loaded status page renders in English');
  assert.deepEqual(errors, []);
  pass('no browser runtime errors');
  console.log(`ALL ${checks} ENGLISH PRESENTATION CHECKS PASSED`);
} catch (error) { console.error(error); console.error(await page.evaluate(() => document.body.innerText).catch(() => "Page unavailable")); throw error; }
finally { await page.close(); await browser.close(); }
