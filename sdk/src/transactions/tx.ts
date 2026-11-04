import type { AuthWitness } from '@aztec-labs/aztec.js/authorization';
import { type ContractFunctionInteraction, NO_WAIT } from '@aztec-labs/aztec.js/contracts';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';

import { AnsError, toAnsError } from '../core/errors.js';
import type { AnsContext } from '../wallet/context.js';

/**
 * - included: in a proposed block (can still be pruned)
 * - confirmed: checkpointed on L1 — the earliest point a UI may show final success
 * - proven: in a proven epoch
 * - reorged: was included, then the block was pruned or the epoch rolled back
 */
export type TxState =
  | 'awaiting_wallet'
  | 'simulating'
  | 'proving'
  | 'submitted'
  | 'included'
  | 'confirmed'
  | 'proven'
  | 'cancelled'
  | 'reverted'
  | 'dropped'
  | 'reorged'
  | 'unknown';

export type TxUpdate = {
  state: TxState;
  txHash?: string;
  blockNumber?: number;
  error?: AnsError;
};

export type TxOptions = {
  onUpdate?: (u: TxUpdate) => void;
  /**
   * Simulate before handing the call to the wallet. Off by default: wallets built on aztec.js (e.g. EmbeddedWallet)
   * already simulate inside `sendTx` to estimate gas, so a second simulation only adds latency. Turn it on for a
   * wallet that proves without simulating first, to surface contract errors before any proof is made.
   */
  preflight?: boolean;
  /** State at which the call resolves. Default `confirmed`. */
  waitFor?: 'included' | 'confirmed' | 'proven';
  /** After this the call throws `unknown_tx_state` carrying the hash; nothing is resent. Default 10 minutes. */
  timeoutMs?: number;
  pollMs?: number;
};

/** Internal persistence hooks; intentionally absent from the public TxOptions API. */
export type RunTxOptions = TxOptions & {
  authWitnesses?: AuthWitness[];
  beforeBroadcast?: () => Promise<void>;
  notBroadcast?: () => Promise<void>;
};

export type TxResult = { txHash: string; state: TxState; blockNumber?: number };
/** Internal result from the receipt interpreter; never inferred from a caught exception. */
export type TxOutcome =
  | { status: 'success'; txHash: string; result: TxResult }
  | { status: 'terminal_failure'; txHash: string; error: AnsError; callbackFailure?: { error: unknown } };

/** Preserve the public throwing API, including exceptions from progress callbacks. */
export function unwrapTxOutcome(outcome: TxOutcome): TxResult {
  if (outcome.status === 'success') return outcome.result;
  if (outcome.callbackFailure) throw outcome.callbackFailure.error;
  throw outcome.error;
}
/** Deferred calls select/register modules inside the wallet queue, after identity checks. */
export type TxCall =
  | ContractFunctionInteraction
  | (() => ContractFunctionInteraction | Promise<ContractFunctionInteraction>);

const RANK: Partial<Record<TxState, number>> = {
  submitted: 0,
  included: 1,
  confirmed: 2,
  proven: 3,
};

/**
 * Hands the call to the wallet (which simulates, proves and sends), then tracks the receipt. Contract errors from the
 * wallet's own simulation surface as mapped AnsErrors before any proof is made.
 */
export async function runTx(
  ctx: AnsContext,
  call: TxCall,
  opts: TxOptions & { authWitnesses?: AuthWitness[] } = {},
): Promise<TxResult> {
  return unwrapTxOutcome(await runTxOutcome(ctx, call, opts));
}

