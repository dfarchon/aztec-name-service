/** Browser wallet-sdk acceptance with a separate real-proof signer; no dApp-injected Wallet object. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { WalletSchema, type Wallet } from '@aztec-labs/aztec.js/wallet';
import { createSafeJsonRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import { TokenContractArtifact } from '@aztec-labs/noir-contracts.js/Token';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { getName, RegistryReader, resolveAddress, resolvePrimary, trackTx } from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { createServer as createViteServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { assertStateToolchain, assertTestnet } from './testnet-network.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { sponsoredFpc } from './common.js';
import { selectTestnetProtocol } from './testnet-protocol.js';
import publicDeployment from '../../deployments/testnet.json' with { type: 'json' };

const appOrigin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5191';
const walletOrigin = 'http://127.0.0.1:5194';
const manageOnly = process.argv.includes('--manage-only');
const connectOnly = process.argv.includes('--connect-only');
assert(process.argv.slice(2).every(arg => ['--manage-only', '--connect-only'].includes(arg)), 'Unknown browser acceptance option');
assert(!(connectOnly && manageOnly), 'Choose one browser acceptance scenario');
const protocol = selectTestnetProtocol(process.env.ANS_TESTNET_PROTOCOL, []);
const dir = resolve(process.env.TESTNET_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-v5.2.1'));
const walletDir = protocol === '5' ? resolve(process.env.TESTNET_V5_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-v5-5.2.1')) : protocol === '4' ? resolve(process.env.TESTNET_V4_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-v4-5.2.1')) : dir;
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const rel = relative(repoRoot, dir);
assert.ok(isAbsolute(rel) || rel === '..' || rel.startsWith('../'), 'Keep private browser profiles outside the repository');
const walletRel = relative(repoRoot, walletDir);
assert.ok(isAbsolute(walletRel) || walletRel === '..' || walletRel.startsWith('../'), 'Keep wallet checkpoints outside the repository');
const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
assertStateToolchain(state);
assert.ok(state.done.includes('restore-primary'), 'Complete CLI acceptance before browser signing');
const release = acquireTestnetLock(join(dir, 'runner.lock'));
process.once('exit', release);
const releaseWallet = walletDir === dir ? () => {} : acquireTestnetLock(join(walletDir, 'runner.lock'));
process.once('exit', releaseWallet);
const checkpointPath = join(walletDir, 'external-browser.json');
let checkpoint: { name: string; transactions: Record<string, string>; completed?: boolean };
try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); }
catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  checkpoint = { name: `ext-${Date.now().toString(36)}`, transactions: {} };
}
const save = async () => {
  await writeFile(`${checkpointPath}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 });
  await rename(`${checkpointPath}.tmp`, checkpointPath);
};
await save();
let activeStep = '';
const rawNode = createAztecNodeClient('https://v5.testnet.rpc.aztec-labs.com');
const info = await rawNode.getNodeInfo();
assertTestnet('https://v5.testnet.rpc.aztec-labs.com', info);
assert.equal(state.network, info.l1ContractAddresses.rollupAddress.toString());
const node = new Proxy(rawNode, { get(target, prop) {
  if (prop === 'sendTx') return async (tx: Parameters<typeof rawNode.sendTx>[0]) => {
    assert.ok(activeStep && !checkpoint.transactions[activeStep], 'Refusing duplicate browser broadcast');
    checkpoint.transactions[activeStep] = tx.getTxHash().toString();
    await save();
    return target.sendTx(tx);
  };
  const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value;
} });
const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: true, dataDirectory: join(walletDir, 'wallets/owner') } });
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
let http: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
try {
  const k = state.keys[0];
  const account = await wallet.createSchnorrInitializerlessAccount(Fr.fromString(k.secret), Fr.fromString(k.salt), Fq.fromString(k.signingKey));
  assert.equal(account.address.toString(), state.addresses.owner);
  assert.equal((await wallet.getAccounts()).length, 1);
  const fpc = await sponsoredFpc();
  const published = await node.getContract(fpc.instance.address);
  assert.ok(published);
  assert.ok(published.currentContractClassId.equals(fpc.instance.currentContractClassId));
  await wallet.registerContract(published, fpc.artifact);
  const token = await node.getContract(AztecAddress.fromStringUnsafe(state.addresses.token));
  assert.ok(token); await wallet.registerContract(token, TokenContractArtifact);
  if (protocol !== '2') assert.equal(String(publicDeployment.protocol), protocol, 'Browser protocol must match the published deployment');
  const registry = protocol !== '2' ? publicDeployment.registry : state.addresses.registry;
  const reader = await RegistryReader.connect(node, AztecAddress.fromStringUnsafe(registry));
  const verify = async () => {
    const held = await getName(reader, checkpoint.name);
    assert.equal(held.status, 'active'); assert.ok(held.record.owner.equals(account.address));
  };
  if (checkpoint.completed && !connectOnly && !manageOnly) { await verify(); console.log('PASS completed browser acceptance readback; no broadcast'); }
  else {
    const tokenHeader = randomBytes(32).toString('hex');
    const rpc = createSafeJsonRpcServer<Wallet>(wallet, WalletSchema, {
      corsAllowedOrigins: [walletOrigin], corsAllowedHeaders: ['content-type', 'x-ans-wallet-token'], maxBodySizeBytes: '8mb',
      middlewares: [async (ctx: { method: string; headers: Record<string, unknown>; status: number }, next: () => Promise<unknown>) => {
        if (ctx.method !== 'OPTIONS' && ctx.headers['x-ans-wallet-token'] !== tokenHeader) { ctx.status = 403; return; }
        await next();
      }],
    });
    http = createServer(rpc.getApp().callback()); http.listen(0, '127.0.0.1'); await once(http, 'listening');
    const address = http.address(); assert.ok(address && typeof address !== 'string');
    vite = await createViteServer({ root: fileURLToPath(new URL('../../web/', import.meta.url)),
      cacheDir: fileURLToPath(new URL('../../web/node_modules/.vite-external-wallet/', import.meta.url)),
      optimizeDeps: { include: ['vite-plugin-node-polyfills/shims/buffer', 'vite-plugin-node-polyfills/shims/global', 'vite-plugin-node-polyfills/shims/process'] },
      server: { host: '127.0.0.1', port: 5194, strictPort: true,
        headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' } } });
    await vite.listen();
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, userDataDir: join(walletDir, 'external-browser-profile') });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCacheEnabled(false);
    const diagnostics = await page.createCDPSession();
    diagnostics.on('Network.loadingFailed', e => {
      if (e.blockedReason) console.error('Browser policy:', e.blockedReason);
    });
    diagnostics.on('Audits.issueAdded', ({ issue }) => {
      if (issue.details.blockedByResponseIssueDetails)
        console.error('Browser issue:', issue.details.blockedByResponseIssueDetails.reason);
    });
    await diagnostics.send('Network.enable');
    await diagnostics.send('Audits.enable');
    page.on('pageerror', e => console.error('Browser runtime:', (e instanceof Error ? e.message : String(e)).replace(/0x[\da-f]+/gi, '[field]').slice(0, 300)));
    page.on('console', m => {
      if (m.type() === 'error') console.error('Browser error:', m.text().replace(/0x[\da-f]+/gi, '[field]').slice(0, 300));
    });
    page.on('requestfailed', r => {
      if (r.url().startsWith(walletOrigin)) console.error('Wallet resource failed:', new URL(r.url()).pathname, r.resourceType(), r.failure()?.errorText);
    });
    await page.evaluateOnNewDocument((origin, cfg) => {
      if (location.origin === origin) Object.assign(window, { __ANS_WALLET_TEST_CONFIG__: cfg });
      else localStorage.setItem('ans:locale', 'en');
    }, walletOrigin, { rpc: `http://127.0.0.1:${address.port}`, token: tokenHeader, appOrigin,
      chainId: String(info.l1ChainId), rollupVersion: String(info.rollupVersion) });
    // Finish the wallet's first dependency optimization before its discovery timeout begins.
    await page.goto(`${walletOrigin}/scripts/fixtures/external-wallet.html`);
    await page.waitForFunction(() => document.body.dataset.walletReady === 'true', { timeout: 180000 });
    const click = async (label: string, timeout = 180000) => {
      await page.waitForFunction(label => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === label && !b.disabled), { timeout }, label);
      for (const b of await page.$$('button')) if (await b.evaluate((b, label) => b.textContent?.trim() === label, label)) { await b.click(); return; }
    };
    await page.goto(`${appOrigin}/#/register/${checkpoint.name}`);
    const connect = async () => {
      await page.waitForFunction(() => document.querySelector('#wallet-menu > summary')?.getAttribute('aria-disabled') === 'false', { timeout: 180000 });
      await page.locator('#wallet-menu > summary').click();
      const deployment = await page.evaluate(async () => {
        const source = await (await fetch('/src/App.tsx')).text();
        const path = source.match(/from\s*["']([^"']*\/session\.ts[^"']*)["']/)?.[1];
        if (!path) throw new Error('App session module not found');
        const { getSession } = await import(path);
        const r = getSession().reader;
        return { registry: r.registry.toString(), chainId: String(r.deployment.chainId), version: String(r.deployment.rollupVersion) };
      });
      assert.equal(deployment.registry, registry, 'Preview points at another registry');
      assert.equal(deployment.chainId, String(info.l1ChainId));
      assert.equal(deployment.version, String(info.rollupVersion));
      await click('ANS Test Wallet', 30000);
      const frame = await page.waitForFrame(f => f.url().startsWith(walletOrigin));
      await frame.waitForFunction(() => !!document.querySelector('#verification')?.textContent);
      const emoji = await frame.$eval('#verification', e => e.textContent);
      await page.waitForFunction(emoji => document.body.innerText.includes(emoji!), {}, emoji);
      await page.setViewport({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Wallet connection fits mobile viewport');
      await click('Confirm and connect');
      await page.waitForSelector('select[aria-label="Wallet account"]', { timeout: 60000 });
    };
    await connect();
    console.log('PASS external iframe discovery, ECDH emoji match and account authorization');
    const step = async (name: string, button: string) => {
      if (checkpoint.transactions[name]) await trackTx(node, checkpoint.transactions[name], { waitFor: 'confirmed', timeoutMs: 1800000 });
      else { activeStep = name; await click(button);
        const deadline = Date.now() + 180000;
        while (!checkpoint.transactions[name]) {
          const error = await page.$('.txline.err');
          if (error) throw new Error(await error.evaluate(e => e.textContent ?? 'Browser signing failed'));
          if (Date.now() > deadline) throw new Error('Browser did not reach the separate signer');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        await trackTx(node, checkpoint.transactions[name], { waitFor: 'confirmed', timeoutMs: 1800000 }); }
      activeStep = ''; console.log(`PASS browser ${name} real-proof transaction`);
    };
    if (manageOnly) {
      await verify();
      await page.goto(`${appOrigin}/#/manage/${checkpoint.name}`);
      await step('address', 'Use wallet address');
      const forward = await resolveAddress(reader, checkpoint.name);
      assert.ok(forward.status === 'resolved' && forward.address.equals(account.address));
      await page.evaluate(name => { location.hash = `/name/${name}`; }, checkpoint.name);
      await page.waitForFunction(() => !document.body.innerText.includes('Use wallet address'));
      await page.evaluate(name => { location.hash = `/manage/${name}`; }, checkpoint.name);
      await step('primary', 'Set primary name');
      const primary = await resolvePrimary(reader, account.address);
      assert.ok(primary.status === 'verified' && primary.name === checkpoint.name);
      console.log('PASS browser address and primary public-chain readback');
      await writeFile(join(walletDir, 'external-usability-report.json'), JSON.stringify({ toolchainVersion: '5.2.1', protocol, registry, realProofs: true, transport: 'wallet-sdk cross-origin iframe + separate Node signer', name: checkpoint.name,
        transactions: Object.fromEntries(Object.entries(checkpoint.transactions).filter(([k]) => ['address', 'primary'].includes(k))), completedAt: new Date().toISOString(), checks: 4 }, null, 2));
      console.log('ALL 4 EXTERNAL USABILITY CHECKS PASSED');
    } else if (connectOnly) {
      await page.$eval('#wallet-menu', element => { (element as HTMLDetailsElement).open = true; });
      await click('Disconnect wallet');
      await page.waitForFunction(() => !document.querySelector('select[aria-label="Wallet account"]'));
      await click('Find wallets again');
      await click('ANS Test Wallet', 30000);
      await page.waitForFunction(() => document.querySelector<HTMLDetailsElement>('.web-wallet-panel')?.open === true);
      await click('Cancel'); await click('ANS Test Wallet', 30000);
      const retryFrame = await page.waitForFrame(f => f.url().startsWith(walletOrigin));
      await retryFrame.waitForFunction(() => !!document.querySelector('#verification')?.textContent);
      const retryEmoji = await retryFrame.$eval('#verification', e => e.textContent);
      await page.waitForFunction(emoji => document.body.innerText.includes(emoji!), {}, retryEmoji);
      await click('Confirm and connect');
      await page.waitForSelector('select[aria-label="Wallet account"]', { timeout: 60000 });
      await writeFile(join(walletDir, 'external-connection-report.json'), JSON.stringify({ toolchainVersion: '5.2.1', protocol, registry,
        transport: 'wallet-sdk cross-origin iframe + separate Node signer', checks: 3, broadcasts: 0,
        completedAt: new Date().toISOString() }, null, 2));
      console.log('ALL 3 EXTERNAL CONNECTION RECOVERY CHECKS PASSED; no broadcast');
    } else {
      await step('commit', 'Start registration');
      const commitHash = checkpoint.transactions.commit;
      await page.reload();
      await connect();
      assert.equal(checkpoint.transactions.commit, commitHash, 'Reload cannot replace a commit hash');
      console.log('PASS encrypted browser plan resumes after reload and wallet reconnection');
      await step('register', 'Pay and register');
      await verify(); checkpoint.completed = true; await save();
      await writeFile(join(walletDir, 'external-browser-report.json'), JSON.stringify({ toolchainVersion: '5.2.1', protocol, registry, realProofs: true,
        transport: 'wallet-sdk cross-origin iframe + separate Node signer', name: checkpoint.name,
        encryptedReload: true, receiptThreshold: 'confirmed', transactions: checkpoint.transactions,
        completedAt: new Date().toISOString(), checks: 5 }, null, 2));
      console.log('ALL 5 EXTERNAL BROWSER WALLET CHECKS PASSED');
    }
  }
} finally {
  await browser?.close(); await vite?.close(); if (http) { http.close(); await once(http, 'close'); }
  await wallet.stop(); releaseWallet(); release();
}
