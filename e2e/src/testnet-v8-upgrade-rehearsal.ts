/**
 * Isolated V8 public testnet rehearsal CLI.
 * - `--init-accounts --state-dir /var/lib/ans-signer/testnet-v8-upgrade-rehearsal-YYYYMMDD`
 *   generates fresh isolated credentials under `ans-signer` and outputs only public addresses.
 * - Default `--dry-run` verifies canonical Sepolia L1 runtime SHA256 hashes, Aztec 6 testnet
 *   identity (`realProofs: true`, `feePerDaGas === 0`), balances and prints the exact confirmation.
 * - `--send --confirm <exact>` loads the real-proof checkpointed executor under `ans-signer`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import reservations from '../../deployments/reserved-labels.json' with { type: 'json' };
import { readFeeJuiceBalance } from './fee-juice-payment.js';
import { V6_PROFILES, assertV6FeeJuice, assertV6Network } from './v6-network.js';
import {
  DEFAULT_SIGNER_ROOT,
  assertIsolatedSignerDirectory,
  currentSignerIdentity,
  initV8RehearsalAccounts,
  readV8PublicAccounts,
  type SignerIdentity,
  type V8PublicAccounts,
} from './v8-account-generator.js';
import { V8_RESERVED_HASH, prepareV8Rehearsal } from './v8-rehearsal-plan.js';
import { verifyPublicNode } from './v8-real-adapters.js';

export const SEPOLIA_FEE_JUICE_TOKEN = '0x762c132040fda6183066fa3b14d985ee55aa3c18' as const;
export const SEPOLIA_FEE_ASSET_HANDLER = '0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9' as const;
export const SEPOLIA_FEE_JUICE_PORTAL = '0xe59acba462a0324b1d619a7a1b219419f156f505' as const;
/** Full 2,753-byte deployed runtime SHA256 verified against tagged TestERC20.sol + solc 0.8.27 prague/200. */
export const SEPOLIA_TOKEN_RUNTIME_SHA256 =
  'a3abcdecb232f7dcbbc2151cf5efe9d5dc2e042f9b9bcf9b9fc842bbe32876ef';
/** Full 827-byte deployed runtime SHA256 verified against FeeAssetHandler.sol + solc 0.8.27 prague/200. */
export const SEPOLIA_HANDLER_RUNTIME_SHA256 =
  '8d42c56b2f9a4d8c324fbf43a2203e8b5d3900eb5ef1a76de062db53798f080f';

export const APPROVED_MAX_FEE_JUICE_WEI = 350n * 10n ** 18n;
export const APPROVED_MAX_SEPOLIA_ETH_WEI = 6n * 10n ** 15n; // 0.006 ETH
export const APPROVED_L2_PRICE_CEILING = 1_875_000_300_000n; // 1.5x sampled 1,250,000,200,000