/** Internal registration path: wallet/callback exceptions cannot become terminal receipt results. */
export async function runTxOutcome(
  ctx: AnsContext,
  call: TxCall,
  opts: RunTxOptions = {},
): Promise<TxOutcome> {
  const emit = (u: TxUpdate) => opts.onUpdate?.(u);
  const send = {
    from: ctx.account,
    fee: ctx.signer.fee,
    authWitnesses: opts.authWitnesses,
  };
  const txHash = await ctx.queue.run(async () => {
    let interaction: ContractFunctionInteraction;
    // These checks cannot broadcast. A failed identity/artifact read must not mark a durable plan
    // as having an unknown broadcast that requires manual wallet inspection.
    try {
      if (ctx.reader.modular) await ctx.ensureRegistered();
      else await ctx.assertWalletNetwork();
      await ctx.signer.beforeSend?.(ctx.account);
      interaction = typeof call === 'function' ? await call() : call;
      if (opts.preflight) {
        emit({ state: 'simulating' });
        await interaction.simulate(send);
      }
    } catch (cause) {
      throw toAnsError(cause);
    }
    emit({ state: 'awaiting_wallet' });
    emit({ state: 'proving' });
    try {
      await opts.beforeBroadcast?.();
    } catch (cause) {
      throw toAnsError(cause);
    }
    try {
      const sent = await interaction.send({ ...send, wait: NO_WAIT });
      return sent.txHash.toString();
    } catch (e) {
      let error = toAnsError(e);
      let state: TxState;
      if (error.code === 'wallet_rejected') state = 'cancelled';
      else if (error.code === 'network' && failedReadingBeforeSend(e)) {
        if (!error.txHash) await clearNotBroadcast();
        throw error; // No sendTx reached the node: safe to retry.
      }
      else if (error.code === 'network' || error.code === 'unknown_tx_state') state = 'unknown';
      else if (error.code !== 'reverted' || failedBeforeBroadcast(e)) state = 'reverted';
      else {
        // An unrecognized failure (e.g. the wallet disconnecting mid-request) may follow a broadcast.
        state = 'unknown';
        error = new AnsError('unknown_tx_state', `wallet returned no transaction hash: ${error.message}`, e, error.txHash);
      }
      if (!error.txHash && (state === 'cancelled' || state === 'reverted'))
        await clearNotBroadcast();
      emit({ state, txHash: error.txHash, error });
      throw error;
    }
  });
  emit({ state: 'submitted', txHash });
  return trackTxOutcome(ctx.reader.node, txHash, opts);

  async function clearNotBroadcast() {
    try { await opts.notBroadcast?.(); } catch { /* Keep the marker and original wallet error. */ }
  }
}

/** Follows a sent transaction by hash. Safe to call again after a reload or a timeout. */
export async function trackTx(
  node: AztecNode,
  txHash: string,
  opts: TxOptions = {},
): Promise<TxResult> {
  return unwrapTxOutcome(await trackTxOutcome(node, txHash, opts));
}

