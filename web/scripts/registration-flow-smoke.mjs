// Actual UI, SDK workflow and encrypted storage; synthetic calls/receipts, zero network broadcasts.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const base = process.env.BASE ?? 'http://127.0.0.1:5278';
const browser = await puppeteer.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const page = await browser.newPage(),
  errors = [];
let broadcasts = 0,
  checks = 0;
page.on('pageerror', (error) => errors.push(error.message));
await page.setRequestInterception(true);
page.on('request', (request) => {
  if (/(?:aztec|node)_sendTx/.test(request.postData() ?? '')) {
    broadcasts++;
    void request.abort();
  } else void request.continue();
});
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
const wait = (predicate) => page.waitForFunction(predicate, { timeout: 90000 });
const click = (label) =>
  page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === label && !b.disabled,
    );
    if (!button) throw new Error(`Missing enabled control: ${label}`);
    button.click();
  }, label);

async function connectFixture() {
  await wait(() => document.body.innerText.includes('Register a name'));
  await page.evaluate(async () => {
    const source = await (await fetch('/src/pages/Register.tsx')).text();
    const sdkPath = source.match(
      /from\s*["']([^"']*(?:ans_sdk|sdk\/dist\/index\.js)[^"']*)["']/,
    )[1];
    const sessionPath = source.match(/from\s*["']([^"']*session\.ts[^"']*)["']/)[1];
    const sdk = await import(sdkPath),
      session = await import(sessionPath);
    await session.boot();
    const reader = session.getSession().reader;
    const snapshot = await reader.snapshot();
    const cfg = await reader.getConfig(snapshot),
      zero = reader.registry.constructor.ZERO;
    reader.getConfig = async () => ({ ...cfg, feeToken: zero, treasury: zero, annualPrice: 0n });
    const account = reader.registry.constructor.fromBigIntUnsafe(987654321n);
    const other = reader.registry.constructor.fromBigIntUnsafe(987654322n);
    const wallet = new Proxy(
      {
        getChainInfo: async () => ({
          chainId: { toBigInt: () => reader.deployment.chainId },
          version: { toBigInt: () => reader.deployment.rollupVersion },
        }),
        getAccounts: async () => [
          { alias: 'Workflow fixture', item: account },
          { alias: 'Other fixture', item: other },
        ],
        registerContract: async () => {},
      },
      {
        get: (target, prop) =>
          prop in target
            ? target[prop]
            : async () => {
                throw new Error('Fixture cannot sign or broadcast');
              },
      },
    );
    await session.connectExternal(wallet, {
      disconnect: async () => {},
      onDisconnect: () => () => {},
    });
    const fixture = (window.registrationFixture = {
      session,
      sdk,
      reader,
      other,
      sends: { commit: 0, register: 0 },
      consumed: false,
      mature: false,
      failSend: false,
      revert: false,
    });
    reader.getCommit = async () => ({
      committedAt: fixture.mature ? snapshot.timestamp - 120n : 0n,
      consumed: fixture.consumed,
    });
    reader.node.getTxReceipt = async () => ({
      status: 'checkpointed',
      blockNumber: snapshot.blockNumber,
      hasExecutionReverted: () => fixture.revert,
    });
    session.getSession().ctx.registrationContract = fixture.registrationContract = async () => ({
      methods: Object.fromEntries(
        ['commit', 'register'].map((kind) => [
          kind,
          () => ({
            send: async () => {
              fixture.sends[kind]++;
              if (fixture.failSend)
                throw new sdk.AnsError('network', 'synthetic lost send response');
              if (kind === 'commit') fixture.mature = true;
              else fixture.consumed = true;
              return {
                txHash: { toString: () => `0x${(kind === 'commit' ? '11' : '22').repeat(32)}` },
              };
            },
          }),
        ]),
      ),
    });
    const plan = session.getSession().records.plans[0];
    if (plan?.commitTx) fixture.mature = true;
    location.hash = '/register';
  });
  await wait(() => document.body.innerText.includes('Registration details'));
}

try {
  await page.goto(`${base}/#/register`, { waitUntil: 'domcontentloaded' });
  await connectFixture();
  const name = `flow-${Date.now().toString(36)}`;
  await page.type('main input', name);
  await wait(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent.trim() === 'Start registration' && !b.disabled,
    ),
  );
  await page.evaluate(() => {
    const start = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Start registration',
    );
    start.click();
    start.click();
  });
  await wait(() => window.registrationFixture.session.getSession().records.plans[0]?.commitTx);
  assert.equal(await page.evaluate(() => window.registrationFixture.sends.commit), 1);
  pass('double click uses one SDK workflow and saves one commit hash');
  const encrypted = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => key.startsWith('ans:v2:')),
  );
  assert.ok(
    encrypted.length &&
      encrypted.every(([, value]) => !value.includes('secret') && !value.includes('commitment')),
  );
  pass('plan secrets remain encrypted at rest');

  await wait(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent.trim() === 'Pay and register' && !b.disabled,
    ),
  );
  await click('Pay and register');
  await wait(
    () =>
      document.body.innerText.includes('Registered') &&
      window.registrationFixture.session.getSession().records.plans[0]?.registerTx,
  );
  assert.equal(await page.evaluate(() => window.registrationFixture.sends.register), 1);
  pass('registration completion uses the shared SDK flow');

  await page.evaluate(() => {
    window.registrationFixture.consumed = false;
    window.registrationFixture.revert = true;
  });
  await wait(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent.trim() === 'Check registration transaction' && !b.disabled,
    ),
  );
  await click('Check registration transaction');
  await wait(() => !window.registrationFixture.session.getSession().records.plans[0].registerTx);
  pass('verified reverted receipt clears and persists only its registration hash');

  await page.reload();
  await connectFixture();
  await wait(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent.trim() === 'Pay and register' && !b.disabled,
    ),
  );
  assert.equal(
    await page.evaluate(
      () => window.registrationFixture.session.getSession().records.plans[0].label,
    ),
    name,
  );
  assert.equal(
    await page.evaluate(
      () => window.registrationFixture.session.getSession().records.plans[0].registerTx,
    ),
    undefined,
  );
  pass('reload restores the commit and preserves the cleared registration hash');

  await page.evaluate(() => {
    window.registrationFixture.failSend = true;
  });
  await click('Pay and register');
  await wait(
    () =>
      window.registrationFixture.session.getSession().records.plans[0].broadcastUnknown ===
      'registerTx',
  );
  await wait(() => document.body.innerText.includes('Check your activity before paying again'));
  assert.equal(
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent.trim() === 'Pay and register',
      ),
    ),
    false,
  );
  pass('lost send response persists uncertainty and removes the payment retry control');

  await page.reload();
  await connectFixture();
  await wait(() => document.body.innerText.includes('Check your activity before paying again'));
  assert.equal(await page.evaluate(() => window.registrationFixture.sends.register), 0);
  pass('reload never broadcasts an uncertain payment');
  await page.evaluate(async () => {
    const f = window.registrationFixture;
    await f.session.selectAccount(f.other);
  });
  await wait(() => window.registrationFixture.session.getSession().records.plans.length === 0);
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes(name));
  pass('account switch isolates encrypted registration plans');
  await page.evaluate(() => {
    const f = window.registrationFixture;
    f.session.getSession().ctx.registrationContract = f.registrationContract;
    f.mature = false;
    f.consumed = false;
    f.failSend = true;
  });
  await page.type('main input', `${name}-other`);
  await wait(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent.trim() === 'Start registration' && !b.disabled,
    ),
  );
  await click('Start registration');
  await wait(
    () =>
      window.registrationFixture.session.getSession().records.plans[0]?.broadcastUnknown ===
      'commitTx',
  );
  assert.equal(
    await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Retry commit'),
    ),
    false,
  );
  await page.evaluate(() => {
    window.registrationFixture.mature = true;
  });
  await wait(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent.trim() === 'Pay and register' && !b.disabled,
    ),
  );
  pass(
    'chain-confirmed commitment permits registration after a lost commit response without resending the commit',
  );
  await page.setViewport({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(broadcasts, 0);
  assert.deepEqual(errors, []);
  pass('mobile layout and runtime pass with zero network broadcasts');
  console.log(`ALL ${checks} REGISTRATION FLOW UI CHECKS PASSED`);
} catch (error) {
  const body = await page.evaluate(() => document.body.innerText).catch(() => '(page navigating)');
  console.log(body.slice(-1600));
  throw error;
} finally {
  await browser.close();
}
