// Public UI acceptance against a local registry with an active name alice.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base = process.env.BASE ?? 'http://localhost:5179';
const name = process.env.NAME ?? 'alice';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
let observedNodeUrl;
page.on('request', request => {
  if (/"(?:aztec|node)_getNodeInfo"/.test(request.postData() ?? ''))
    observedNodeUrl = new URL(request.url()).href;
});
let count=0;
const check=(name, condition)=>{assert.ok(condition,name);console.log(`PASS ${++count}: ${name}`);};
const waitText=s=>page.waitForFunction(s=>document.body.innerText.includes(s),{timeout:60000},s);
const text=()=>page.evaluate(()=>document.body.innerText);
try {
  await page.goto(`${base}/#/name/${encodeURIComponent(name)}`);
  await waitText('Active');
  check('lookup works before connecting wallet', !!(await page.locator('#wallet-menu > summary').wait()));
  check('name owner is public', (await text()).includes('Owner') && /0x[0-9a-f]{64}/i.test(await text()));
  check('navigation exposes search, names and docs, with status in the footer', await page.evaluate(() => JSON.stringify([...document.querySelectorAll('.app-header nav a')].map(a => a.getAttribute('href'))) === JSON.stringify(['#/','#/names','#/docs']) && !!document.querySelector('footer a[href="#/status"]')));
  const input=await page.$('form input'); await input.click({count:3}); await input.type('ab');
  await page.waitForFunction(() => document.querySelector('form input')?.value === 'ab' && document.querySelector('form button')?.disabled);
  check('invalid name cannot be submitted', await page.$eval('form button', b=>b.disabled));
  await page.goto(`${base}/#/names`); await waitText('Wallet not connected');
  check('my names requires wallet authorization', (await text()).includes('Wallet not connected'));
  await page.goto(`${base}/#/account`);
  check('development wallet is absent by default', !(await text()).includes('Create account') && !(await page.$('input[type=password]')));
  await page.goto(`${base}/#/name/${encodeURIComponent(name)}`); await waitText('Active');
  await page.locator('#wallet-menu > summary').click();
  await waitText('No compatible wallet found');
  check('wallet discovery has a retryable empty state', await page.$$eval('#wallet-menu button', buttons => buttons.some(button => button.textContent.trim() === 'Find wallets again' && !button.disabled)));
  await page.screenshot({ path: '/tmp/ans-public-ui.png', fullPage: true });
  await page.setViewport({width: 390, height: 844});
  check('mobile layout fits viewport', await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/ans-public-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  check('no browser runtime errors', true);
  // Follow the RPC actually used by the app, including fixtures on a non-default port.
  assert.ok(observedNodeUrl, 'must observe the app node-info request before injecting an outage');
  const nodeUrl = new URL(process.env.NODE_URL ?? observedNodeUrl).href;
  assert.equal(nodeUrl, observedNodeUrl, 'NODE_URL must match the app RPC URL');
  let blocked = 0;
  await page.setRequestInterception(true);
  page.on('request', r=>{
    if (r.url().startsWith(nodeUrl)) { blocked++; void r.abort(); }
    else void r.continue();
  });
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes('Node unavailable'), { timeout: 15000 });
  assert.ok(blocked > 0, 'the outage check must abort actual node requests');
  check('node failure does not display an available name', (await page.$('.status-badge')) === null);
  assert.equal(await page.$eval('form button', button => button.disabled), true);
  assert.equal(await page.$$eval('button', buttons => buttons.some(button => button.textContent.trim() === 'Register name')), false);
  await page.select('.language-select', 'zh-CN');
  await page.waitForFunction(() => document.querySelector('footer .network-status')?.textContent === '节点不可用');
  assert.equal(await page.$('.status-badge'), null);
  console.log(`ALL ${count} UI CHECKS PASSED`);
} finally { await browser.close(); }
