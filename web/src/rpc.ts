import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import type { JsonRpcFetch } from '@aztec-labs/foundation/json-rpc/client';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';

export const RPC_RETRY = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 300,
  multiplier: 2,
  maxDelayMs: 2500,
  totalTimeoutMs: 8000,
  attemptTimeoutMs: 2000,
  slowAttemptTimeoutMs: 10000,
  slowTotalTimeoutMs: 20000,
  writeTimeoutMs: 20000,
});
// All schema reads retry; sendTx and unknown methods never replay. Coverage tests pin this list.
export const READ_RPC_METHODS = new Set(
  'getWorldStateSyncStatus findLeavesIndexes getNullifierMembershipWitness getLowNullifierMembershipWitness getPublicDataWitness getBlockHashMembershipWitness getBlockHashMembershipWitnessAtArchive getNoteHashMembershipWitness getL1ToL2MessageMembershipWitness getL1ToL2MessageIndex getL2ToL1Messages getL2ToL1MembershipWitness getTxEffectMembershipWitness getBlockNumber getCheckpointNumber getChainTips getL1Constants getSyncedL2SlotNumber getSyncedL2EpochNumber getSyncedL1Timestamp getCheckpointsData getBlock getBlockData getBlocks getCheckpoint getCheckpoints isReady getNodeInfo getCurrentMinFees getPredictedMinFees getMaxPriorityFees getNodeVersion getVersion getChainId getL1ContractAddresses getProtocolContractAddresses getPrivateLogsByTags getPublicLogsByTags getTxReceipt getTxEffect getPendingTxs getPendingTxCount getTxByHash getTxsByHash getPublicStorageAt getValidatorsStats getValidatorStats getValidatorStatsBatch simulatePublicCalls isValidTx getContractClass getContract getEncodedEnr getAllowedPublicSetup getPeers getCheckpointAttestationsForSlot getProposalsForSlot'.split(' ').map((m) => `aztec_${m}`),
);
export const WRITE_RPC_METHODS = new Set(['aztec_sendTx']);
export const SLOW_RPC_METHODS = new Set(
  'getContractClass getBlock getBlocks getCheckpoint getCheckpoints getCheckpointsData getTxEffect getTxByHash getTxsByHash getPendingTxs getPrivateLogsByTags getPublicLogsByTags getL2ToL1Messages simulatePublicCalls isValidTx'.split(' ').map((m) => `aztec_${m}`),
);
export type RpcRetryInfo = { retryCount: number; temporary: boolean; timeout: boolean };
export class RpcReadError extends Error {
  constructor(
    readonly rpcRetry: RpcRetryInfo,
    cause: unknown,
    readonly rpcMethods: string[],
  ) {
    super(`RPC network request failed${cause instanceof Error ? `: ${cause.message}` : ''}`, {
      cause,
    });
    this.name = 'RpcReadError';
  }
}
/** Aztec attaches JSON-RPC errors as cause; the SDK may add another AnsError wrapper. */
export function rpcRetryInfo(error: unknown, seen = new Set<unknown>()): RpcRetryInfo | undefined {
  if (!error || typeof error !== 'object' || seen.has(error)) return;
  seen.add(error);
  const value = error as { rpcRetry?: RpcRetryInfo; cause?: unknown; data?: unknown };
  return value.rpcRetry ?? rpcRetryInfo(value.cause, seen) ?? rpcRetryInfo(value.data, seen);
}
type Call = { id: string | number; method: string };
type Reply = {
  id: string | number;
  error?: { code: number; message: string; rpcRetry?: RpcRetryInfo; rpcMethods?: string[] };
  [key: string]: unknown;
};
const temporaryRpc = (error: NonNullable<Reply['error']>) =>
  error.code === 30 ||
  (![-32600, -32601, -32602].includes(error.code) &&
    !/revert|assert|contract|invalid param/i.test(error.message) &&
    /timeout|timed?\s*out|rate[ -]?limit|too many requests/i.test(error.message));
const timeoutError = (error: unknown) =>
  error instanceof Error &&
  (/AbortError|TimeoutError/.test(error.name) || /timeout|timed?\s*out/i.test(error.message));