export function parseV8RehearsalArgs(argv: string[]) {
  const v = new Map<string, string>();
  const flags = new Set(['--init-accounts', '--dry-run', '--send']);
  const allowed = new Set([
    ...flags,
    '--state-dir',
    '--public-accounts',
    '--confirm',
    '--node-url',
    '--l1-rpc-url',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    assert(allowed.has(key) && !v.has(key), 'Unknown or duplicate V8 rehearsal argument');
    if (flags.has(key)) v.set(key, 'true');
    else {
      assert(argv[i + 1] && !argv[i + 1]!.startsWith('--'), 'Missing V8 rehearsal value');
      v.set(key, argv[++i]!);
    }
  }
  const modeCount = ['--init-accounts', '--dry-run', '--send'].filter((f) => v.has(f)).length;
  assert(modeCount <= 1, 'Choose at most one of --init-accounts, --dry-run or --send');
  const stateDir = v.get('--state-dir') ? resolve(v.get('--state-dir')!) : undefined;
  assert(stateDir, '--state-dir is required');
  if (v.has('--init-accounts')) {
    for (const extra of ['--confirm', '--node-url', '--l1-rpc-url', '--public-accounts'])
      assert(!v.has(extra), `--init-accounts refuses ${extra}`);
  }
  const nodeUrl = v.get('--node-url') ?? V6_PROFILES['testnet-v6'].nodeUrl;
  const l1Rpc = v.get('--l1-rpc-url') ?? 'https://ethereum-sepolia-rpc.publicnode.com';
  for (const url of [nodeUrl, l1Rpc]) {
    const u = new URL(url);
    assert(
      u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash,
      'Clean HTTPS public RPC URL required',
    );
  }
  return {
    initAccounts: v.has('--init-accounts'),
    send: v.has('--send'),
    dryRun: !v.has('--init-accounts') && !v.has('--send'),
    stateDir,
    publicAccountsPath: resolve(v.get('--public-accounts') ?? join(stateDir, 'public.json')),
    confirm: v.get('--confirm'),
    nodeUrl,
    l1Rpc,
  };
}

export function v8RehearsalConfirmation(accounts: V8PublicAccounts) {
  return [
    'v8-rehearsal:testnet-v6:6.0.0:11155111:679261766',
    `root=${metadata.v8.classId}`,
    `successor=${metadata.v8Rehearsal.classId}`,
    `reserved=${V8_RESERVED_HASH}`,
    `owner=${accounts.actors.A.address}`,
    `holder=${accounts.actors.B.address}`,
    `recipient=${accounts.actors.C.address}`,
    `l1=${accounts.l1FundingAddress.toLowerCase()}`,
    'maxFJ=350:maxETH=0.006',
  ].join(':');
}

export function sha256HexBytes(bytecodeHex: string) {
  assert(/^0x[0-9a-fA-F]+$/.test(bytecodeHex) && bytecodeHex.length > 2, 'Nonempty bytecode required');
  return createHash('sha256').update(Buffer.from(bytecodeHex.slice(2), 'hex')).digest('hex');
}

export async function verifyCanonicalSepoliaContracts(l1: {
  getChainId: () => Promise<number>;
  getCode: (args: { address: Hex }) => Promise<Hex | undefined>;
}) {
  assert.equal(await l1.getChainId(), 11155111, 'Sepolia chain ID 11155111 required');
  const [tokenCode, handlerCode] = await Promise.all([
    l1.getCode({ address: SEPOLIA_FEE_JUICE_TOKEN }),
    l1.getCode({ address: SEPOLIA_FEE_ASSET_HANDLER }),
  ]);
  assert(tokenCode && handlerCode, 'Canonical Sepolia FeeJuice contracts missing');
  assert.equal(
    sha256HexBytes(tokenCode),
    SEPOLIA_TOKEN_RUNTIME_SHA256,
    'Canonical Sepolia FeeJuice token runtime SHA256 mismatch',
  );
  assert.equal(
    sha256HexBytes(handlerCode),
    SEPOLIA_HANDLER_RUNTIME_SHA256,
    'Canonical Sepolia FeeAssetHandler runtime SHA256 mismatch',
  );
}

export const v8RehearsalCliDeps = {
  signerIdentity: currentSignerIdentity,
  createNode: (url: string) => createAztecNodeClient(url, { maxBatchSize: 3 }),
  createL1: (url: string) =>
    createPublicClient({ chain: sepolia, transport: http(url, { timeout: 20_000, retryCount: 0 }) }),
};

export async function main(
  argv = process.argv.slice(2),
  deps: {
    signerIdentity: () => SignerIdentity;
    createNode: typeof v8RehearsalCliDeps.createNode;
    createL1: typeof v8RehearsalCliDeps.createL1;
  } = v8RehearsalCliDeps,
) {
  process.umask(0o077);
  const c = parseV8RehearsalArgs(argv);
  const signer = deps.signerIdentity();

  if (c.initAccounts) {
    const created = await initV8RehearsalAccounts(c.stateDir, { identity: signer });
    console.log(JSON.stringify(created, null, 2));
    return created;
  }

  const plan = prepareV8Rehearsal(
    reservations,
    c.stateDir,
    signer.signerRoot ?? DEFAULT_SIGNER_ROOT,
  );
  const accounts = await readV8PublicAccounts(c.publicAccountsPath);
  const confirm = v8RehearsalConfirmation(accounts);

  if (c.send) {
    await assertIsolatedSignerDirectory(c.stateDir, signer, true);
    assert.equal(c.confirm, confirm, 'Explicit --send and exact --confirm required');
  }

  const used = new Set<string>();
  const rawNode = deps.createNode(c.nodeUrl);
  const allowedReads = new Set([
    'getNodeInfo',
    'getCurrentMinFees',
    'getContract',
    'getContractClass',
    'getPublicStorageAt',
  ]);
  const preflightNode = new Proxy(rawNode, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const name = String(prop);
        assert(allowedReads.has(name), `DRY-RUN forbidden node method: ${name}`);
        used.add(name);
        return value.apply(target, args);
      };
    },
  });
  const info = await preflightNode.getNodeInfo();
  verifyPublicNode(info);
  const identity = assertV6Network('testnet-v6', info, c.nodeUrl);
  assertV6FeeJuice('testnet-v6', info);
  assert.equal(
    info.l1ContractAddresses.feeJuiceAddress.toString().toLowerCase(),
    SEPOLIA_FEE_JUICE_TOKEN,
    'Node feeJuiceAddress differs from verified Sepolia token',
  );
  assert.equal(
    info.l1ContractAddresses.feeJuicePortalAddress.toString().toLowerCase(),
    SEPOLIA_FEE_JUICE_PORTAL,
    'Node feeJuicePortalAddress differs from verified Sepolia portal',
  );
  assert.equal(
    info.l1ContractAddresses.feeAssetHandlerAddress?.toString().toLowerCase(),
    SEPOLIA_FEE_ASSET_HANDLER,
    'Node feeAssetHandlerAddress differs from verified Sepolia handler',
  );

  const l1 = deps.createL1(c.l1Rpc);
  await verifyCanonicalSepoliaContracts(l1);

  const [minFees, l1BalanceWei, gasPriceWei, fjA, fjB, fjC] = await Promise.all([
    preflightNode.getCurrentMinFees(),
    l1.getBalance({ address: accounts.l1FundingAddress }),
    l1.getGasPrice(),
    readFeeJuiceBalance(preflightNode, AztecAddress.fromStringUnsafe(accounts.actors.A.address)),
    readFeeJuiceBalance(preflightNode, AztecAddress.fromStringUnsafe(accounts.actors.B.address)),
    readFeeJuiceBalance(preflightNode, AztecAddress.fromStringUnsafe(accounts.actors.C.address)),
  ]);
  assert.equal(minFees.feePerDaGas, 0n, 'DA fee changed from zero: STOP');
  assert(
    minFees.feePerL2Gas <= APPROVED_L2_PRICE_CEILING,
    'Aztec L2 min fee exceeds approved ceiling',
  );

  if (c.send) {
    const { sendV8Rehearsal } = await import('./v8-rehearsal-send.js');
    return sendV8Rehearsal(
      {
        stateDir: c.stateDir,
        nodeUrl: c.nodeUrl,
        l1Rpc: c.l1Rpc,
        confirmation: confirm,
      },
      accounts,
      rawNode,
      signer,
    );
  }

  const allBridged = fjA > 0n && fjB > 0n && fjC > 0n;
  const fundingReady = allBridged || l1BalanceWei >= APPROVED_MAX_SEPOLIA_ETH_WEI;
  const summary = {
    mode: 'dry-run' as const,
    status: fundingReady ? ('READY_FOR_CONFIRMED_SEND' as const) : ('FUNDING_REQUIRED' as const),
    identity,
    canonicalSepoliaVerified: {
      token: SEPOLIA_FEE_JUICE_TOKEN,
      tokenRuntimeSha256: SEPOLIA_TOKEN_RUNTIME_SHA256,
      handler: SEPOLIA_FEE_ASSET_HANDLER,
      handlerRuntimeSha256: SEPOLIA_HANDLER_RUNTIME_SHA256,
      portal: SEPOLIA_FEE_JUICE_PORTAL,
    },
    fees: {
      feePerDaGas: String(minFees.feePerDaGas),
      feePerL2Gas: String(minFees.feePerL2Gas),
      approvedL2PriceCeiling: String(APPROVED_L2_PRICE_CEILING),
      sepoliaGasPriceWei: String(gasPriceWei),
    },
    l1Funding: {
      address: accounts.l1FundingAddress,
      balanceWei: String(l1BalanceWei),
      requiredWei: String(APPROVED_MAX_SEPOLIA_ETH_WEI),
      topUpWei: String(
        l1BalanceWei >= APPROVED_MAX_SEPOLIA_ETH_WEI
          ? 0n
          : APPROVED_MAX_SEPOLIA_ETH_WEI - l1BalanceWei,
      ),
    },
    l2Actors: {
      A: { ...accounts.actors.A, balanceWei: String(fjA) },
      B: { ...accounts.actors.B, balanceWei: String(fjB) },
      C: { ...accounts.actors.C, balanceWei: String(fjC) },
    },
    budget: plan.budget,
    waits: plan.waits,
    nodeMethods: [...used],
    confirmation: confirm,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message.split('\n')[0] : 'Rehearsal failed';
    console.error(`V8 rehearsal stopped: ${message}`);
    process.exitCode = 1;
  });
}
