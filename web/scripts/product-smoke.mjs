// UI interactions and stale-response handling; no wallet approval or transaction is sent.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base = process.env.BASE ?? 'http://127.0.0.1:5195';
const name = process.env.NAME ?? 'ans-muyxsdch';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(`${base}/#/name/${name}`);
  await page.waitForSelector('[aria-label="Copy name"]', { timeout: 90000 });
  const top = await page.$eval('main', e => e.getBoundingClientRect().top);
  await page.click('#wallet-menu > summary');
  assert.equal(await page.$eval('#wallet-menu', e => e.open), true);
  assert.equal(await page.$eval('main', e => e.getBoundingClientRect().top), top);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#wallet-menu', e => e.open), false);
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#wallet-menu > summary')), true);
  console.log('PASS wallet panel does not shift content; Escape returns focus');
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewport({ width, height: 900 });
    await page.click('#wallet-menu > summary');
    const bounds = await page.$eval('.wallet-popover', e => ({ left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, viewport: innerWidth }));
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport, JSON.stringify(bounds));
    if (width === 320) await page.screenshot({ path: '/tmp/ans-wallet-panel-mobile.png', fullPage: true });
    await page.mouse.click(8, 850);
    assert.equal(await page.$eval('#wallet-menu', e => e.open), false);
  }
  console.log('PASS wallet panel fits all viewports and closes on outside interaction');
  await page.goto(`${base}/#/names`);
  await page.waitForFunction(() => document.querySelector('.empty-state button')?.disabled === false, { timeout: 90000 });
  await page.click('.empty-state button');
  assert.equal(await page.$eval('#wallet-menu', e => e.open), true);
  await page.keyboard.press('Escape');
  console.log('PASS disconnected portfolio offers a working wallet entry');
  await page.goto(`${base}/#/name/${name}`);
  await page.waitForSelector('[aria-label="Copy name"]', { timeout: 90000 });
  await page.type('#name-query', 'x');
  assert.equal(await page.$('[aria-label="Copy name"]'), null);
  console.log('PASS editing a query removes stale results and actions');
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    const { getSession } = await import(path);
    const reader = getSession().reader;
    reader.snapshot = async () => {
      window.queryStarted = true;
      await new Promise(resolve => { window.releaseQuery = resolve; });
      window.queryCompleted = true;
      throw new Error('Stale query failure');
    };
  });
  await page.click('form button');
  await page.waitForFunction(() => window.queryStarted);
  await page.type('#name-query', 'y');
  await page.evaluate(() => window.releaseQuery());
  await page.waitForFunction(() => window.queryCompleted);
  assert.equal(await page.$('main .card.err'), null);
  assert.equal(await page.$('[aria-label="Copy name"]'), null);
  console.log('PASS a superseded query cannot replace the current input with an error');
  assert.deepEqual(errors, []);
  console.log('PASS no browser runtime errors');
} finally { await browser.close(); }