const networkError = (error: unknown, seen = new Set<unknown>()): boolean => {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const value = error as { name?: string; message?: string; code?: string; cause?: unknown };
  return (
    value.name === 'NetworkError' ||
    timeoutError(error) ||
    /fetch failed|failed to fetch|network|load failed|terminated|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(
      value.message ?? '',
    ) ||
    /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_.*)$/.test(value.code ?? '') ||
    networkError(value.cause, seen)
  );
};
type Runtime = { now: () => number; sleep: (ms: number) => Promise<void>; random: () => number };
const runtime: Runtime = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Retry only failed read subrequests. Keep successes and restore request order by id for Aztec's client. */
export function makeRpcFetch(
  timeoutMs: number = RPC_RETRY.writeTimeoutMs,
  fetcher: typeof fetch = fetch,
  clock: Runtime = runtime,
): JsonRpcFetch {
  return async (host, body, extraHeaders = {}, noRetry = false) => {
    const batch = Array.isArray(body);
    const calls: Call[] = batch ? body : [body];
    const readOnly =
      !noRetry &&
      calls.length > 0 &&
      calls.every(
        (call) =>
          call &&
          (typeof call.id === 'string' || typeof call.id === 'number') &&
          READ_RPC_METHODS.has(call.method),
      ) &&
      new Set(calls.map((call) => call.id)).size === calls.length;
    const slow = calls.some((call) => SLOW_RPC_METHODS.has(call?.method));
    const attemptTimeout = slow ? RPC_RETRY.slowAttemptTimeoutMs : RPC_RETRY.attemptTimeoutMs;
    const deadline = clock.now() + (slow ? RPC_RETRY.slowTotalTimeoutMs : RPC_RETRY.totalTimeoutMs);
    const completed = new Map<Call['id'], Reply>();
    let pending = calls;
    let headers = new Headers();
    let last: unknown;
    let isTimeout = false;
    let attempts = 0;
    const finish = (info: RpcRetryInfo) => {
      for (const call of pending) {
        const reply = completed.get(call.id);
        completed.set(call.id, {
          id: call.id,
          jsonrpc: '2.0',
          error: {
            code: reply?.error?.code ?? -32000,
            message: reply?.error?.message ?? 'RPC network request failed',
            rpcRetry: info,
            rpcMethods: [call.method],
          },
        });
      }
      return {
        response: batch
          ? calls.map((call) => completed.get(call.id)!)
          : completed.get(calls[0].id)!,
        headers,
      };
    };
    while (true) {
      if (readOnly && attempts > 0 && clock.now() >= deadline)
        return finish({ retryCount: attempts - 1, temporary: true, timeout: isTimeout });
      attempts++;
      let retryable = false;
      try {
        const response = await fetcher(host, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
          body: jsonStringify(batch ? pending : pending[0]),
          signal: AbortSignal.timeout(
            Math.max(
              1,
              Math.ceil(
                readOnly
                  ? Math.min(timeoutMs, attemptTimeout, deadline - clock.now())
                  : timeoutMs,
              ),
            ),
          ),
        });
        headers = response.headers;
        const transient = response.status === 408 || response.status === 429 ||
          (response.status >= 500 && response.status <= 599);
        const payload = response.ok
          ? await response.json()
          : await response.json().catch(() => undefined);
        const replies: Reply[] = batch ? payload : [payload];
        const perId = (batch || !Array.isArray(payload)) && Array.isArray(replies) && replies.length === pending.length &&
          new Set(replies.map((reply) => reply?.id)).size === pending.length &&
          replies.every((reply) => reply && (typeof reply.id === 'string' || typeof reply.id === 'number') &&
            pending.some((call) => call.id === reply.id));
        const batchError = payload && !Array.isArray(payload) && payload.id == null &&
          typeof payload.error?.code === 'number' && typeof payload.error?.message === 'string'
          ? payload.error : undefined;
        if (!response.ok && !perId && !batchError) {
          retryable = transient;
          isTimeout = response.status === 408;
          throw new Error(`RPC unavailable (${response.status})`);
        }
        if (batchError) {
          retryable = temporaryRpc(batchError) || transient;
          isTimeout = response.status === 408 || /timeout|timed?\s*out/i.test(batchError.message);
          if (!readOnly && !(response.status >= 400 && response.status < 500 && !transient))
            throw new Error(`RPC unavailable (${response.status}): ${batchError.message}`);
          for (const call of pending) completed.set(call.id, {
            id: call.id, jsonrpc: '2.0',
            error: { code: batchError.code, message: batchError.message, rpcMethods: [call.method] },
          });
          if (!readOnly || !retryable) {
            pending = [];
            return finish({ retryCount: attempts - 1, temporary: false, timeout: isTimeout });
          }
          last = new Error(batchError.message);
        } else {
        // A malformed response is not transient evidence. Never guess its request.
        if (!perId) throw new Error('Invalid RPC response ids');
        if (!readOnly) return { response: payload, headers };
        const failed: Call[] = [];
        for (const call of pending) {
          const reply = replies.find((reply) => reply.id === call.id)!;
          completed.set(call.id, reply);
          if (reply.error && temporaryRpc(reply.error)) failed.push(call);
        }
        pending = failed;
        if (!pending.length)
          return {
            response: batch
              ? calls.map((call) => completed.get(call.id)!)
              : completed.get(calls[0].id)!,
            headers,
          };
        retryable = true;
        isTimeout = pending.some((call) =>
          /timeout|timed?\s*out/i.test(completed.get(call.id)!.error!.message),
        );
        last = new Error('Temporary RPC error');
        }
      } catch (error) {
        last = error;
        retryable ||= networkError(error);
        isTimeout ||= timeoutError(error);
      }
      const info: RpcRetryInfo = {
        retryCount: attempts - 1,
        temporary: retryable,
        timeout: isTimeout,
      };
      if (!readOnly || !retryable) throw new RpcReadError(info, last, calls.map((call) => call.method));
      const remaining = deadline - clock.now();
      const delay =
        clock.random() *
        Math.min(
          RPC_RETRY.maxDelayMs,
          RPC_RETRY.baseDelayMs * RPC_RETRY.multiplier ** (attempts - 1),
        );
      if (attempts >= RPC_RETRY.maxAttempts || remaining <= delay) {
        // Return per-id failures so successful siblings still resolve. The client throws each error with this cause.
        return finish(info);
      }
      await clock.sleep(delay);
    }
  };
}

/** VITE_NODE_URL may target the V6 free RPC, which accepts at most three requests per batch. */
export function createWebNode(nodeUrl: string, createNode = createAztecNodeClient) {
  const options = {
    fetch: makeRpcFetch(),
    ...(new URL(nodeUrl).hostname === 'aztec-testnet.drpc.org' ? { maxBatchSize: 3 } : {}),
  };
  return createNode(nodeUrl, options);
}
