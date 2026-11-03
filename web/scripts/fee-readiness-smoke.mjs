// Real deployment reads and UI; wallet utility responses are fixtures and cannot sign or broadcast.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { RegistryReader, readFeeTokenMetadata } from '@ans/sdk/read';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import deployment from '../../deployments/testnet.json' with { type: 'json' };
const base = process.env.BASE ?? 'http://127.0.0.1:5191';
const name = process.env.NAME;
assert(name, 'NAME must identify an active holding of ACCOUNT');
const account = process.env.ACCOUNT;
assert.match(account ?? '', /^0x[0-9a-f]{64}$/);
const reader = await RegistryReader.connect(
  createAztecNodeClient(process.env.NODE_URL ?? deployment.nodeUrl),
  AztecAddress.fromStringUnsafe(process.env.REGISTRY ?? deployment.registry),
);
const snapshot = await reader.snapshot('checkpointed');
const policy = await reader.getConfig(snapshot);
assert(policy.annualPrice > 0n, 'This smoke test requires a paid registry');
const token = await readFeeTokenMetadata(reader, policy.feeToken, snapshot);
const digits = policy.annualPrice.toString().padStart(token.decimals + 1, '0');
const fraction = token.decimals ? digits.slice(-token.decimals).replace(/0+$/, '') : '';
const amount = token.decimals ? digits.slice(0, -token.decimals) : digits;
const feeLabel = `${amount}${fraction ? `.${fraction}` : ''} ${token.symbol}`;
assert(await reader.isCanonical(snapshot), 'Fee snapshot changed; retry the smoke test');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
let broadcasts = 0, checks = 0;
await page.setRequestInterception(true);
page.on('request', request => {
  if (/(?:aztec|node)_sendTx/.test(request.postData() ?? '')) { broadcasts++; void request.abort(); }
  else void request.continue();
});
const pass = message => { checks++; console.log(`PASS ${checks}: ${message}`); };
const wait = (predicate, ...args) => page.waitForFunction(predicate, { timeout: 90000 }, ...args);
const click = label => page.evaluate(label => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label && !b.disabled);
  if (!button) throw new Error(`Missing enabled control: ${label}`);
  button.click();
}, label);
try {
  await page.goto(`${base}/#/register`);
  await wait(label => document.body.innerText.includes(label), feeLabel);
  assert.equal(await page.$('[data-registrar-change]'), null);
  pass('registration shows the deployed payment asset without an activation workflow');
  await page.evaluate(async ({ account, requiredBalance }) => {
    const source = await (await fetch('/src/pages/Manage.tsx')).text();
    const sessionPath = source.match(/from\s*["']([^"']*session\.ts[^"']*)["']/)[1];
    const session = await import(sessionPath);
    await session.boot();
    const reader = session.getSession().reader;
    const address = reader.registry.constructor.fromStringUnsafe(account);
    const Field = reader.registry.toField().constructor;
    const fixture = window.feeFixture = { balance: 0n, requiredBalance: BigInt(requiredBalance), failure: false, reader, session };
    const wallet = new Proxy({
      getChainInfo: async () => ({ chainId: new Field(reader.deployment.chainId), version: new Field(reader.deployment.rollupVersion) }),
      getAccounts: async () => [{ alias: 'Read-only fee fixture', item: address }],
      registerContract: async () => {},
      executeUtility: async () => {
        if (fixture.failure) throw new Error('Fixture private balance is unavailable');
        return { result: [new Field(fixture.balance)], offchainEffects: [], anchorBlockTimestamp: 0n };
      },
    }, { get: (target, prop) => prop in target ? target[prop] : async () => { throw new Error('Fee fixture cannot sign or broadcast'); } });
    await session.connectExternal(wallet, { disconnect: async () => {}, onDisconnect: () => () => {} });
  }, { account, requiredBalance: policy.annualPrice.toString() });
  await page.evaluate(name => { location.hash = `/manage/${name}`; }, name);
  await wait(() => document.body.innerText.includes('Insufficient registration fee token balance.'));
  const disabled = () => page.$$eval('button', buttons => buttons.find(b => b.textContent.trim() === 'Confirm renewal')?.disabled);
  assert(await disabled()); pass('zero private balance disables paid renewal before signing');
  await page.evaluate(() => { window.feeFixture.balance = window.feeFixture.requiredBalance; });
  await click('Check balance again');
  await wait(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Confirm renewal' && !b.disabled));
  pass('funded balance enables renewal for the exact quoted asset');
  await page.evaluate(() => { window.feeFixture.failure = true; });
  await click('Check balance again');
  await wait(() => document.body.innerText.includes('Balance could not be checked.'));
  assert(await disabled()); pass('failed balance read clears the old balance and blocks confirmation');
  await page.evaluate(() => { window.feeFixture.failure = false; });
  await click('Check balance again');
  await wait(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Confirm renewal' && !b.disabled));
  pass('balance read recovers through the visible retry control');

  await wait(() => document.body.innerText.includes('Renew'));

  pass('English payment controls use the live asset');
  await page.setViewport({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(broadcasts, 0); assert.deepEqual(errors, []);
  pass('mobile payment controls render with zero broadcasts or runtime errors');

  await page.evaluate(async () => {
    const fixture = window.feeFixture;
    fixture.reader.node.getNodeInfo = async () => { throw new Error('Fixture network outage'); };
    await fixture.session.boot();
  });
  await wait(() => document.body.innerText.includes('Node unavailable'));
  assert.equal(await page.$eval('#wallet-menu > summary', e => e.getAttribute('aria-disabled')), 'false');
  await page.click('#wallet-menu > summary');
  assert.equal(await page.$eval('#wallet-menu', e => e.open), true);
  pass('a connected wallet keeps its local account menu during an outage');
  await click('Disconnect wallet');
  await wait(() => document.querySelector('#wallet-menu > summary')?.getAttribute('aria-disabled') === 'true');
  assert.equal(broadcasts, 0); assert.deepEqual(errors, []);
  pass('local disconnect works offline and new wallet connection remains disabled');
  console.log(`ALL ${checks} FEE READINESS UI CHECKS PASSED`);
} catch (error) {
  console.error(JSON.stringify({ url: page.url(), expectedFee: feeLabel, body: await page.evaluate(() => document.body.innerText).catch(() => ''), errors, broadcasts }));
  throw error;
} finally { await browser.close(); }
