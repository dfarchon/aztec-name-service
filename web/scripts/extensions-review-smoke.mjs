// Read-only V4 browser regressions. Discovery pages are fixtures; signing/broadcasts are prohibited.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const base = process.env.BASE ?? 'http://127.0.0.1:5196';
const name = process.env.NAME ?? 'modular-name';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
const errors = [];
let broadcasts = 0, checks = 0, statusMode = 'pending';
page.on('pageerror', error => errors.push(error.message));
await page.setRequestInterception(true);
page.on('request', async request => {
  if (request.postData()?.includes('sendTx')) { broadcasts++; await request.abort(); return; }
  const path = new URL(request.url()).pathname;
  if (path === '/api/status') { if (statusMode === 'failed') { await request.respond({ status: 503, body: 'unavailable' }); return; } await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ checkedAt: statusMode === 'fresh' ? Date.now() : 0, checks: [{ name: 'monitor', ok: false, detail: 'Current release has not been checked' }], incidents: [], metrics: [], release: 'review', checkedRelease: null }) }); return; }
  const binding = path === '/src/pages/Extensions.tsx' ? 'listSubnames' : path === '/src/pages/MyNames.tsx' ? 'listOwnedNames' : path === '/src/pages/Manage.tsx' ? 'renew' : undefined;
  if (!binding) { await request.continue(); return; }
  try {
    const response = await fetch(request.url());
    const original = await response.text();
    const source = original.replace(new RegExp(`\\b${binding}\\b(?=[, }])`), `${binding} as real${binding}`)
      + `\nconst ${binding} = (...args) => window.reviewDiscovery.${binding}(...args);\n`;
    assert.notEqual(source, original);
    await request.respond({ status: response.status, contentType: 'text/javascript', body: source });
  } catch (error) { errors.push(String(error)); await request.abort(); }
});
const wait = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 60000 }, text);
const click = async (text, selector = 'button') => {
  for (const element of await page.$$(selector)) if (await element.evaluate((element, text) => element.textContent.trim() === text, text)) { await element.click(); return; }
  throw new Error(`Missing ${text}`);
};
const pass = label => console.log(`PASS ${++checks}: ${label}`);
const idle = () => page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Refresh list')?.disabled);
try {
  await page.goto(`${base}/#/name/${name}`);
  await wait('Registered · Active');
  await page.evaluate(async name => {
    const source = await (await fetch('/src/App.tsx')).text();
    const sessionPath = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    const session = await import(sessionPath);
    const sdkSource = await (await fetch('/src/pages/Register.tsx')).text();
    const sdkPath = sdkSource.match(/from\s*["']([^"']*(?:ans_sdk|sdk\/dist\/index\.js)[^"']*)["']/)?.[1];
    const sdk = await import(sdkPath);
    const reader = session.getSession().reader;
    const holding = await sdk.getName(reader, name);
    const account = holding.record.owner;
    const connect = address => session.connectExternal({ getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }), getAccounts: async () => [{ alias: 'Read-only review fixture', item: address }], getContractMetadata: async () => ({}), registerContract: async () => {} }, { disconnect: async () => {}, onDisconnect: () => () => {} });
    window.review = { sdk, reader, holding, account, session, connect, getConfig: reader.getConfig.bind(reader), getName: reader.getName.bind(reader), getManager: reader.getManager.bind(reader) };
    let childReads = 0;
    const owned = (label, node) => ({ name: label, node: BigInt(node), generation: 1, expiresAt: holding.snapshot.timestamp + 8640000n, status: 'active' });
    const child = label => owned(`${label}.${name}`, label.charCodeAt(0));
    window.reviewDiscovery = {
      renew: async () => {
        const fixture = window.review;
        fixture.renewCalls = (fixture.renewCalls ?? 0) + 1;
        fixture.reader.getConfig = async () => {
          fixture.changedQuoteReads = (fixture.changedQuoteReads ?? 0) + 1;
          const config = await fixture.getConfig();
          return { ...config, annualPrice: config.annualPrice + 1n, priceVersion: config.priceVersion + 1 };
        };
        throw new sdk.AnsError('fee_changed', 'fee policy changed; review a fresh quote');
      },
      listSubnames: async (_reader, _parent, options) => {
        childReads++;
        if (options.cursor) return new Promise(resolve => { window.review.releaseChildren = () => resolve({ names: [child('stale')], complete: true, snapshot: holding.snapshot }); });
        return { names: childReads === 1 ? [child('alpha'), child('bravo')] : [child('fresh')], complete: childReads !== 1, cursor: childReads === 1 ? { page: 1 } : undefined, snapshot: holding.snapshot };
      },
      listOwnedNames: async (_reader, owner, options) => {
        (window.review.ownedReads ??= []).push({ owner: owner.toString(), ...options });
        if (!owner.equals(account)) return { names: [owned('new-wallet', 3)], status: 'complete', snapshot: holding.snapshot };
        const names = options.cursor ? [owned('portfolio-bravo', 2)] : options.maxPages > 4 ? [owned('portfolio-alpha', 1), owned('portfolio-bravo', 2)] : [owned('portfolio-alpha', 1)];
        const complete = options.cursor || options.maxPages > 4;
        return { names, cursor: complete ? undefined : { page: 1 }, status: complete ? 'complete' : 'partial', snapshot: holding.snapshot };
      },
    };
    await connect(account);
    reader.getConfig = async () => { window.review.quoteReads = (window.review.quoteReads ?? 0) + 1; throw new Error('Review fee service unavailable'); };
    location.hash = `/manage/${name}`;
  }, name);
  await wait('The action did not complete.');
  await wait('Profile and address records');
  assert.equal(await page.$$eval('button', buttons => buttons.find(button => button.textContent.trim() === 'Confirm renewal')?.disabled), true);
  await page.evaluate(() => { window.review.reader.getConfig = window.review.getConfig; });
  await click('Refresh');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Confirm renewal' && !button.disabled));
  pass('fee failures affect renewal only and retry restores the quote');

  await click('Confirm renewal');
  await page.waitForFunction(() => window.review.changedQuoteReads > 0);
  assert.equal(await page.evaluate(() => window.review.renewCalls), 1);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Confirm renewal' && !button.disabled));
  pass('a changed renewal price refreshes the quote without sending a second renewal');

  await click('Subnames', 'summary');
  await wait(`bravo.${name}`);
  await page.type('input[placeholder="team"]', 'alpha');
  await page.evaluate(() => { for (const checkbox of document.querySelector('input[placeholder=team]').closest('details').querySelectorAll('.check-field input')) if (!checkbox.checked) checkbox.click(); });
  await page.$eval('.name-row:nth-child(2) button', button => button.click());
  assert.equal(await page.$eval('input[placeholder="team"]', input => input.value), 'bravo');
  assert.equal(await page.$eval('input[placeholder=team]', input => [...input.closest('details').querySelectorAll('.check-field input')].filter(input => input.checked).length), 0);
  assert.equal(await page.$$eval('button', buttons => buttons.find(button => button.textContent.trim() === 'Revoke subname')?.disabled), true);
  pass('selecting another subname clears both destructive confirmations');

  await click('Load more');
  await page.waitForFunction(() => !!window.review.releaseChildren);
  await click('Subnames', 'summary');
  await click('Subnames', 'summary');
  await wait(`fresh.${name}`);
  await page.evaluate(async () => { window.review.releaseChildren(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes(`stale.${name}`));
  pass('late pagination cannot repopulate a reopened subname list');

  await page.evaluate(() => { location.hash = '/docs'; });
  await wait('Register your first name');
  await page.evaluate(name => {
    const fixture = window.review;
    fixture.quoteReads = 0;
    fixture.reader.getConfig = async () => { fixture.quoteReads++; throw new Error('Editor must not need a fee quote'); };
    fixture.reader.getName = async (...args) => ({ ...await fixture.getName(...args), owner: fixture.reader.registry });
    fixture.reader.getManager = async () => fixture.account;
    location.hash = `/manage/${name}`;
  }, name);
  await wait('Save address'); await wait('Profile and address records');
  assert.equal(await page.evaluate(() => window.review.quoteReads), 0);
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('Renew name'));
  pass('editors manage records without fetching owner-only renewal fees');

  await page.evaluate(() => {
    const fixture = window.review;
    fixture.reader.getConfig = fixture.getConfig; fixture.reader.getName = fixture.getName; fixture.reader.getManager = fixture.getManager;
    location.hash = '/names';
  });
  await wait('portfolio-alpha'); await idle();
  await click('Load more'); await wait('portfolio-bravo'); await idle();
  await click('Refresh list'); await idle();
  await wait('portfolio-bravo');
  assert.equal(await page.evaluate(() => window.review.ownedReads.at(-1).maxPages), 8);
  assert.ok((await page.evaluate(() => document.body.innerText)).includes('portfolio-alpha'));
  pass('fresh portfolio refresh preserves all previously loaded pages');

  await page.evaluate(() => { window.Notification = class { static requestPermission() { return new Promise(resolve => { window.review.releasePermission = () => resolve('granted'); }); } }; });
  await click('Enable expiry reminders');
  await page.waitForFunction(() => !!window.review.releasePermission);
  await page.evaluate(async () => { await window.review.connect(window.review.reader.registry); });
  await wait('new-wallet'); await idle();
  await page.evaluate(async () => { window.review.releasePermission(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('Disable expiry reminders'));
  assert.equal(await page.evaluate(() => window.review.ownedReads.at(-1).maxPages), 4);
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('portfolio-bravo'));
  pass('wallet switching resets pagination and discards prior notification consent');
  await page.evaluate(() => { const interval = window.setInterval.bind(window); window.setInterval = (fn, ms, ...args) => { if (ms === 30000) window.review.statusPoll = () => fn(...args); return interval(fn, ms, ...args); }; location.hash = '/status'; });
  await wait('Current release has not been checked');
  assert.ok(!/1969|1970/.test(await page.evaluate(() => document.body.innerText)));

  await wait('Current release has not been checked');
  pass('an unchecked release shows a pending state without an epoch date');

  statusMode = 'fresh';
  await click('Refresh status'); await wait('Checked every minute');
  statusMode = 'failed';
  await page.evaluate(() => window.review.statusPoll()); await wait('Monitoring is unavailable');
  await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 240000; window.review.statusPoll(); });
  await wait('Monitoring data is stale');
  pass('repeated monitoring failures still age the last sample into a stale state');
  assert.equal(broadcasts, 0); assert.deepEqual(errors, []);
  pass('no transactions or uncaught browser errors');
  console.log(`ALL ${checks} EXTENSION REVIEW CHECKS PASSED`);
} catch (error) { console.error(await page.evaluate(() => document.body.innerText).catch(() => '')); throw error; }
finally { await browser.close(); }
