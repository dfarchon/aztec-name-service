/** Browser wallet-sdk acceptance with a separate real-proof Aztec 6 signer; no dApp-injected Wallet object. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { constants, existsSync } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSchnorrInitializerlessAccountContractAddress } from '@aztec-labs/accounts/schnorr';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import {
  WalletSchema,
  type AppCapabilities,
  type BatchedMethod,
  type BatchResults,
  type Wallet,
} from '@aztec-labs/aztec.js/wallet';
import { createSafeJsonRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import {
  computeContractAddressFromInstance,
  getContractClassFromArtifact,
} from '@aztec-labs/stdlib/contract';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import {
  getAvailability,
  getName,
  RegistryReader,
  resolveAddress,
  resolvePrimary,
  trackTx,
} from 'fog-sdk';
import { createServer as createViteServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { randomKeys, sleep, sponsoredFpc } from './common.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { privateDirectory, savePrivateJson } from './testnet-v6-e2e-state.js';
import { assertV6Fpc, assertV6Network, V6_PROFILES } from './v6-network.js';
import publicDeployment from '../../deployments/testnet-v6.json' with { type: 'json' };

type BrowserKeysFile = {
  toolchainVersion: '6.0.0';
  registry: string;
  account: {
    address: string;
    secret: string;
    salt: string;
    signingKey: string;
  };
};

type BrowserCheckpoint = {
  registry: string;
  name: string;
  transactions: Record<string, string>;
  blockNumbers?: Record<string, number>;
  completed?: boolean;
};

const chromeCandidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function resolveChromePath(): string {
  const found = process.env.CHROME_PATH ?? chromeCandidates.find((path) => existsSync(path));
  assert.ok(found, 'Chrome executable not found; set CHROME_PATH');
  return found;
}

async function readPrivateJson<T>(path: string): Promise<T | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Cannot open private browser state file');
  }
  try {
    const s = await file.stat();
    assert.ok(
      s.isFile() && s.uid === process.getuid!() && (s.mode & 0o777) === 0o600,
      'Private browser state file must be owned and 0600',
    );
    return JSON.parse(await file.readFile('utf8')) as T;
  } finally {
    await file.close();
  }
}

const customAppOrigin = process.env.APP_ORIGIN;
const appOrigin = customAppOrigin ?? 'http://127.0.0.1:5191';
const walletOrigin = 'http://127.0.0.1:5194';
const walletUrl = `${walletOrigin}/scripts/fixtures/external-wallet.html`;
const manageOnly = process.argv.includes('--manage-only');
const connectOnly = process.argv.includes('--connect-only');
assert(
  process.argv.slice(2).every((arg) => ['--manage-only', '--connect-only'].includes(arg)),
  'Unknown browser acceptance option',
);
assert(!(connectOnly && manageOnly), 'Choose one browser acceptance scenario');
assert.equal(publicDeployment.aztecVersion, '6.0.0', 'Expected Aztec 6.0.0 deployment');
assert.equal(publicDeployment.protocol, 8, 'Expected NameRegistryV8 deployment');

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const stateDir = resolve(
  process.env.TESTNET_BROWSER_STATE_DIR ??
    join(homedir(), '.local/share/fog/testnet-aztec6-6.0.0-v8-browser'),
);
const rel = relative(repoRoot, stateDir);
assert.ok(
  isAbsolute(rel) || rel === '..' || rel.startsWith('../'),
  'Keep private browser state outside the repository',
);

const previousMask = process.umask(0o077);
const profile = V6_PROFILES['testnet-v6'];
assert.equal(publicDeployment.nodeUrl, profile.nodeUrl, 'Deployment nodeUrl mismatch');
const rawNode = createAztecNodeClient(publicDeployment.nodeUrl, {
  maxBatchSize: profile.maxBatchSize,
});
const info = await rawNode.getNodeInfo();
assertV6Network('testnet-v6', info, publicDeployment.nodeUrl);

const fpc = await sponsoredFpc();
const publishedFpc = await rawNode.getContract(fpc.instance.address);
assertV6Fpc(
  'testnet-v6',
  fpc.instance,
  (await getContractClassFromArtifact(fpc.artifact)).id.toString(),
  publishedFpc,
);
assert.equal(fpc.instance.address.toString(), publicDeployment.sponsoredFpc);

await privateDirectory(stateDir);
await mkdir(join(stateDir, 'wallets/user'), { recursive: true, mode: 0o700 });
await mkdir(join(stateDir, 'external-browser-profile'), { recursive: true, mode: 0o700 });
const release = acquireTestnetLock(join(stateDir, 'runner.lock'));
process.once('exit', release);

const keysPath = join(stateDir, 'keys.json');
let keysFile = await readPrivateJson<BrowserKeysFile>(keysPath);
if (!keysFile) {
  const generated = randomKeys();
  const address = await getSchnorrInitializerlessAccountContractAddress(
    generated.signingKey,
    generated.salt,
    generated.secret,
  );
  keysFile = {
    toolchainVersion: '6.0.0',
    registry: publicDeployment.registry,
    account: {
      address: address.toString(),
      secret: generated.secret.toString(),
      salt: generated.salt.toString(),
      signingKey: generated.signingKey.toString(),
    },
  };
  await savePrivateJson(keysPath, keysFile);
}
assert.equal(keysFile.toolchainVersion, '6.0.0', 'Browser keys toolchain mismatch');
assert.equal(keysFile.registry, publicDeployment.registry, 'Browser keys registry mismatch');

const reader = await RegistryReader.connect(
  rawNode,
  AztecAddress.fromStringUnsafe(publicDeployment.registry),
);
assert.equal(reader.classId, publicDeployment.classIds.registry, 'Registry class mismatch');

const checkpointPath = join(stateDir, 'external-browser.json');
let checkpoint = await readPrivateJson<BrowserCheckpoint>(checkpointPath);
if (!checkpoint) {
  let candidate = '';
  for (let i = 0; i < 50; i++) {
    const next = `extv8${randomBytes(2).toString('hex')}`;
    const [avail, eligible] = await Promise.all([
      getAvailability(reader, next),
      reader.eligibility(next),
    ]);
    if (avail.available && eligible === 'open') {
      candidate = next;
      break;
    }
  }
  assert.ok(candidate.length >= publicDeployment.minPublicLength, 'Unable to allocate open V8 name');
  checkpoint = {
    registry: publicDeployment.registry,
    name: candidate,
    transactions: {},
    blockNumbers: {},
  };
}
assert.equal(checkpoint.registry, publicDeployment.registry, 'Checkpoint registry mismatch');
assert.ok(
  /^[a-z0-9]{7,31}$/.test(checkpoint.name) &&
    checkpoint.name.length >= publicDeployment.minPublicLength,
  'Checkpoint name does not satisfy Free Launch minimum length',
);
const saveCheckpoint = () => savePrivateJson(checkpointPath, checkpoint);
await saveCheckpoint();

let activeStep = '';
let broadcasts = 0;
const node = new Proxy(rawNode, {
  get(target, prop) {
    if (prop === 'sendTx')
      return async (tx: Parameters<typeof rawNode.sendTx>[0]) => {
        assert.ok(!connectOnly, 'Refusing browser broadcast in --connect-only mode');
        assert.ok(
          activeStep && !checkpoint.transactions[activeStep],
          'Refusing duplicate browser broadcast',
        );
        broadcasts++;
        checkpoint.transactions[activeStep] = tx.getTxHash().toString();
        await saveCheckpoint();
        return target.sendTx(tx);
      };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const wallet = await EmbeddedWallet.create(node, {
  pxe: { proverEnabled: true, dataDirectory: join(stateDir, 'wallets/user') },
});

let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
let appServer: ReturnType<typeof createServer> | undefined;
let http: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

try {
  const k = keysFile.account;
  const account = await wallet.createSchnorrInitializerlessAccount(
    Fr.fromString(k.secret),
    Fr.fromString(k.salt),
    Fq.fromString(k.signingKey),
  );
  assert.equal(account.address.toString(), k.address);
  assert.equal((await wallet.getAccounts()).length, 1);

  const waitPublic = async <T>(check: () => Promise<T>): Promise<T> => {
    const deadline = Date.now() + 60000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await check();
      } catch (e) {
        lastError = e;
        await sleep(2000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };

  const verify = () =>
    waitPublic(async () => {
      const held = await getName(reader, checkpoint.name);
      assert.equal(held.status, 'active');
      assert.ok(held.record.owner.equals(account.address));
    });

  if (checkpoint.completed && !connectOnly && !manageOnly) {
    await verify();
    console.log('PASS completed browser acceptance readback; no broadcast');
  } else {
    const grantedAccounts = new Set<string>();
    const grantedContracts = new Set<string>();
    const capabilityRequests: AppCapabilities[] = [];

    const assertAccountGranted = (method: string) => {
      assert.ok(grantedAccounts.size > 0, `${method} called before requestCapabilities`);
    };
    const assertContractGranted = (address: AztecAddress, method: string) => {
      assert.ok(
        grantedContracts.has(address.toString()),
        `${method} called without capability grant for ${address.toString()}`,
      );
    };

    const guardedWallet: Wallet = {
      getChainInfo: () => wallet.getChainInfo(),
      requestCapabilities: async (manifest) => {
        assert.equal(manifest.version, '1.0');
        grantedAccounts.clear();
        grantedContracts.clear();
        for (const c of manifest.capabilities) {
          if (c.type === 'accounts') {
            grantedAccounts.add(account.address.toString());
          } else if (c.type === 'contracts') {
            assert.ok(c.contracts !== '*', 'Wildcard contract grant forbidden');
            for (const address of c.contracts) {
              assert.ok(!address.isZero(), 'Zero contract grant forbidden');
              grantedContracts.add(address.toString());
            }
          } else if (c.type === 'simulation') {
            const txScope = c.transactions?.scope;
            assert.ok(txScope !== '*', 'Wildcard tx simulation scope forbidden');
            for (const p of txScope ?? []) {
              assert.ok(p.contract !== '*', 'Wildcard tx simulation contract forbidden');
            }
            const utilScope = c.utilities?.scope;
            assert.ok(utilScope !== '*', 'Wildcard utility simulation scope forbidden');
            for (const p of utilScope ?? []) {
              assert.ok(p.contract !== '*', 'Wildcard utility simulation contract forbidden');
            }
          } else if (c.type === 'transaction') {
            assert.ok(c.scope !== '*', 'Wildcard transaction scope forbidden');
            for (const p of c.scope) {
              assert.ok(p.contract !== '*', 'Wildcard transaction contract forbidden');
            }
          }
        }
        capabilityRequests.push(manifest);
        return {
          version: '1.0',
          wallet: { name: 'Fog Test Wallet', version: '6.0.0' },
          granted: manifest.capabilities.map((c) =>
            c.type === 'accounts'
              ? { ...c, accounts: [{ alias: 'External Browser User', item: account.address }] }
              : c,
          ),
        };
      },
      getAccounts: async () => {
        assertAccountGranted('getAccounts');
        return wallet.getAccounts();
      },
      registerContract: async (instance, artifact, secretKey) => {
        const address = await computeContractAddressFromInstance(instance);
        assertContractGranted(address, 'registerContract');
        return wallet.registerContract(instance, artifact, secretKey);
      },
      getContractMetadata: async (address) => {
        assertContractGranted(address, 'getContractMetadata');
        return wallet.getContractMetadata(address);
      },
      getContractClassMetadata: async (id) => {
        assertAccountGranted('getContractClassMetadata');
        return wallet.getContractClassMetadata(id);
      },
      registerContractClass: async (artifact) => {
        assertAccountGranted('registerContractClass');
        return wallet.registerContractClass(artifact);
      },
      simulateTx: async (exec, opts) => {
        assertAccountGranted('simulateTx');
        for (const call of exec.calls) assertContractGranted(call.to, 'simulateTx');
        return wallet.simulateTx(exec, opts);
      },
      executeUtility: async (call, opts) => {
        assertAccountGranted('executeUtility');
        assertContractGranted(call.to, 'executeUtility');
        return wallet.executeUtility(call, opts);
      },
      profileTx: async (exec, opts) => {
        assertAccountGranted('profileTx');
        for (const call of exec.calls) assertContractGranted(call.to, 'profileTx');
        return wallet.profileTx(exec, opts);
      },
      createAuthWit: async (from, messageHashOrIntent) => {
        assertAccountGranted('createAuthWit');
        assert.ok(grantedAccounts.has(from.toString()), 'Unauthorized createAuthWit account');
        return wallet.createAuthWit(from, messageHashOrIntent);
      },
      sendTx: async (exec, opts) => {
        assertAccountGranted('sendTx');
        for (const call of exec.calls) assertContractGranted(call.to, 'sendTx');
        return wallet.sendTx(exec, opts);
      },
      getPrivateEvents: async () => {
        throw new Error('Private events capability not granted');
      },
      registerSender: async () => {
        throw new Error('Address book capability not granted');
      },
      getAddressBook: async () => {
        throw new Error('Address book capability not granted');
      },
      batch: async <const T extends readonly BatchedMethod[]>(
        methods: T,
      ): Promise<BatchResults<T>> => {
        const results: unknown[] = [];
        for (const method of methods) {
          const fn = guardedWallet[method.name] as (...args: unknown[]) => Promise<unknown>;
          results.push({ name: method.name, result: await fn(...method.args) });
        }
        return results as BatchResults<T>;
      },
    };

    let emittedHeaders: Record<string, string> | undefined;
    if (!customAppOrigin) {
      execFileSync(process.execPath, ['scripts/build-testnet.mjs'], {
        cwd: repoRoot,
        env: { ...process.env, FOG_PUBLIC_WALLET_URLS: walletUrl },
        stdio: 'inherit',
      });
      const dist = resolve(repoRoot, 'web/dist');
      const headersFile = await readFile(resolve(dist, '_headers'), 'utf8');
      const headers: Record<string, string> = {};
      for (const line of headersFile.split('\n').slice(1)) {
        if (!line.startsWith('  ')) break;
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
      assert.ok(headers['Content-Security-Policy']?.includes(`frame-src 'self' ${walletOrigin}`));
      assert.ok(headers['Content-Security-Policy']?.includes("connect-src 'self' data: https: wss:"));
      emittedHeaders = headers;
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml',
      };
      appServer = createServer(async (req, res) => {
        if (req.url === '/api/metrics') {
          res.writeHead(204);
          res.end();
          return;
        }
        const pathname = new URL(req.url ?? '/', appOrigin).pathname;
        const filePath = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!filePath.startsWith(dist + sep)) {
          res.writeHead(404);
          res.end();
          return;
        }
        try {
          const bytes = await readFile(filePath);
          res.writeHead(200, {
            ...headers,
            'Content-Type': types[extname(filePath)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          res.end(bytes);
        } catch {
          res.writeHead(404);
          res.end();
        }
      });
      appServer.listen(5191, '127.0.0.1');
      await once(appServer, 'listening');
    }

    const tokenHeader = randomBytes(32).toString('hex');
    const rpc = createSafeJsonRpcServer<Wallet>(guardedWallet, WalletSchema, {
      corsAllowedOrigins: [walletOrigin],
      corsAllowedHeaders: ['content-type', 'x-fog-wallet-token'],
      maxBodySizeBytes: '16mb',
      middlewares: [
        async (
          ctx: { method: string; headers: Record<string, unknown>; status: number },
          next: () => Promise<unknown>,
        ) => {
          if (ctx.method !== 'OPTIONS' && ctx.headers['x-fog-wallet-token'] !== tokenHeader) {
            ctx.status = 403;
            return;
          }
          await next();
        },
      ],
    });
    http = createServer(rpc.getApp().callback());
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    assert.ok(address && typeof address !== 'string');

    const walletCfg = {
      rpc: `http://127.0.0.1:${address.port}`,
      token: tokenHeader,
      appOrigin,
      chainId: String(info.l1ChainId),
      rollupVersion: String(info.rollupVersion),
    };
    vite = await createViteServer({
      root: resolve(repoRoot, 'web'),
      cacheDir: resolve(repoRoot, 'web/node_modules/.vite-external-wallet'),
      plugins: [
        {
          name: 'external-wallet-test-config',
          transformIndexHtml(html, context) {
            return context.path.includes('external-wallet')
              ? html.replace(
                  '<script type="module"',
                  `<script>window.__FOG_WALLET_TEST_CONFIG__=${JSON.stringify(walletCfg)}</script><script type="module"`,
                )
              : html;
          },
        },
      ],
      optimizeDeps: {
        include: [
          'vite-plugin-node-polyfills/shims/buffer',
          'vite-plugin-node-polyfills/shims/global',
          'vite-plugin-node-polyfills/shims/process',
        ],
      },
      server: {
        host: '127.0.0.1',
        port: 5194,
        strictPort: true,
        headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' },
      },
    });
    await vite.listen();

    browser = await puppeteer.launch({
      executablePath: resolveChromePath(),
      headless: true,
      userDataDir: join(stateDir, 'external-browser-profile'),
      args: process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCacheEnabled(false);
    const diagnostics = await page.createCDPSession();
    diagnostics.on('Network.loadingFailed', (e) => {
      if (e.blockedReason) console.error('Browser policy:', e.blockedReason);
    });
    diagnostics.on('Audits.issueAdded', ({ issue }) => {
      if (issue.details.blockedByResponseIssueDetails)
        console.error('Browser issue:', issue.details.blockedByResponseIssueDetails.reason);
    });
    await diagnostics.send('Network.enable');
    await diagnostics.send('Audits.enable');
    page.on('pageerror', (e) =>
      console.error(
        'Browser runtime:',
        (e instanceof Error ? e.message : String(e)).replace(/0x[\da-f]+/gi, '[field]').slice(0, 300),
      ),
    );
    page.on('console', (m) => {
      if (m.type() === 'error')
        console.error('Browser error:', m.text().replace(/0x[\da-f]+/gi, '[field]').slice(0, 300));
    });
    page.on('requestfailed', (r) => {
      if (r.url().startsWith(walletOrigin))
        console.error(
          'Wallet resource failed:',
          new URL(r.url()).pathname,
          r.resourceType(),
          r.failure()?.errorText,
        );
    });
    await page.evaluateOnNewDocument(
      (origin, cfg) => {
        if (location.origin === origin) Object.assign(window, { __FOG_WALLET_TEST_CONFIG__: cfg });
        else localStorage.setItem('fog:locale', 'en');
      },
      walletOrigin,
      walletCfg,
    );

    // Finish the wallet's first dependency optimization before its discovery timeout begins.
    await page.goto(walletUrl);
    await page.waitForFunction(() => document.body.dataset.walletReady === 'true', {
      timeout: 180000,
    });

    const click = async (label: string, timeout = 180000) => {
      await page.waitForFunction(
        (target) =>
          [...document.querySelectorAll('button')].some(
            (b) => b.textContent?.trim() === target && !b.disabled,
          ),
        { timeout },
        label,
      );
      for (const b of await page.$$('button'))
        if (await b.evaluate((el, target) => el.textContent?.trim() === target, label)) {
          await b.click();
          return;
        }
    };

    const expectedContracts = [
      publicDeployment.registry,
      publicDeployment.registrar,
      publicDeployment.resolver,
      publicDeployment.sponsoredFpc,
    ].sort();

    const verifyCapabilities = () => {
      assert.ok(capabilityRequests.length >= 1, 'Expected Aztec 6 capability negotiation');
      const manifest = capabilityRequests.at(-1)!;
      const contractsCap = manifest.capabilities.find((c) => c.type === 'contracts');
      assert.ok(contractsCap && contractsCap.contracts !== '*', 'Expected explicit contract list');
      const requested = contractsCap.contracts.map((a) => a.toString()).sort();
      assert.ok(
        !requested.includes(AztecAddress.ZERO.toString()),
        'Zero contract address must not be requested',
      );
      assert.deepEqual(
        requested,
        expectedContracts,
        'Capability manifest must request exact [registry, registrar, resolver, sponsoredFpc]',
      );
    };

    if (manageOnly) await verify();
    const initialRoute = manageOnly
      ? `${appOrigin}/#/manage/${checkpoint.name}`
      : `${appOrigin}/#/register/${checkpoint.name}`;
    const appResponse = await page.goto(initialRoute);
    if (emittedHeaders) {
      assert.equal(
        appResponse?.headers()['content-security-policy'],
        emittedHeaders['Content-Security-Policy'],
      );
    }

    const connect = async () => {
      const priorRequests = capabilityRequests.length;
      await page.waitForFunction(
        () =>
          document.querySelector('#wallet-menu > summary')?.getAttribute('aria-disabled') ===
          'false',
        { timeout: 180000 },
      );
      const isOpen = await page.$eval('#wallet-menu', (el) => (el as HTMLDetailsElement).open);
      if (!isOpen) await page.locator('#wallet-menu > summary').click();
      await click('Fog Test Wallet', 60000);
      const frame = await page.waitForFrame((f) => f.url().startsWith(walletOrigin), {
        timeout: 60000,
      });
      await frame.waitForFunction(() => !!document.querySelector('#verification')?.textContent, {
        timeout: 60000,
      });
      const emoji = await frame.$eval('#verification', (e) => e.textContent);
      await page.waitForFunction(
        (value) => document.body.innerText.includes(value!),
        { timeout: 60000 },
        emoji,
      );
      await page.setViewport({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Wallet connection fits mobile viewport',
      );
      await click('Confirm and connect', 60000);
      await page.waitForSelector('select[aria-label="Wallet account"]', { timeout: 120000 });
      assert.equal(
        await page.$eval(
          'select[aria-label="Wallet account"]',
          (el) => (el as HTMLSelectElement).value,
        ),
        account.address.toString(),
      );
      await page.setViewport({ width: 1280, height: 900 });
      await page.$eval('#wallet-menu', (el) => {
        (el as HTMLDetailsElement).open = false;
      });
      assert.ok(capabilityRequests.length > priorRequests, 'Expected capability grant on connect');
      verifyCapabilities();
    };

    await connect();
    console.log(
      'PASS external iframe discovery, ECDH emoji match, Aztec 6 capability grant and account authorization',
    );

    const step = async (name: string, button: string, buttonTimeout = 180000) => {
      if (!checkpoint.transactions[name]) {
        activeStep = name;
        await click(button, buttonTimeout);
        const deadline = Date.now() + 600000;
        while (!checkpoint.transactions[name]) {
          const error = await page.$('.txline.err');
          if (error)
            throw new Error(await error.evaluate((e) => e.textContent ?? 'Browser signing failed'));
          if (Date.now() > deadline)
            throw new Error(`Browser did not reach the separate signer for ${name}`);
          await sleep(1000);
        }
      }
      const tracked = await trackTx(node, checkpoint.transactions[name], {
        waitFor: 'confirmed',
        timeoutMs: 1800000,
      });
      if (tracked.blockNumber !== undefined) {
        checkpoint.blockNumbers ??= {};
        checkpoint.blockNumbers[name] = tracked.blockNumber;
        await saveCheckpoint();
      }
      activeStep = '';
      console.log(
        `PASS browser ${name} real-proof transaction tx=${checkpoint.transactions[name]} block=${tracked.blockNumber ?? 'unknown'}`,
      );
    };

    if (manageOnly) {
      await step('address', 'Use wallet address');
      await waitPublic(async () => {
        const forward = await resolveAddress(reader, checkpoint.name);
        assert.ok(forward.status === 'resolved' && forward.address.equals(account.address));
      });
      await page.evaluate((name) => {
        location.hash = `/name/${name}`;
      }, checkpoint.name);
      await page.waitForFunction(() => !document.body.innerText.includes('Use wallet address'));
      await page.evaluate((name) => {
        location.hash = `/manage/${name}`;
      }, checkpoint.name);
      await step('primary', 'Set primary name');
      await waitPublic(async () => {
        const primary = await resolvePrimary(reader, account.address);
        assert.ok(primary.status === 'verified' && primary.name === checkpoint.name);
      });
      console.log('PASS browser address and primary public-chain readback');
      await savePrivateJson(join(stateDir, 'external-usability-report.json'), {
        toolchainVersion: '6.0.0',
        protocol: publicDeployment.protocol,
        registry: publicDeployment.registry,
        realProofs: true,
        transport: 'wallet-sdk cross-origin iframe + separate Node signer',
        name: checkpoint.name,
        transactions: Object.fromEntries(
          Object.entries(checkpoint.transactions).filter(([k]) => ['address', 'primary'].includes(k)),
        ),
        blockNumbers: Object.fromEntries(
          Object.entries(checkpoint.blockNumbers ?? {}).filter(([k]) =>
            ['address', 'primary'].includes(k),
          ),
        ),
        completedAt: new Date().toISOString(),
        checks: 4,
      });
      console.log('ALL 4 EXTERNAL USABILITY CHECKS PASSED');
    } else if (connectOnly) {
      await page.$eval('#wallet-menu', (element) => {
        (element as HTMLDetailsElement).open = true;
      });
      await click('Disconnect wallet');
      await page.waitForFunction(() => !document.querySelector('select[aria-label="Wallet account"]'));
      await click('Find wallets again');
      await click('Fog Test Wallet', 60000);
      await page.waitForFunction(
        () => document.querySelector<HTMLDetailsElement>('.web-wallet-panel')?.open === true,
      );
      await click('Cancel');
      await click('Fog Test Wallet', 60000);
      const retryFrame = await page.waitForFrame((f) => f.url().startsWith(walletOrigin), {
        timeout: 60000,
      });
      await retryFrame.waitForFunction(
        () => !!document.querySelector('#verification')?.textContent,
        { timeout: 60000 },
      );
      const retryEmoji = await retryFrame.$eval('#verification', (e) => e.textContent);
      await page.waitForFunction(
        (value) => document.body.innerText.includes(value!),
        { timeout: 60000 },
        retryEmoji,
      );
      await click('Confirm and connect', 60000);
      await page.waitForSelector('select[aria-label="Wallet account"]', { timeout: 120000 });
      verifyCapabilities();
      assert.equal(broadcasts, 0);
      await savePrivateJson(join(stateDir, 'external-connection-report.json'), {
        toolchainVersion: '6.0.0',
        protocol: publicDeployment.protocol,
        registry: publicDeployment.registry,
        transport: 'wallet-sdk cross-origin iframe + separate Node signer',
        checks: 3,
        broadcasts,
        completedAt: new Date().toISOString(),
      });
      console.log('ALL 3 EXTERNAL CONNECTION RECOVERY CHECKS PASSED; no broadcast');
    } else {
      if (!checkpoint.transactions.commit) {
        await page.waitForFunction(
          () =>
            document.body.innerText.includes('1 year (365 days)') &&
            document.body.innerText.includes('Free'),
          { timeout: 90000 },
        );
      }
      await step('commit', 'Start registration');
      const commitHash = checkpoint.transactions.commit;
      await page.waitForFunction(
        (hash) => document.body.innerText.includes(hash),
        { timeout: 60000 },
        commitHash,
      );
      await page.reload();
      await connect();
      await page.waitForFunction(
        (hash) => document.body.innerText.includes(hash),
        { timeout: 60000 },
        commitHash,
      );
      assert.equal(
        checkpoint.transactions.commit,
        commitHash,
        'Reload cannot replace a commit hash',
      );
      console.log('PASS encrypted browser plan resumes after reload and wallet reconnection');
      await step('register', 'Register for free', 240000);
      await verify();
      checkpoint.completed = true;
      await saveCheckpoint();
      await savePrivateJson(join(stateDir, 'external-browser-report.json'), {
        toolchainVersion: '6.0.0',
        protocol: publicDeployment.protocol,
        registry: publicDeployment.registry,
        realProofs: true,
        transport: 'wallet-sdk cross-origin iframe + separate Node signer',
        name: checkpoint.name,
        encryptedReload: true,
        receiptThreshold: 'confirmed',
        transactions: checkpoint.transactions,
        blockNumbers: checkpoint.blockNumbers ?? {},
        completedAt: new Date().toISOString(),
        checks: 5,
      });
      console.log('ALL 5 EXTERNAL BROWSER WALLET CHECKS PASSED');
    }
  }
} finally {
  try {
    await browser?.close();
    await vite?.close();
    for (const server of [appServer, http]) {
      if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
    }
    await wallet.stop();
  } finally {
    release();
    process.removeListener('exit', release);
    process.umask(previousMask);
  }
}
