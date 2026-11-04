/** Explicit, resumable L1 bridge. CLI errors deliberately exclude RPC payloads and private material. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  http,
  keccak256,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { FeeAssetHandlerAbi } from '@aztec-foundation/l1-artifacts/FeeAssetHandlerAbi';
import { FeeJuicePortalAbi } from '@aztec-foundation/l1-artifacts/FeeJuicePortalAbi';
import { TestERC20Abi } from '@aztec-foundation/l1-artifacts/TestERC20Abi';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { computeSecretHash } from '@aztec-labs/stdlib/hash';
import { REPO, assertPrivateDir, within } from './deploy-v6-plan.js';
import { physicalPath } from './deploy-v6.js';
import { savePrivateJson } from './testnet-v6-e2e-state.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { readPublicKeys } from './init-keys.js';
import { V6_PROFILES, assertV6FeeJuice, assertV6Network, assertV6Url } from './v6-network.js';
import type { BridgeClaim } from './fee-juice-payment.js';

export function parseBridgeArgs(argv: string[]) {
  const flags = new Set(['init-l1-key', 'dry-run']);
  const allowed = new Set([
    ...flags,
    'network',
    'state-dir',
    'l1-rpc-url',
    'l1-key-file',
    'node-url',
    'recipient',
    'amount',
    'confirm',
  ]);
  const v = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.has(key) || v.has(key))
      throw new Error('Fee bridge unknown or duplicate option');
    if (flags.has(key)) v.set(key, 'true');
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--'))
        throw new Error('Fee bridge missing option value');
      v.set(key, argv[++i]);
    }
  }
  const network = v.get('network');
  if (network !== 'local' && network !== 'testnet-v6')
    throw new Error('Fee bridge requires local|testnet-v6; mainnet refused');
  if (!v.get('state-dir')) throw new Error('Fee bridge requires --state-dir');
  const stateDir = resolve(v.get('state-dir')!);
  assertPrivateDir(
    stateDir,
    network,
    undefined,
    undefined,
    network === 'testnet-v6' && !v.has('recipient') ? 'fee-juice' : 'sponsored',
  );
  const nodeUrl = v.get('node-url') ?? V6_PROFILES[network].nodeUrl;
  assertV6Url(network, nodeUrl);
  const l1Rpc = v.get('l1-rpc-url');
  if (l1Rpc) assertV6Url(network, l1Rpc);
  if (!v.has('init-l1-key') && (!l1Rpc || !/^[1-9][0-9]*$/.test(v.get('amount') ?? '')))
    throw new Error('Fee bridge requires --l1-rpc-url and explicit positive --amount wei');
  return {
    network: network as 'local' | 'testnet-v6',
    stateDir,
    nodeUrl,
    l1Rpc,
    amount: v.get('amount'),
    recipient: v.get('recipient'),
    keyPath: resolve(v.get('l1-key-file') ?? join(stateDir, 'l1-key.json')),
    explicitKey: v.has('l1-key-file'),
    init: v.has('init-l1-key'),
    dryRun: v.has('dry-run'),
    confirm: v.get('confirm'),
  };
}
/** Every ancestor must resist replacement by other users. Root-owned sticky /tmp is safe
 * for an owned child; writable non-sticky ancestors and symlinks are never accepted. */
