// Local DEV only: failure recovery for real encrypted wallet stores; no transactions are broadcast.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage();
try {
  await page.goto(`${process.env.BASE ?? 'http://localhost:5180'}/#/account`);
  await page.waitForSelector('input[type=password]');
  const results = await page.evaluate(async () => {
    const source = await (await fetch('/src/App.tsx')).text();
    const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
    if (!path) throw Error('session path missing');
    const session = await import(path);
    const sessionSource = await (await fetch(path)).text();
    const configPath = sessionSource.match(/from\s*["']([^"']*\/config\.ts[^"']*)["']/)?.[1];
    const walletPath = sessionSource.match(/import\(["']([^"']*wallets_embedded\.js[^"']*)["']/)?.[1];
    if (!configPath || !walletPath) throw Error('development module paths missing');
    const { config } = await import(configPath);
    const { EmbeddedWallet } = await import(walletPath);
    const node = session.getSession().node;
    const getInfo = node.getNodeInfo;
    const info = await getInfo();
    if (info.realProofs || !config.developmentWallet) throw Error('Use a proof-disabled local DEV fixture');
    const originalFpc = config.sponsoredFpc;
    const create = EmbeddedWallet.create;
    const getAccounts = EmbeddedWallet.prototype.getAccounts;
    const results = [];
    const fail = async (expected) => {
      await session.unlock('isolated-boundary-passphrase');
      const state = session.getSession();
      if (state.status !== 'locked' || !state.error?.includes(expected)) throw Error(`Unexpected failure state: ${state.status} ${state.error}`);
    };
    try {
      node.getNodeInfo = async () => ({ ...info, realProofs: true });
      await fail('Public networks require real proofs');
      results.push('public network mock-proof configuration refused');
      node.getNodeInfo = getInfo;
      config.sponsoredFpc = session.getSession().reader.registry;
      await fail('sponsorship contract type does not match');
      results.push('wrong FPC class refused before opening encrypted stores');
      config.sponsoredFpc = originalFpc;
      EmbeddedWallet.create = async () => { throw Error('injected wallet creation failure'); };
      await fail('injected wallet creation failure');
      results.push('wallet creation failure releases unowned encrypted stores');
      EmbeddedWallet.create = create;
      EmbeddedWallet.prototype.getAccounts = async () => { throw Error('injected accounts failure'); };
      await fail('injected accounts failure');
      results.push('post-creation failure stops wallet and releases its stores');
      EmbeddedWallet.prototype.getAccounts = getAccounts;
      await session.unlock('isolated-boundary-passphrase');
      if (session.getSession().status !== 'ready') throw Error(`Retry failed: ${session.getSession().error}`);
      results.push('same tab can unlock again after both failures');
    } finally {
      node.getNodeInfo = getInfo;
      config.sponsoredFpc = originalFpc;
      EmbeddedWallet.create = create;
      EmbeddedWallet.prototype.getAccounts = getAccounts;
      await session.lock();
    }
    return results;
  });
  assert.equal(results.length, 5);
  results.forEach(label => console.log(`PASS ${label}`));
  console.log('ALL 5 DEVELOPMENT BOUNDARY CHECKS PASSED');
} finally { await browser.close(); }
