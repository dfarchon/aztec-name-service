/** Default read-only rehearsal. The sending implementation is loaded only after exact explicit confirmation. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { readFeeJuiceBalance } from './fee-juice-payment.js';
import { physicalPath } from './deploy-v6.js';
import { V6_PROFILES, assertV6Network, assertV6FeeJuice, dryRunNode } from './v6-network.js';
import {
  rehearsalPlan,
  rehearsalConfirmation,
  type RehearsalConfig,
} from './launch-rehearsal-plan.js';
export function parseRehearsalArgs(argv: string[]) {
  const v = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    assert(
      ['--dry-run', '--send', '--confirm', '--state-dir', '--node-url', '--l1-rpc-url'].includes(
        key,
      ) && !v.has(key),
      'Unknown or duplicate rehearsal argument',
    );
    if (['--dry-run', '--send'].includes(key)) v.set(key, 'true');
    else {
      assert(argv[i + 1] && !argv[i + 1].startsWith('--'), 'Missing rehearsal value');
      v.set(key, argv[++i]);
    }
  }
  assert(!(v.has('--dry-run') && v.has('--send')), 'Choose dry-run or send');
  return {
    dryRun: !v.has('--send'),
    confirm: v.get('--confirm'),
    stateDir: resolve(
      v.get('--state-dir') ??
        join(homedir(), '.local/share/ans/testnet-v7-launch-rehearsal-20261105'),
    ),
    nodeUrl: v.get('--node-url') ?? V6_PROFILES['testnet-v6'].nodeUrl,
    l1Rpc: v.get('--l1-rpc-url') ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  };
}
export const rehearsalDependencies = {
  createNode: (url: string) => createAztecNodeClient(url, { maxBatchSize: 3 }),
  createL1: (url: string) =>
    createPublicClient({ chain: sepolia, transport: http(url, { timeout: 20000, retryCount: 0 }) }),
};
export async function main(argv = process.argv.slice(2), deps = rehearsalDependencies) {
  process.umask(0o077);
  const c = parseRehearsalArgs(argv);
  const root = await physicalPath(join(homedir(), '.local/share/ans'));
  const stateDir = await physicalPath(c.stateDir),
    rel = relative(root, stateDir);
  assert(
    rel && !rel.startsWith('..') && !rel.startsWith('/'),
    'Rehearsal checkpoint must be a new subdirectory of ~/.local/share/ans',
  );
  assert(
    /^testnet-v7-launch-rehearsal-[a-z0-9-]+$/.test(rel),
    'Dedicated V7 rehearsal checkpoint directory required',
  );
  for (const url of [c.nodeUrl, c.l1Rpc]) {
    const u = new URL(url);
    assert(
      !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        ['http:', 'https:'].includes(u.protocol),
      'Public RPC URL required',
    );
  }
  const config = JSON.parse(
    await readFile(new URL('../launch-rehearsal.json', import.meta.url), 'utf8'),
  ) as RehearsalConfig;
  const plan = rehearsalPlan(config, stateDir),
    confirm = rehearsalConfirmation(plan);
  if (!c.dryRun) assert.equal(c.confirm, confirm, 'Explicit --send and exact --confirm required');
  const used = new Set<string>(),
    raw = deps.createNode(c.nodeUrl),
    node = dryRunNode(raw, used);
  const info = await node.getNodeInfo(),
    identity = assertV6Network('testnet-v6', info, c.nodeUrl);
  assertV6FeeJuice('testnet-v6', info);
  if (!c.dryRun) {
    const { sendRehearsal } = await import('./launch-rehearsal-send.js');
    await sendRehearsal({ ...c, stateDir }, config, plan, raw);
    return;
  }
  const balances = [];
  for (const address of config.balanceAccounts) {
    balances.push({
      address,
      feeJuiceBaseUnits: String(
        await readFeeJuiceBalance(node, AztecAddress.fromStringUnsafe(address)),
      ),
    });
  }
  const l1 = deps.createL1(c.l1Rpc);
  assert.equal(await l1.getChainId(), 11155111, 'L1 RPC must be Sepolia');
  const [wei, gasPrice] = await Promise.all([
    l1.getBalance({ address: config.l1Address as `0x${string}` }),
    l1.getGasPrice(),
  ]);
  const liveGasAllowance =
    BigInt(plan.sepolia.bridgeGasPerAccount * plan.sepolia.accounts) * gasPrice;
  const recommendedWei =
    liveGasAllowance > 6000000000000000n ? liveGasAllowance : 6000000000000000n;
  const result = {
    ...plan,
    identity,
    balances,
    balanceSource: config.balanceSource,
    l1: {
      address: config.l1Address,
      balanceWei: String(wei),
      gasPriceWei: String(gasPrice),
      bridgeGasAllowanceWei: String(liveGasAllowance),
      recommendedWei: String(recommendedWei),
      sendMoreSepoliaEth: wei < recommendedWei,
      topUpWei: String(wei < recommendedWei ? recommendedWei - wei : 0n),
    },
    nodeMethods: [...used],
    confirmation: confirm,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
/** Emit a bounded symbolic code only; arbitrary RPC/error messages may contain credentials. */
export function sanitizedRehearsalErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)
    ? code
    : 'REHEARSAL_FAILED';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      `Rehearsal stopped [${sanitizedRehearsalErrorCode(error)}]: inspect arguments, network identity, read-only RPC availability or retained checkpoint. No automatic retry or resend.`,
    );
    process.exitCode = 1;
  });
}
