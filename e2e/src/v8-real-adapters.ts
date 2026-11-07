/** Actual pinned libraries, local signing only. Public execution has no activation switch. */
import assert from 'node:assert/strict';
import { createPublicClient, http, keccak256, type Hex, type TransactionSerializable } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { createAztecNodeClient, type AztecNode } from '@aztec-labs/aztec.js/node';
import { Tx, TxHash } from '@aztec-labs/aztec.js/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Fr } from '@aztec-labs/aztec.js/fields';
import {
  MockJournal,
  PUBLIC_PAUSE,
  type Binding,
  type Identity,
  verifyIdentity,
} from './v8-safe-operator.js';

// Independent identity: preflight-1 official network and canonical rollup records, cross-checked
// against the frozen manifest. No existing ANS Registry/module address is a target.
export const FUTURE_REHEARSAL = Object.freeze({
  chainId: 11155111,
  rollupVersion: 679261766,
  nodeVersion: '6.0.0',
  realProofs: true,
  rollup: '0x1f435a7f2da358caf887a470faeee7d5d5f4efba',
  registry: null,
  registrar: null,
  resolver: null,
  budget: null,
  target: 'NEW_FUTURE_INSTANCES_ONLY',
});
export function verifyPublicNode(info: Awaited<ReturnType<AztecNode['getNodeInfo']>>) {
  assert.equal(Number(info.l1ChainId), FUTURE_REHEARSAL.chainId);
  assert.equal(info.rollupVersion, FUTURE_REHEARSAL.rollupVersion);
  assert.equal(info.nodeVersion.split('+')[0], FUTURE_REHEARSAL.nodeVersion);
  assert.equal(info.realProofs, true);
  assert.equal(
    info.l1ContractAddresses.rollupAddress.toString().toLowerCase(),
    FUTURE_REHEARSAL.rollup,
  );
}

