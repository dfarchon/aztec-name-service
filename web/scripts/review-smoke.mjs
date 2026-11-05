// Browser regressions with an isolated test wallet and mocked public reads; no transactions are sent.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const base = process.env.BASE ?? 'http://localhost:5179';
const name = process.env.NAME ?? 'alice';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const wait = text => page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 60000 }, text);
const hasButton = text => page.evaluate(text => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === text), text);
let checks = 0;
const pass = label => console.log(`PASS ${++checks}: ${label}`);
try {
  await page.goto(`${base}/#/name/%E0%A4%A`);
  await wait('Name');
  assert.deepEqual(errors, []);
  pass('malformed URL does not crash the app');
  await page.goto(`${base}/#/name/${encodeURIComponent(name)}`);
  await wait('Active');
  await page.evaluate(() => { location.hash = '/name/bob'; });
  await page.waitForFunction(() => document.querySelector('form input')?.value === 'bob');
  pass('name route updates the input');
  await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    if (!path) throw new Error('session module path not found');
    const session = await import(path);
    window.reviewSession = session;
    const reader = session.getSession().reader;
    const account = reader.registry;
    const snap = await reader.snapshot('checkpointed');
    const config = await reader.getConfig(snap);
    window.review = { reader, snap, mode: 'ready' };
    reader.getConfig = async () => ({ ...config, feeToken: account.constructor.ZERO, treasury: account.constructor.ZERO, annualPrice: 0n, priceVersion: 1 });
    reader.getName = async () => ({ generation: 0, revision: 0, expiresAt: 0n, owner: account.constructor.ZERO });
    reader.getCommit = async () => ({ committedAt: window.review.mode === 'missing' ? 0n : snap.timestamp - 100n, consumed: false });
    reader.snapshot = async () => {
      if (window.review.mode === 'offline') throw new Error('fetch failed');
      return snap;
    };
    await session.connectExternal({
      getChainInfo: async () => ({ chainId: { toBigInt: () => reader.deployment.chainId }, version: { toBigInt: () => reader.deployment.rollupVersion } }),
      getAccounts: async () => [{ alias: 'Review fixture', item: account }],
      getContractMetadata: async () => ({}),
      registerContract: async () => {},
    }, { disconnect: async () => {}, onDisconnect: () => () => {} });
  });
  await page.evaluate(async () => {
    const { getSession, recordWriter } = window.reviewSession;
    // Resolve the same SDK module Vite imports for the registration page.
    const response = await fetch('/src/pages/Register.tsx');
    const source = await response.text();
    const path = source.match(/from\s*["']([^"']*(?:ans_sdk|sdk\/dist\/index\.js)[^"']*)["']/)?.[1];
    if (!path) throw new Error('SDK module path not found');
    const { prepareRegistration } = await import(path);
    const ctx = getSession().ctx;
    const plan = await prepareRegistration(ctx, { name: 'review-name', duration: 31536000n });
    await recordWriter(ctx)(r => ({ ...r, plans: [plan] }));
    location.hash = '/register';
  });
  await wait('Ready to register');
  await page.waitForSelector('.fee-details');
  assert.equal(await page.$eval('.fee-details', d => d.open), false);
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('Payment token'));
  await page.click('.fee-details summary');
  await wait('Payment token');
  assert.ok((await page.evaluate(() => document.body.innerText)).includes('Maximum fee'));
  pass('fee details stay collapsed and remain available before payment');
  await page.evaluate(() => { location.hash = '/register/review-name'; });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Start registration'));
  pass('an existing registration hides the duplicate start form');
  await wait('Register for free');
  assert.ok(await hasButton('Register for free'));
  pass('valid ready plan offers registration');
  await page.evaluate(() => { window.review.mode = 'offline'; });
  await wait('Unable to read the network');
  assert.ok(!(await hasButton('Register for free')));
  pass('failed status refresh removes stale payment action');
  await page.evaluate(async () => {
    window.review.mode = 'missing';
    const { getSession, recordWriter } = window.reviewSession;
    await recordWriter(getSession().ctx)(r => ({ ...r, plans: r.plans.map(p => ({ ...p, commitTx: 'known-commit' })) }));
  });
  await wait('Check commit status');
  assert.ok(!(await hasButton('Retry commit')));
  pass('known commit hash is tracked instead of rebroadcast');
  await page.evaluate(async () => {
    window.review.mode = 'ready';
    const { getSession, recordWriter } = window.reviewSession;
    await recordWriter(getSession().ctx)(r => ({ ...r, plans: r.plans.map(p => ({ ...p, registerTx: 'known-register' })) }));
  });
  await wait('Check registration transaction');
  assert.ok(!(await hasButton('Register for free')));
  pass('known registration hash blocks another payment');
  const afterSlowSave = await page.evaluate(async () => {
    const { getSession, recordWriter, rememberRegistrationProgress } = window.reviewSession;
    const ctx = getSession().ctx;
    const commitment = getSession().records.plans[0].commitment;
    const original = crypto.subtle.encrypt;
    let begin, release;
    const started = new Promise(resolve => { begin = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    crypto.subtle.encrypt = async function(...args) {
      begin();
      await gate;
      return original.apply(this, args);
    };
    try {
      const saving = recordWriter(ctx)(r => r);
      await started;
      rememberRegistrationProgress(ctx, { ...getSession().records.plans.find(p => p.commitment === commitment), registerTx: 'broadcast-during-slow-save' });
      release();
      await saving;
      return getSession().records.plans[0].registerTx;
    } finally { release(); crypto.subtle.encrypt = original; }
  });
  assert.equal(afterSlowSave, 'broadcast-during-slow-save');
  pass('a slow older encrypted save cannot erase a newer broadcast hash');
  const retained = await page.evaluate(async () => {
    const { getSession, recordWriter, rememberRegistrationProgress } = window.reviewSession;
    const ctx = getSession().ctx;
    const commitment = getSession().records.plans[0].commitment;
    const original = Storage.prototype.setItem;
    let rejected = false;
    try {
      Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
      rememberRegistrationProgress(ctx, { ...getSession().records.plans.find(p => p.commitment === commitment), registerTx: '0x' + 'a'.repeat(64) });
      try { await recordWriter(ctx)(r => r); } catch { rejected = true; }
      rememberRegistrationProgress({}, { ...getSession().records.plans.find(p => p.commitment === commitment), registerTx: 'wrong-account' });
      return { rejected, hash: getSession().records.plans[0].registerTx };
    } finally { Storage.prototype.setItem = original; }
  });
  assert.ok(retained.rejected);
  assert.equal(retained.hash, '0x' + 'a'.repeat(64));
  await wait(retained.hash);
  assert.ok(!(await hasButton('Register for free')));
  pass('broadcast hash survives save failure in memory and ignores another account');
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  pass('full broadcast hashes fit a mobile viewport');
  assert.deepEqual(errors, []);
  pass('no browser runtime errors');
  console.log(`ALL ${checks} REVIEW UI CHECKS PASSED`);
} catch (e) {
  console.error((await page.evaluate(() => document.body.innerText)).slice(-1200));
  throw e;
} finally { await browser.close(); }