/** Internal receipt result. RPC and nonterminal observer failures never enter the terminal branch. */
export async function trackTxOutcome(
  node: AztecNode,
  txHash: string,
  opts: TxOptions = {},
): Promise<TxOutcome> {
  const emit = (u: TxUpdate) => opts.onUpdate?.(u);
  const target = RANK[opts.waitFor ?? 'confirmed']!;
  const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
  const hash = TxHash.fromString(txHash);
  let last: TxState = 'submitted';
  let wasIncluded = false;
  let droppedSince: number | undefined;

  while (Date.now() < deadline) {
    let receipt;
    try {
      receipt = await node.getTxReceipt(hash);
    } catch {
      await sleep(opts.pollMs ?? 1000);
      continue;
    }
    let state: TxState;
    switch (receipt.status) {
      case TxStatus.PENDING:
        state = wasIncluded ? 'reorged' : 'submitted';
        break;
      case TxStatus.DROPPED:
        // A just-sent tx can briefly read as dropped while it propagates.
        droppedSince ??= Date.now();
        state =
          Date.now() - droppedSince > 10_000 ? 'dropped' : wasIncluded ? 'reorged' : 'submitted';
        break;
      case TxStatus.PROPOSED:
        state = 'included';
        break;
      case TxStatus.CHECKPOINTED:
        state = 'confirmed';
        break;
      case TxStatus.PROVEN:
      case TxStatus.FINALIZED:
        state = 'proven';
        break;
      default:
        state = 'unknown';
    }
    if (receipt.status !== TxStatus.DROPPED) droppedSince = undefined;
    const blockNumber = receipt.blockNumber === undefined ? undefined : Number(receipt.blockNumber);

    if (RANK[state] !== undefined && RANK[state]! >= 1 && receipt.hasExecutionReverted()) {
      const error = new AnsError(
        'reverted',
        receipt.error ?? 'public execution reverted',
        undefined,
        txHash,
      );
      return terminalFailure(error, { state: 'reverted', txHash, blockNumber, error });
    }
    if (state === 'dropped') {
      const error = new AnsError(
        'dropped',
        'transaction dropped by the network',
        undefined,
        txHash,
      );
      return terminalFailure(error, { state, txHash, error });
    }
    if (state !== last) {
      emit({ state, txHash, blockNumber });
      last = state;
    }
    if (state === 'included' || state === 'confirmed' || state === 'proven') wasIncluded = true;
    if (RANK[state] !== undefined && RANK[state]! >= target)
      return { status: 'success', txHash, result: { txHash, state, blockNumber } };
    await sleep(opts.pollMs ?? 1000);
  }
  const error = new AnsError(
    'unknown_tx_state',
    'timed out waiting for the transaction',
    undefined,
    txHash,
  );
  emit({ state: 'unknown', txHash, error });
  throw error;

  // Called only after the poll above interpreted an actual terminal receipt. A throwing observer
  // cannot erase that evidence, and its original exception still reaches the caller after persistence.
  function terminalFailure(error: AnsError, update: TxUpdate): TxOutcome {
    try {
      emit(update);
      return { status: 'terminal_failure', txHash, error };
    } catch (callbackError) {
      return { status: 'terminal_failure', txHash, error, callbackFailure: { error: callbackError } };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Failures that a wallet raises before handing the transaction to the node: simulation, proving or tx validation. */
const PRE_BROADCAST_NAMES = new Set(['SimulationError', 'ProvingError']);
const PRE_BROADCAST_PATTERNS = [
  /assertion failed/i,
  /simulat/i,
  /prov(ing|er)\b|proof generation/i,
  /invalid tx|tx validation|invalid transaction/i,
  /gas limit|consumes \d+ \w+ gas/i,
  /balance too low|insufficient (fee|balance)/i,
  /wallet has been disconnected|secure channel not established/i,
];
function failedBeforeBroadcast(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || seen.has(error)) return false;
  seen.add(error);
  if (typeof error === 'string') return PRE_BROADCAST_PATTERNS.some((p) => p.test(error));
  if (typeof error !== 'object') return false;
  const value = error as { name?: unknown; message?: unknown; cause?: unknown; constructor?: { name?: string } };
  return (
    PRE_BROADCAST_NAMES.has(String(value.name)) ||
    PRE_BROADCAST_NAMES.has(String(value.constructor?.name)) ||
    (typeof value.message === 'string' && PRE_BROADCAST_PATTERNS.some((p) => p.test(value.message as string))) ||
    failedBeforeBroadcast(value.cause, seen)
  );
}

/** Duck-typed transport contract from web/rpc.ts; absent markers keep broadcast status conservative. */
function failedReadingBeforeSend(error: unknown, seen = new Set<unknown>()): boolean {
  const markers: unknown[][] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    const value = item as { rpcMethods?: unknown; cause?: unknown; data?: unknown; errors?: unknown[] };
    if (Array.isArray(value.rpcMethods)) markers.push(value.rpcMethods);
    visit(value.cause);
    visit(value.data);
    if (Array.isArray(value.errors)) value.errors.forEach(visit);
  };
  visit(error);
  return markers.length > 0 && markers.every((methods) =>
    methods.length > 0 && methods.every((method) => typeof method === 'string' && method !== 'aztec_sendTx'),
  );
}