/** No signer argument, lazy wallet, credential path or execution callback is accepted. */
export class RealL1Adapter {
  private readonly client;
  constructor(url: string) {
    this.client = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  }
  async chainId() {
    const id = await this.client.getChainId();
    assert.equal(id, FUTURE_REHEARSAL.chainId, 'Public L1 chain mismatch');
    return id;
  }
  async code(address: Hex) {
    await this.chainId();
    return this.client.getCode({ address });
  }
  async balance(address: Hex) {
    await this.chainId();
    return this.client.getBalance({ address });
  }
  async estimate(input: { account: Hex; to: Hex; data: Hex; value?: bigint }) {
    await this.chainId();
    return this.client.estimateGas(input);
  }
  async nonce(address: Hex) {
    await this.chainId();
    return this.client.getTransactionCount({ address });
  }
  async gasPrice() {
    await this.chainId();
    return this.client.getGasPrice();
  }
  async receipt(hash: Hex) {
    await this.chainId();
    return this.client.getTransactionReceipt({ hash });
  }
  execute(..._uninspected: unknown[]): never {
    throw new Error(PUBLIC_PAUSE);
  }
}
export class RealAztecAdapter {
  private readonly node: AztecNode;
  constructor(url: string) {
    this.node = createAztecNodeClient(url);
  }
  async contract(address: AztecAddress) {
    await this.info();
    return this.node.getContract(address);
  }
  async contractClass(id: Fr) {
    await this.info();
    return this.node.getContractClass(id);
  }
  async info() {
    const info = await this.node.getNodeInfo();
    verifyPublicNode(info);
    return info;
  }
  async fees() {
    await this.info();
    return this.node.getCurrentMinFees();
  }
  async receipt(hash: string) {
    await this.info();
    return this.node.getTxReceipt(TxHash.fromString(hash));
  }
  execute(..._uninspected: unknown[]): never {
    throw new Error(PUBLIC_PAUSE);
  }
}
function loopback(url: string) {
  const parsed = new URL(url);
  assert(
    parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash,
    'Only literal HTTP loopback allowed',
  );
}
function savedHash(journal: MockJournal, step: string) {
  const last = journal.latest();
  if (last?.step === step) {
    assert(last.hash && last.phase !== 'halted', 'Unresolved intent: stop without replay');
    return `0x${last.hash}` as Hex;
  }
  assert(
    !journal.seen(step) && (!last || last.phase === 'confirmed'),
    'Previous step unresolved or replay refused',
  );
  return undefined;
}
/** Durable engine reused from mock tests, but hashes below come from viem/SDK transactions. */
export class LocalPinnedAdapters {
  lastSerialization?: { bytes: number; publicCalldataFields: number; hash: string };
  private ephemeralWallet?: EmbeddedWallet;
  readonly #node: AztecNode;
  readonly #l1: ReturnType<typeof createPublicClient>;
  readonly #binding: Binding;
  private constructor(nodeUrl: string, l1Url: string, binding: Binding) {
    // Runtime validation also applies to JavaScript callers; TS private is not a security boundary.
    loopback(nodeUrl);
    loopback(l1Url);
    assert.equal(binding.identity.chainId, 31337);
    assert.equal(binding.identity.realProofs, false);
    this.#node = createAztecNodeClient(nodeUrl);
    this.#l1 = createPublicClient({ chain: foundry, transport: http(l1Url, { retryCount: 0 }) });
    this.#binding = structuredClone(binding);
  }
  static async connect(nodeUrl: string, l1Url: string, binding: Binding) {
    loopback(nodeUrl);
    loopback(l1Url);
    assert.equal(binding.identity.chainId, 31337);
    assert.equal(binding.identity.realProofs, false);
    const adapter = new LocalPinnedAdapters(nodeUrl, l1Url, binding);
    await adapter.guard();
    return adapter;
  }
  private async guard() {
    const info = await this.#node.getNodeInfo();
    assert.equal(await this.#l1.getChainId(), 31337);
    assert.equal(Number(info.l1ChainId), 31337);
    assert.equal(info.realProofs, false);
    assert.equal(info.nodeVersion.split('+')[0], '6.0.0');
    assert.equal(info.rollupVersion, this.#binding.identity.rollupVersion);
    assert.equal(
      (await this.#node.getCurrentMinFees()).feePerDaGas,
      0n,
      'DA changed from zero: STOP',
    );
  }
  /** Wallet is constructed after local identity verification; never accepted from a caller. */
  async wallet() {
    await this.guard();
    return (this.ephemeralWallet ??= await EmbeddedWallet.create(this.#node, {
      ephemeral: true,
      pxe: { proverEnabled: false },
    }));
  }
  async close() {
    await this.ephemeralWallet?.stop();
  }
  async trackL1(journal: MockJournal, step: string, hash: Hex) {
    await this.guard();
    return trackL1Receipt(this.#l1, journal, step, hash);
  }

  async l1Step(journal: MockJournal, step: string, transaction: TransactionSerializable) {
    await this.guard();
    const saved = savedHash(journal, step);
    if (saved) return this.trackL1(journal, step, saved);
    assert.equal(transaction.chainId, 31337, 'Local serialization chain required');
    await journal.append(step, 'intent');
    // Public, fixed, unfunded fixture key. No key argument, filesystem access or random generation.
    const signer = privateKeyToAccount(`0x${'01'.repeat(32)}`);
    const bytes = await signer.signTransaction(transaction);
    const hash = keccak256(bytes);
    await journal.append(step, 'hashed', hash.slice(2));
    await this.guard();
    await journal.append(step, 'broadcasting', hash.slice(2));
    try {
      assert.equal(await this.#l1.sendRawTransaction({ serializedTransaction: bytes }), hash);
    } catch {
      await journal.append(step, 'tracking', hash.slice(2), 'broadcast-ambiguous', false);
      return;
    }
    await journal.append(step, 'tracking', hash.slice(2), undefined, false);
    return hash;
  }
  /** run() must use this SDK wallet; the node boundary verifies actual Tx serialization/hash. */
  async aztecStep<T>(
    journal: MockJournal,
    step: string,
    run: (wallet: EmbeddedWallet) => Promise<T>,
    readback: () => Promise<void>,
  ) {
    await this.guard();
    const saved = savedHash(journal, step);
    if (saved) {
      return trackAztecReceipt(this.#node, journal, step, saved, readback);
    }
    await journal.append(step, 'intent');
    const original = this.#node.sendTx.bind(this.#node);
    let sent = false;
    this.#node.sendTx = async (tx: Tx) => {
      assert(!sent, 'One transaction per durable step');
      sent = true;
      const serialized = tx.toBuffer();
      this.lastSerialization = {
        bytes: serialized.length,
        publicCalldataFields: tx.getTotalPublicCalldataCount(),
        hash: (await tx.getTxHash()).toString(),
      };
      const hash = (await tx.getTxHash()).toString();
      assert.equal(
        (await Tx.fromBuffer(serialized).getTxHash()).toString(),
        hash,
        'SDK serialization/hash mismatch',
      );
      await journal.append(step, 'hashed', hash.slice(2));
      await this.guard();
      await journal.append(step, 'broadcasting', hash.slice(2));
      try {
        await original(tx);
      } finally {
        await journal.append(step, 'tracking', hash.slice(2), undefined, false);
      }
    };
    let wallet: EmbeddedWallet | undefined;
    try {
      wallet = await this.wallet();
      const result = await run(wallet);
      assert(sent, 'No SDK transaction captured');
      await readback();
      return result;
    } finally {
      this.#node.sendTx = original;
    }
  }
}

/** Independent expected identity must come from immutable rehearsal config, never an existing Registry target. */
export function verifyReadOnlySnapshot(expected: Identity, actual: Identity) {
  verifyIdentity(expected, actual);
}

/** Reserve before RPC; exceptions and process crashes consume one of twenty durable slots. */
async function reserveReceipt(journal: MockJournal, step: string, hash: Hex) {
  const last = journal.latest();
  assert(
    last?.step === step && last.hash === hash.slice(2) && last.phase !== 'halted',
    'Saved receipt identity required',
  );
  assert(journal.trackAttempts(step) < 20, 'Receipt observation limit reached');
  const confirmed = last.phase === 'confirmed';
  await journal.append(
    step,
    confirmed ? 'confirmed' : 'tracking',
    hash.slice(2),
    'receipt-requested',
    true,
  );
  return confirmed;
}
async function halt(
  journal: MockJournal,
  step: string,
  hash: Hex,
  reason: string,
  error: unknown,
): Promise<never> {
  await journal.append(
    step,
    'halted',
    hash.slice(2),
    `${reason}: ${error instanceof Error ? error.message : String(error)}`,
    false,
  );
  throw error;
}
export async function trackL1Receipt(
  client: Pick<ReturnType<typeof createPublicClient>, 'getTransactionReceipt' | 'getBlock'>,
  journal: MockJournal,
  step: string,
  hash: Hex,
) {
  const confirmed = await reserveReceipt(journal, step, hash);
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (confirmed) throw error;
    await journal.append(step, 'tracking', hash.slice(2), 'receipt-unavailable', false);
    return undefined;
  }
  // Only transport calls are caught as unavailable. Integrity failures halt durably.
  try {
    assert.equal(receipt.transactionHash, hash, 'L1 receipt hash mismatch');
  } catch (error) {
    return halt(journal, step, hash, 'receipt-integrity-failure', error);
  }
  let block;
  try {
    block = await client.getBlock({ blockNumber: receipt.blockNumber });
  } catch (error) {
    if (confirmed) throw error;
    await journal.append(step, 'tracking', hash.slice(2), 'block-unavailable', false);
    return undefined;
  }
  try {
    assert.equal(block.hash, receipt.blockHash, 'Receipt block is not canonical');
    if (confirmed) assert.equal(receipt.status, 'success', 'Confirmed receipt drift');
  } catch (error) {
    return halt(journal, step, hash, 'receipt-integrity-failure', error);
  }
  if (!confirmed)
    await journal.append(
      step,
      receipt.status === 'success' ? 'confirmed' : 'tracking',
      hash.slice(2),
      JSON.stringify({
        status: receipt.status,
        blockHash: receipt.blockHash,
        blockNumber: String(receipt.blockNumber),
        timestamp: String(block.timestamp),
      }),
      false,
    );
  return receipt;
}
export async function trackAztecReceipt(
  node: Pick<AztecNode, 'getTxReceipt' | 'getBlock'>,
  journal: MockJournal,
  step: string,
  hash: Hex,
  readback: () => Promise<void>,
) {
  const confirmed = await reserveReceipt(journal, step, hash);
  const receipt = await node.getTxReceipt(TxHash.fromString(hash));
  try {
    assert.equal(receipt.txHash.toString(), hash, 'Aztec receipt hash mismatch');
  } catch (error) {
    return halt(journal, step, hash, 'receipt-integrity-failure', error);
  }
  if (!receipt.hasExecutionSucceeded()) {
    if (confirmed)
      return halt(
        journal,
        step,
        hash,
        'confirmed-readback-drift',
        new Error(String(receipt.status)),
      );
    await journal.append(step, 'tracking', hash.slice(2), String(receipt.status), false);
    return receipt;
  }
  const block =
    receipt.blockNumber === undefined ? undefined : await node.getBlock(receipt.blockNumber);
  try {
    assert(
      receipt.blockNumber !== undefined && receipt.blockHash,
      'Mined receipt identity required',
    );
    assert(block && block.hash.equals(receipt.blockHash), 'Receipt block is not canonical');
    await readback();
  } catch (error) {
    return halt(
      journal,
      step,
      hash,
      confirmed ? 'confirmed-readback-drift' : 'receipt-readback-integrity-failure',
      error,
    );
  }
  if (!confirmed)
    await journal.append(
      step,
      'confirmed',
      hash.slice(2),
      JSON.stringify({
        status: receipt.status,
        executionResult: receipt.executionResult,
        blockHash: String(receipt.blockHash),
        blockNumber: receipt.blockNumber,
        timestamp: String(block!.header.globalVariables.timestamp),
      }),
      false,
    );
  return receipt;
}