async function assertSecureAncestors(path: string) {
  // Containers can expose the filesystem root's owner as a mapped UID rather than 0.
  const rootUid = (await lstat('/')).uid;
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    const s = await lstat(dir);
    const rootOwned = s.uid === 0 || s.uid === rootUid;
    const trusted = s.uid === process.getuid!() || rootOwned;
    const stickyRoot = rootOwned && (s.mode & 0o1000) !== 0;
    if (!s.isDirectory() || s.isSymbolicLink() || !trusted ||
      ((s.mode & 0o022) !== 0 && !stickyRoot))
      throw new Error('Fee bridge requires secure owned ancestors without symlinks');
    if (dirname(dir) === dir) break;
  }
}
export async function assertBridgeStateDirectory(path: string, explicitRecipient = false) {
  await assertSecureAncestors(path);
  const s = await lstat(path);
  if (s.uid !== process.getuid!() || (s.mode & 0o7777) !== 0o700)
    throw new Error('Fee bridge state directory must be owned and mode 0700');
  if (explicitRecipient) {
    // Existence only, including dangling symlinks. Never open deployer markers.
    for (const name of ['keys.json', 'state.json']) {
      try { await lstat(join(path, name)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      throw new Error('Fee bridge explicit recipient requires independent state without deployer markers');
    }
  }
}
/** Caller owns this descriptor and must read it directly, then close it. */
export async function openKeyFile(stateDir: string, path: string, explicitKey = false) {
  path = resolve(path);
  await assertSecureAncestors(dirname(path));
  const parent = await lstat(dirname(path));
  if (parent.uid !== process.getuid!() || (parent.mode & 0o7777) !== 0o700)
    throw new Error('Fee bridge key requires an owned 0700 directory');
  const physical = join(await realpath(dirname(path)), path.slice(dirname(path).length + 1));
  if (explicitKey ? within(REPO, physical) : !within(await realpath(stateDir), physical))
    throw new Error('Fee bridge key must be outside repository or inside state directory');
  let file;
  try { file = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error('Fee bridge key must be a regular 0600 file'); }
  try {
    const s = await file.stat();
    if (!s.isFile() || s.uid !== process.getuid!() || (s.mode & 0o7777) !== 0o600)
      throw new Error('Fee bridge key must be an owned regular 0600 file');
    return file;
  } catch (e) { await file.close(); throw e; }
}
export async function assertKeyFile(stateDir: string, path: string, explicitKey = false) {
  const file = await openKeyFile(stateDir, path, explicitKey);
  await file.close();
}
export async function initL1Key(stateDir: string) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await assertBridgeStateDirectory(stateDir);
  const privateKey = generatePrivateKey(),
    address = privateKeyToAccount(privateKey).address;
  await writeFile(join(stateDir, 'l1-key.json'), JSON.stringify({ privateKey, address }) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return address;
}
export type BridgeState = BridgeClaim & {
  schema: string;
  l1Address: string;
  l1ChainId: string;
  portal: string;
  rpcHost: string;
  transactions: Record<string, Hex>;
  done: string[];
};
/** Hash signed bytes locally and durably checkpoint before the network can accept them. */
export function checkpointTransport(
  request: (args: { method: string; params?: unknown }) => Promise<unknown>,
  checkpoint: (hash: Hex) => Promise<void>,
) {
  return async (args: { method: string; params?: unknown }) => {
    if (args.method === 'eth_sendRawTransaction') {
      const raw = (args.params as Hex[])[0];
      await checkpoint(keccak256(raw));
    }
    return request(args);
  };
}
export async function pendingReceipt(
  hash: Hex,
  get: (hash: Hex) => Promise<{ status: string } | undefined>,
) {
  const receipt = await get(hash);
  if (!receipt) throw new Error(`Fee bridge pending L1 hash ${hash}; no resend`);
  if (receipt.status !== 'success')
    throw new Error(`Fee bridge reverted L1 hash ${hash}; manual review required`);
  return receipt;
}
export async function createBridgeCheckpoint(
  path: string,
  fields: Omit<BridgeState, 'schema' | 'claimSecret' | 'claimSecretHash'>,
): Promise<BridgeState> {
  const secret = Fr.random();
  const state: BridgeState = {
    ...fields,
    schema: 'ans-fee-juice-bridge/1',
    claimSecret: secret.toString(),
    claimSecretHash: (await computeSecretHash(secret)).toString(),
  };
  await writeFile(path, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' });
  return state;
}
export async function saveBridgeCheckpoint(path: string, state: unknown) {
  await assertBridgeStateDirectory(dirname(path));
  await savePrivateJson(path, state);
}
export async function bridgeMain(argv = process.argv.slice(2)) {
  const c = parseBridgeArgs(argv);
  const physical = await physicalPath(c.stateDir);
  assertPrivateDir(
    physical,
    c.network,
    undefined,
    undefined,
    c.network === 'testnet-v6' && !c.recipient ? 'fee-juice' : 'sponsored',
  );
  if (c.init) {
    await mkdir(physical, { recursive: true, mode: 0o700 });
    await assertBridgeStateDirectory(physical, !!c.recipient);
    console.log(await initL1Key(physical));
    return;
  }
  await assertBridgeStateDirectory(physical, !!c.recipient);
  const keyFile = await openKeyFile(physical, c.keyPath, c.explicitKey);
  try {
    const node = createAztecNodeClient(c.nodeUrl, { maxBatchSize: 3 });
    const info = await node.getNodeInfo();
    assertV6Network(c.network, info, c.nodeUrl);
    assertV6FeeJuice(c.network, info);
    const a = info.l1ContractAddresses;
    const portal = a.feeJuicePortalAddress.toString() as Hex;
    const token = a.feeJuiceAddress.toString() as Hex;
    const handler = a.feeAssetHandlerAddress?.toString() as Hex | undefined;
    if (!handler) throw new Error('Fee bridge requires the network mint handler');
    const publicClient = createPublicClient({ transport: http(c.l1Rpc!, { retryCount: 0 }) });
    if (String(await publicClient.getChainId()) !== V6_PROFILES[c.network].chainId)
      throw new Error('Fee bridge L1 chain identity mismatch');
    const recipient =
      c.recipient ?? (await readPublicKeys(join(physical, 'keys.json'), c.network)).owner;
    if (
      !/^0x[0-9a-f]{64}$/i.test(recipient) ||
      BigInt(recipient) === 0n ||
      BigInt(recipient) >= Fr.MODULUS
    )
      throw new Error('Fee bridge invalid recipient');
    const amount = BigInt(c.amount!);
    const confirm = `bridge:${c.network}:${info.l1ChainId}:${portal}:${recipient}:${amount}`;
    if (c.dryRun) {
      console.log(`CONFIRM ${confirm}`);
      return;
    }
    if (c.confirm !== confirm) throw new Error(`Fee bridge exact --confirm required: ${confirm}`);
    const unlock = acquireTestnetLock(join(physical, 'runner.lock'));
    try {
      const key = JSON.parse(await keyFile.readFile('utf8')) as { privateKey: Hex };
      const account = privateKeyToAccount(key.privateKey);
      const path = join(physical, 'bridge.json');
      let state: BridgeState;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
          throw new Error('Fee bridge checkpoint must be regular mode 0600');
        state = JSON.parse(await readFile(path, 'utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        state = await createBridgeCheckpoint(path, {
          network: c.network,
          recipient,
          amount: String(amount),
          l1Address: account.address,
          l1ChainId: String(info.l1ChainId),
          portal,
          rpcHost: new URL(c.l1Rpc!).host,
          transactions: {},
          done: [],
        });
      }
      if (
        state.schema !== 'ans-fee-juice-bridge/1' ||
        state.network !== c.network ||
        state.recipient !== recipient ||
        state.amount !== String(amount) ||
        state.l1Address !== account.address ||
        state.portal !== portal ||
        state.l1ChainId !== String(info.l1ChainId)
      )
        throw new Error('Fee bridge checkpoint identity mismatch');
      const output = () =>
        console.log(
          JSON.stringify({
            l1Address: state.l1Address,
            transactions: state.transactions,
            messageHash: state.messageHash,
            leafIndex: state.leafIndex,
            amount: state.amount,
          }),
        );
      if (state.complete) {
        output();
        return;
      }
      const save = () => saveBridgeCheckpoint(path, state);
      let active = '';
      const base = http(c.l1Rpc!, { retryCount: 0 })({});
      const transport = custom(
        {
          request: checkpointTransport(
            (args) => base.request(args as Parameters<typeof base.request>[0]),
            async (hash) => {
              if (!active || state.transactions[active])
                throw new Error('Fee bridge refuses duplicate send');
              state.transactions[active] = hash;
              await save();
            },
          ),
        },
        { retryCount: 0 },
      );
      const chain = defineChain({
        id: Number(info.l1ChainId),
        name: c.network,
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [c.l1Rpc!] } },
      });
      const wallet = createWalletClient({ account, chain, transport });
      const receipt = async (hash: Hex) => {
        try {
          return await publicClient.getTransactionReceipt({ hash });
        } catch (e) {
          if ((e as Error).name === 'TransactionReceiptNotFoundError') return undefined;
          throw e;
        }
      };
      const run = async (step: string, send: () => Promise<Hex>) => {
        active = step;
        const hash = state.transactions[step];
        if (hash) {
          await pendingReceipt(hash, receipt);
        } else {
          await send();
          const sent = state.transactions[step];
          if (!sent) throw new Error('Fee bridge transport did not checkpoint');
          const mined = await publicClient.waitForTransactionReceipt({
            hash: sent,
            timeout: 180_000,
          });
          if (mined.status !== 'success') throw new Error('Fee bridge L1 transaction reverted');
        }
        if (!state.done.includes(step)) {
          state.done.push(step);
          await save();
        }
      };
      // Read the actual faucet policy; it is never hard-coded.
      const mintAmount = await publicClient.readContract({
        address: handler,
        abi: FeeAssetHandlerAbi,
        functionName: 'mintAmount',
      });
      if (amount > mintAmount) throw new Error('Fee bridge amount exceeds mint amount');
      await run('mint', () =>
        wallet.writeContract({
          address: handler,
          abi: FeeAssetHandlerAbi,
          functionName: 'mint',
          args: [account.address],
        }),
      );
      await run('approve', () =>
        wallet.writeContract({
          address: token,
          abi: TestERC20Abi,
          functionName: 'approve',
          args: [portal, amount],
        }),
      );
      await run('deposit', async () => {
        const args = [recipient as Hex, amount, state.claimSecretHash as Hex] as const;
        const gas = await publicClient.estimateContractGas({
          account,
          address: portal,
          abi: FeeJuicePortalAbi,
          functionName: 'depositToAztecPublic',
          args,
        });
        return wallet.writeContract({
          address: portal,
          abi: FeeJuicePortalAbi,
          functionName: 'depositToAztecPublic',
          args,
          gas: gas * 2n,
        });
      });
      const mined = await receipt(state.transactions.deposit);
      for (const log of mined!.logs) {
        if (log.address.toLowerCase() !== portal.toLowerCase()) continue;
        try {
          const event = decodeEventLog({
            abi: FeeJuicePortalAbi,
            data: log.data,
            topics: log.topics,
            eventName: 'DepositToAztecPublic',
          });
          if (
            event.args.to.toLowerCase() !== recipient.toLowerCase() ||
            event.args.secretHash.toLowerCase() !== state.claimSecretHash.toLowerCase() ||
            event.args.amount !== amount
          )
            continue;
          state.messageHash = event.args.key;
          state.leafIndex = String(event.args.index);
          state.complete = true;
        } catch {
          /* Other portal events are not claim evidence. */
        }
      }
      if (!state.complete) throw new Error('Fee bridge deposit event missing; checkpoint retained');
      await save();
      output();
    } finally {
      unlock();
    }
  } finally { await keyFile.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bridgeMain().catch((e) => {
    console.error(
      e instanceof Error && /^Fee bridge|^Fee Juice|^Local|^State|^Legacy|^Node URL/.test(e.message)
        ? e.message.split('\n')[0]
        : 'Fee bridge stopped; checkpoint retained; inspect public receipts',
    );
    process.exitCode = 1;
  });
}
