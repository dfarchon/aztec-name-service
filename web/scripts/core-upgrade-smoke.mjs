// Read-only browser fixtures. Actual V8 transactions are covered by test:upgrade, never by this script.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base = process.env.BASE ?? 'http://127.0.0.1:5198';
assert.equal(new URL(base).hostname, '127.0.0.1');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const page = await browser.newPage(), errors = []; let broadcasts = 0, count = 0;
page.on('pageerror', error => errors.push(error.message));
await page.setRequestInterception(true);
page.on('request', request => { if (request.postData()?.includes('sendTx')) { broadcasts++; void request.abort(); } else void request.continue(); });
const wait = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 90000 }, text);
const pass = text => console.log(`PASS ${++count}: ${text}`);
const click = async text => { for (const element of await page.$$('button')) if ((await element.evaluate(node => node.textContent.trim())) === text) { await element.click(); return; } throw new Error(`Missing ${text}`); };
try {
  await page.goto(`${base}/#/status`); await wait('Core upgrade');
  await page.$eval('#core-upgrade-controls', element => element.open = true);
  await wait('Current class'); await wait('Upgrade nonce');
  assert.equal(await page.$('#upgrade-target'), null); pass('wallet-free V8 status shows pinned current class and nonce without write controls');
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    const session = await import(path); window.upgradeSession = session;
    const reader = session.getSession().reader, snapshot = await reader.snapshot(), admin = await reader.getAdministrator(snapshot);
    window.upgradeFixture = { reader, getCoreUpgradeState: reader.getCoreUpgradeState.bind(reader) };
    await session.connectExternal({
      getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }),
      getAccounts: async () => [{ alias: 'Read-only upgrade fixture', item: admin }],
      getContractMetadata: async () => ({}), registerContract: async () => {},
      sendTx: async () => { throw new Error('Browser fixture must never sign or send'); },
    }, { disconnect: async () => {}, onDisconnect: () => () => {} });
  });
  await wait('Approve reviewed release'); pass('matching administrator sees exact release, directed edge, cancellation and handoff controls');
  assert.equal(await page.$$eval('#core-upgrade-controls button', buttons => buttons.find(button => button.textContent.trim() === 'Execute stored proposal')?.disabled), true);
  assert.equal(await page.$$eval('#core-upgrade-controls button', buttons => buttons.find(button => button.textContent.trim() === 'Cancel before activation')?.disabled), true);
  pass('no active proposal or schedule keeps execute and strict cancel disabled');
  await page.type('#upgrade-target', '0x123'); await click('Approve reviewed release');
  await wait('Deployment mismatch'); pass('unknown exact class is rejected before wallet submission');
  await page.evaluate(() => { window.upgradeFixture.reader.getCoreUpgradeState = async () => { throw new Error('fixture upgrade snapshot unavailable'); }; location.hash = '/docs'; });
  await wait('Your name. Your next step.'); await page.evaluate(() => location.hash = '/status'); await wait('Core upgrade');
  await page.$eval('#core-upgrade-controls', element => element.open = true); await wait('Core upgrade status unavailable. Refresh before signing.');
  assert.equal(await page.$('#upgrade-target'), null);
  assert.equal(await page.$$eval('#core-upgrade-controls button', buttons => buttons.some(button => button.textContent.trim() !== 'Refresh contract status' && !button.disabled)), false);
  pass('unavailable upgrade snapshot removes administrator write controls and disables handoff');
  for (const width of [1280, 390, 320]) { await page.setViewport({ width, height: 900 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px overflow`); }
  pass('upgrade status and controls fit desktop and mobile widths');
  assert.equal(broadcasts, 0); assert.deepEqual(errors, []); pass('zero signing/broadcasts and uncaught browser errors');
  console.log(`ALL ${count} UPGRADE BROWSER CHECKS PASSED`);
} finally { await browser.close(); }
