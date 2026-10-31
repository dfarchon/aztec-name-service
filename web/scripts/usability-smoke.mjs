// Recovery and usability regressions; mocked signing is read-only and broadcasts are forbidden.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base = process.env.BASE ?? 'http://127.0.0.1:5191';
const name = process.env.NAME ?? 'ans-muyxsdch';
const nodeUrl = process.env.NODE_URL ?? 'https://v5.testnet.rpc.aztec-labs.com';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
await browser.defaultBrowserContext().overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
const page = await browser.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
let failing = true, broadcasts = 0, checks = 0;
const wait = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 90000 }, text);
const click = async label => {
  await page.waitForFunction(label => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === label && !b.disabled), { timeout: 90000 }, label);
  for (const button of await page.$$('button')) {
    if (await button.evaluate((b, label) => b.textContent.trim() === label, label)) { await button.click(); return; }
  }
  throw new Error(`Missing button ${label}`);
};
const pass = label => console.log(`PASS ${++checks}: ${label}`);
try {
  await page.setRequestInterception(true);
  page.on('request', r => {
    if (r.url().startsWith(nodeUrl)) {
      if (r.postData()?.includes('sendTx')) { broadcasts++; r.abort(); return; }
      if (failing) { r.abort(); return; }
    }
    r.continue();
  });
  await page.goto(`${base}/#/name/${name}`);
  await wait('Node unavailable'); failing = false;
  await wait('Active'); pass('startup RPC failure reconnects automatically and refreshes lookup');
  await page.locator('button[aria-label="Copy name"]').click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Copy name"]')?.textContent === 'Copied');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), name); pass('name copy writes the complete value');
  await page.locator('button[aria-label="Copy owner address"]').click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Copy owner address"]')?.textContent === 'Copied');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^0x[0-9a-f]{64}$/); pass('address copy keeps all 64 digits');
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    const session = await import(path); window.usabilitySession = session;
    const reader = session.getSession().reader;
    const account = reader.registry;
    window.usability = { reader, account, writes: 0 };
    const node = reader.node;
    reader.node = new Proxy(node, { get(target, prop) {
      if (prop === 'sendTx') return async () => { window.usability.writes++; throw new Error('Read-only fixture'); };
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await session.connectExternal({ getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }), getAccounts: async () => [{ alias: 'Read-only fixture', item: account }], getContractMetadata: async () => ({}), registerContract: async () => {} }, { disconnect: async () => {}, onDisconnect: () => () => {} });
    location.hash = '/register/fee-display-fixture';
  });
  await wait('1 ANSF'); pass('registration fee uses on-chain six-decimal metadata');
  await page.evaluate(async () => {
    const { reader, account } = window.usability;
    const snap = await reader.snapshot('checkpointed');
    reader.getName = async () => ({ generation: 0, revision: 0, expiresAt: 0n, owner: account.constructor.ZERO });
    const source = await (await fetch('/src/pages/Register.tsx')).text();
    const path = source.match(/from\s*["']([^"']*(?:ans_sdk|sdk\/dist\/index\.js)[^"']*)["']/)?.[1];
    const { prepareRegistration } = await import(path);
    const { getSession, recordWriter } = window.usabilitySession;
    const plan = await prepareRegistration(getSession().ctx, { name: 'registered-fixture', duration: 31536000n });
    reader.getName = async () => ({ generation: 1, revision: 0, expiresAt: snap.timestamp + 31536000n, owner: account });
    reader.getCommit = async () => ({ committedAt: snap.timestamp - 100n, consumed: true });
    reader.getAddress = async () => ({ present: false, addr: account.constructor.ZERO, bindingVersion: 0 });
    reader.getPrimary = async () => ({ present: false, node: 0n, generation: 0, bindingVersion: 0 });
    await recordWriter(getSession().ctx)(r => ({ ...r, plans: [plan] }));
    location.hash = '/register/registered-fixture';
  });
  await wait('Registered'); await click('Set address');
  await page.waitForFunction(() => location.hash === '#/manage/registered-fixture');
  await wait('Use wallet address'); pass('registration completion opens address setup');
  const txHash = '0x' + '0'.repeat(63) + 'a';
  await page.evaluate(async hash => {
    const { getSession, recordWriter } = window.usabilitySession;
    const ctx = getSession().ctx;
    const node = ctx.reader.node;
    ctx.reader.node = new Proxy(node, { get(target, prop) {
      if (prop === 'getTxReceipt') return async () => ({ status: 'checkpointed', blockNumber: 1, hasExecutionReverted: () => false });
      const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await recordWriter(ctx)(r => ({ ...r, txs: [
      { id: 'one', label: 'Recovered transaction', txHash: hash, state: 'submitted', at: Date.now() },
      { id: 'duplicate', label: 'Repeated receipt lookup', txHash: hash, state: 'unknown', at: Date.now() },
    ] }));
  }, txHash);
  await page.waitForFunction(() => window.usabilitySession.getSession().records.txs.every(t => t.state === 'confirmed'), { timeout: 30000 });
  pass('background watcher confirms all records sharing a known hash');
  assert.equal(broadcasts, 0); assert.equal(await page.evaluate(() => window.usability.writes), 0); pass('recovery never broadcasts');
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); pass('address setup fits mobile');
  assert.deepEqual(errors, []); pass('no browser runtime errors');
  console.log(`ALL ${checks} USABILITY CHECKS PASSED`);
} catch(e) { console.error((await page.evaluate(() => document.body.innerText)).slice(-1200)); throw e; }
finally { await page.close(); await browser.close(); }
