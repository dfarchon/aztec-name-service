import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import type { JsonRpcFetch } from '@aztec-labs/foundation/json-rpc/client';
import { createWebNode, READ_RPC_METHODS, rpcRetryInfo } from './rpc';

export type ConnectionStatus = 'booting' | 'misconfigured' | 'offline' | 'locked' | 'unlocking' | 'ready';
export const liveWritesAllowed = (status: ConnectionStatus) =>
  status === 'locked' || status === 'unlocking' || status === 'ready';

/**
 * Observe read failures returned by the transport, including a single failed noRetry read.
 * This is the final observation for that invocation, not evidence that retries were attempted.
 * The existing transport owns all deadlines/retries and sends; the observer never replays calls.
 */
export function observeRpcReads(transport: JsonRpcFetch, unavailable: (error: unknown) => void): JsonRpcFetch {
  return async (...args) => {
    const calls = Array.isArray(args[1]) ? args[1] : [args[1]];
    const reads = calls.length > 0 && calls.every(call => READ_RPC_METHODS.has(call.method));
    try {
      const result = await transport(...args);
      const replies = Array.isArray(result.response) ? result.response : [result.response];
      const failed = reads && replies.find(reply => reply?.error && rpcRetryInfo(reply.error));
      if (failed) unavailable(new Error(failed.error.message, { cause: failed.error }));
      return result;
    } catch (error) {
      if (reads) unavailable(error);
      throw error;
    }
  };
}

export function createSessionNode(url: string, unavailable: (error: unknown) => void) {
  return createWebNode(url, (host, options) => createAztecNodeClient(host, {
    ...options, fetch: observeRpcReads(options!.fetch!, unavailable),
  }));
}
