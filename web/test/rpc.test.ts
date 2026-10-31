import { AztecNodeApiSchema } from '@aztec-labs/stdlib/interfaces/client';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeRpcFetch, createWebNode, rpcRetryInfo, RPC_RETRY, READ_RPC_METHODS, WRITE_RPC_METHODS, SLOW_RPC_METHODS } from '../src/rpc.ts';
const call = (id = 1, method = 'aztec_getPublicStorageAt') => ({
  jsonrpc: '2.0',
  id,
  method,
  params: [],
});
const ok = (id = 1) => ({ jsonrpc: '2.0', id, result: 'ok' });
const fail = (
  id = 1,
  code = 30,
  message = 'Request timeout on the free plan, please upgrade to paid plan',
) => ({ jsonrpc: '2.0', id, error: { code, message } });
function fixture(replies: unknown[]) {
  let now = 0;
  const sleeps: number[] = [],
    requests: any[] = [],
    signals: AbortSignal[] = [];
  const fetcher = async (_host: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    signals.push(init.signal!);
    const value = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  };
  const clock = {
    now: () => now,
    random: () => 0.5,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return {
    requests,
    sleeps,
    signals,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    run: makeRpcFetch(undefined, fetcher as typeof fetch, clock),
  };
}
const run = (f: ReturnType<typeof fixture>, body: unknown = call()) =>
  f.run('http://127.0.0.1', body);

test('RPC code 30 retries then succeeds with exponential full jitter', async () => {
  const f = fixture([fail(), fail(), fail(), ok()]);
  assert.equal((await run(f)).response.result, 'ok');
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.sleeps, [150, 300, 600]);
});
for (const status of [408, 429, 500, 503, 599])
  test(`RPC HTTP ${status} retries`, async () => {
    const f = fixture([new Response('', { status }), ok()]);
    assert.equal((await run(f)).response.result, 'ok');
    assert.equal(f.requests.length, 2);
  });
for (const error of [
  new DOMException('', 'NetworkError'),
  new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }),
  new TypeError('Failed to fetch'),
  new Error('fetch failed'),
  new DOMException('aborted', 'AbortError'),
  new DOMException('timed out', 'TimeoutError'),
])
  test(`RPC ${error.name}: ${error.message} retries`, async () => {
    const f = fixture([error, ok()]);
    assert.equal((await run(f)).response.result, 'ok');
    assert.equal(f.requests.length, 2);
  });
for (const message of ['Rate limit exceeded', 'Too many requests', 'Request timed out'])
  test(`RPC transient message ${message} retries`, async () => {
    const f = fixture([fail(1, -32000, message), ok()]);
    await run(f);
    assert.equal(f.requests.length, 2);
  });
test('RPC contract, parameter and other JSON-RPC errors do not retry', async () => {
  for (const error of [
    fail(1, -32602, 'timeout is an invalid parameter'),
    fail(1, -32000, 'contract assertion failed: timeout'),
    fail(1, 42, 'unknown failure'),
  ]) {
    const f = fixture([error, ok()]);
    assert.deepEqual((await run(f)).response, error);
    assert.equal(f.requests.length, 1);
  }
});
test('RPC HTTP 400/401/403/404 and invalid JSON do not retry', async () => {
  for (const status of [400, 401, 403, 404, 200]) {
    const f = fixture([new Response('not json', { status }), ok()]);
    await assert.rejects(run(f));
    assert.equal(f.requests.length, 1);
  }
});
test('RPC sending, proving, signing, unknown methods and mixed batches never retry', async () => {
  for (const method of ['aztec_sendTx', 'aztec_proveTx', 'aztec_sign', 'aztec_unknown']) {
    for (const response of [
      fail(),
      new Response('', { status: 503 }),
      new TypeError('Failed to fetch'),
    ]) {
      const f = fixture([response, ok()]);
      await run(f, call(1, method)).catch(() => {});
      assert.equal(f.requests.length, 1);
    }
  }
  const f = fixture([
    [ok(), fail(2)],
    [ok(), ok(2)],
  ]);
  await run(f, [call(), call(2, 'aztec_sendTx')]);
  assert.equal(f.requests.length, 1);
});
test('RPC partial batch retries only transient failures and merges shuffled ids in request order', async () => {
  const f = fixture([[fail(3, -32602, 'invalid'), fail(2), ok()], [ok(2)]]);
  const response = (await run(f, [call(), call(2), call(3)])).response;
  assert.deepEqual(f.requests[1], [call(2)]);
  assert.deepEqual(response, [ok(), ok(2), fail(3, -32602, 'invalid')]);
});
test('RPC exhausted batch preserves successful siblings and exposes retry metadata', async () => {
  const f = fixture([[ok(), fail(2)], new Response('', { status: 503 })]);
  const response = (await run(f, [call(), call(2)])).response;
  assert.deepEqual(response[0], ok());
  assert.equal(f.requests.length, 4);
  assert.deepEqual(rpcRetryInfo({ cause: response[1].error }), {
    retryCount: 3,
    temporary: true,
    timeout: false,
  });
});
test('RPC max attempts propagates an error through the actual Aztec client', async () => {
  let attempts = 0;
  const transport = makeRpcFetch(
    undefined,
    (async (_url, init) => {
      attempts++;
      return Response.json(JSON.parse(init!.body as string).map((c: any) => fail(c.id)));
    }) as typeof fetch,
    { now: () => 0, random: () => 0, sleep: async () => {} },
  );
  // getBlockNumber needs no arguments or complex serialized result.
  const { createAztecNodeClient } = await import('@aztec-labs/aztec.js/node');
  const node = createAztecNodeClient('http://127.0.0.1', { fetch: transport });
  await assert.rejects(node.getBlockNumber(), (e) => {
    assert.deepEqual(rpcRetryInfo(e), { retryCount: 3, temporary: true, timeout: true });
    return true;
  });
  assert.equal(attempts, 4);
});
test('reader boot classifies an aborted or unavailable node as network after bounded retries', async () => {
  const { RegistryReader, AnsError } = await import('@ans/sdk/read');
  const { AztecAddress } = await import('@aztec-labs/aztec.js/addresses');
  const { createAztecNodeClient } = await import('@aztec-labs/aztec.js/node');
  for (const failure of [
    new TypeError('Failed to fetch'), // Chromium request.abort().
    new DOMException('timed out', 'TimeoutError'),
    new Response('', { status: 503 }),
  ]) {
    const f = fixture([failure]);
    const node = createAztecNodeClient('http://127.0.0.1', { fetch: f.run });
    await assert.rejects(RegistryReader.connect(node, AztecAddress.fromBigIntUnsafe(1n)), (e) => {
      assert.ok(e instanceof AnsError);
      assert.equal(e.code, 'network'); // session.boot maps this to offline, never misconfigured.
      assert.equal(rpcRetryInfo(e)?.retryCount, 3);
      return true;
    });
    assert.equal(f.requests.length, 4);
    assert.deepEqual(f.sleeps, [150, 300, 600]);
    assert.deepEqual(f.requests[0].map((request: any) => request.method).sort(), [
      'aztec_getContract',
      'aztec_getNodeInfo',
    ]);
  }
});
test('RPC total elapsed budget refuses a backoff that cannot fit', async () => {
  const f = fixture([fail()]);
  let ticks = 0;
  f.clock.now = () => (ticks++ ? 7900 : 0);
  const response = (await run(f)).response;
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.sleeps, []);
  assert.equal(response.error.rpcRetry.retryCount, 0);
});
test('RPC late sleep scheduling cannot start another attempt after the deadline', async () => {
  const f = fixture([fail()]);
  f.clock.sleep = async (ms) => {
    f.advance(8000 + ms);
  };
  const response = (await run(f)).response;
  assert.equal(f.requests.length, 1);
  assert.equal(response.error.rpcRetry.retryCount, 0);
});
test('RPC fetch and body timeout attempts are clamped to the 8s total budget', async (t) => {
  let now = 0,
    attemptBudget = 0,
    attempts = 0;
  const budgets: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    attemptBudget = ms;
    budgets.push(ms);
    return new AbortController().signal;
  });
  const transport = makeRpcFetch(
    undefined,
    (async () => {
      attempts++;
      now += attemptBudget;
      // Simulate a stalled response body, as well as a stalled fetch.
      return {
        ok: true,
        headers: new Headers(),
        json: async () => {
          throw new DOMException('timed out', 'AbortError');
        },
      };
    }) as typeof fetch,
    {
      now: () => now,
      random: () => 0.5,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  const response = (await transport('http://127.0.0.1', call())).response;
  assert.equal(now, RPC_RETRY.totalTimeoutMs);
  assert.equal(attempts, 4);
  assert.deepEqual(budgets, [2000, 2000, 2000, 950]);
  assert.deepEqual(response.error.rpcRetry, { retryCount: 3, temporary: true, timeout: true });
});
test('RPC malformed ids are rejected without retry', async () => {
  const f = fixture([[ok(9), ok(9)]]);
  await assert.rejects(run(f, [call(), call(2)]));
  assert.equal(f.requests.length, 1);
});
test('RPC explicit noRetry overrides reads and dRPC batching remains three', async () => {
  const f = fixture([fail()]);
  await f.run('http://127.0.0.1', call(), {}, true);
  assert.equal(f.requests.length, 1);
  const create = (_url: string, options: any) => options;
  assert.equal(createWebNode('https://aztec-testnet.drpc.org', create as any).maxBatchSize, 3);
  assert.equal(createWebNode('http://127.0.0.1', create as any).maxBatchSize, undefined);
  assert.equal(RPC_RETRY.maxAttempts, 4);
});

test('actual dRPC client keeps three-item batches and resolves per-id partial retries', async () => {
  const { createAztecNodeClient } = await import('@aztec-labs/aztec.js/node');
  const batches: any[][] = [];
  const transport = makeRpcFetch(
    undefined,
    (async (_url, init) => {
      const requests = JSON.parse(init!.body as string);
      batches.push(requests);
      return Response.json(
        requests
          .map((request: any) =>
            request.id === 1 && batches.flat().filter((c) => c.id === 1).length === 1
              ? fail(request.id)
              : { jsonrpc: '2.0', id: request.id, result: request.id + 100 },
          )
          .reverse(),
      );
    }) as typeof fetch,
    { now: () => 0, random: () => 0, sleep: async () => {} },
  );
  const node = createWebNode('https://aztec-testnet.drpc.org', (url, options) =>
    createAztecNodeClient(url, { ...options, fetch: transport }),
  );
  assert.deepEqual(
    await Promise.all(Array.from({ length: 7 }, () => node.getBlockNumber())),
    [100, 101, 102, 103, 104, 105, 106],
  );
  assert.ok(batches.every((batch) => batch.length <= 3));
  const ids = batches.flat().map((call) => call.id);
  assert.equal(ids.filter((id) => id === 1).length, 2);
  for (const id of [0, 2, 3, 4, 5, 6]) assert.equal(ids.filter((value) => value === id).length, 1);
});

const batchError = (code = 30, message = 'Request timeout on the free plan') => ({
  jsonrpc: '2.0', id: null, error: { code, message },
});
const http = (payload: unknown, status: number) => new Response(JSON.stringify(payload), { status });

test('RPC HTTP 400 with a JSON-RPC sendTx error returns the node error without retry', async () => {
  const payload = [fail(1, -32000, 'Invalid tx: duplicate nullifier')];
  const f = fixture([http(payload, 400)]);
  assert.deepEqual((await run(f, [call(1, 'aztec_sendTx')])).response, payload);
  assert.equal(f.requests.length, 1);
});
test('node error behind HTTP 400 reaches the caller verbatim, not as a network error', async () => {
  const { createAztecNodeClient } = await import('@aztec-labs/aztec.js/node');
  const { toAnsError } = await import('@ans/sdk/read');
  let requests = 0;
  const transport = makeRpcFetch(undefined, (async (_url, init) => {
    requests++;
    return http(JSON.parse(init!.body as string).map((c: any) => fail(c.id, -32000, 'Invalid tx: duplicate nullifier')), 400);
  }) as typeof fetch);
  const node = createAztecNodeClient('http://127.0.0.1', { fetch: transport });
  await assert.rejects(node.getBlockNumber(), (e: any) => {
    assert.match(e.message, /Invalid tx: duplicate nullifier/);
    assert.doesNotMatch(e.message, /network request failed/);
    assert.equal(rpcRetryInfo(e), undefined);
    assert.notEqual(toAnsError(e).code, 'network');
    return true;
  });
  assert.equal(requests, 1);
});
test('RPC HTTP 503 with per-id JSON-RPC bodies is handled per id', async () => {
  const f = fixture([http([fail()], 503), [ok()]]);
  assert.deepEqual((await run(f, [call()])).response, [ok()]);
  assert.equal(f.requests.length, 2);
  const fatal = [fail(1, 42, 'unknown failure')];
  const g = fixture([http(fatal, 503)]);
  assert.deepEqual((await run(g, [call()])).response, fatal);
  assert.equal(g.requests.length, 1);
});
test('RPC HTTP 400 batch-level error for sendTx returns per-call server errors', async () => {
  const f = fixture([http(batchError(-32000, 'Bad request: x'), 400)]);
  const result = (await run(f, [call(), call(2, 'aztec_sendTx')])).response;
  assert.deepEqual(result.map((r: any) => [r.id, r.error.message]), [[1, 'Bad request: x'], [2, 'Bad request: x']]);
  assert.equal(f.requests.length, 1);
});
test('RPC HTTP 500 or 200 batch-level error for sendTx stays a transport failure', async () => {
  for (const status of [500, 200, 408, 429]) {
    const f = fixture([http(batchError(), status)]);
    await assert.rejects(run(f, [call(1, 'aztec_sendTx')]), /RPC network request failed/);
    assert.equal(f.requests.length, 1);
  }
});
test('RPC batch-level id:null code 30 retries every pending read', async () => {
  const f = fixture([batchError(), [ok(), ok(2)]]);
  assert.deepEqual((await run(f, [call(), call(2)])).response, [ok(), ok(2)]);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1], [call(), call(2)]);
});
test('RPC batch-level id:null after a partial success retries only pending reads', async () => {
  const f = fixture([[ok(), fail(2)], batchError(), [ok(2)]]);
  assert.deepEqual((await run(f, [call(), call(2)])).response, [ok(), ok(2)]);
  assert.deepEqual(f.requests[2], [call(2)]);
});
test('RPC non-transient batch-level error returns per-call server errors without retry', async () => {
  const message = 'Batch request exceeds maximum allowed size of 100';
  const f = fixture([http(batchError(-32600, message), 400)]);
  const result = (await run(f, [call(), call(2)])).response;
  assert.deepEqual(result.map((r: any) => [r.id, r.error.code, r.error.message]), [[1, -32600, message], [2, -32600, message]]);
  assert.equal(f.requests.length, 1);
});
test('RPC exhausted batch-level code 30 reports retry metadata', async () => {
  const f = fixture([batchError()]);
  const result = (await run(f)).response;
  assert.equal(f.requests.length, 4);
  assert.equal(result.error.message, batchError().error.message);
  assert.equal(result.error.code, 30);
  assert.deepEqual(result.error.rpcRetry, { retryCount: 3, temporary: true, timeout: true });
});

test('every Aztec 6.0.0 node method is classified exactly once; only sendTx is a write', () => {
  const schema = Object.keys(AztecNodeApiSchema).map((m) => `aztec_${m}`).sort();
  assert.equal(schema.length, 58);
  assert.deepEqual([...WRITE_RPC_METHODS], ['aztec_sendTx']);
  assert.ok([...READ_RPC_METHODS].every((m) => !WRITE_RPC_METHODS.has(m)));
  assert.deepEqual([...READ_RPC_METHODS, ...WRITE_RPC_METHODS].sort(), schema);
  assert.ok([...SLOW_RPC_METHODS].every((m) => READ_RPC_METHODS.has(m)));
  console.log('AztecNodeApiSchema methods=58 reads=57 writes=1');
});
test('every read method retries a transient failure; sendTx never does', async () => {
  for (const method of READ_RPC_METHODS) {
    const f = fixture([fail(), ok()]);
    await run(f, call(1, method));
    assert.equal(f.requests.length, 2, method);
  }
  for (const response of [fail(), new Response('', { status: 503 }), new TypeError('Failed to fetch')]) {
    const f = fixture([response]);
    await run(f, call(1, 'aztec_sendTx')).catch(() => {});
    assert.equal(f.requests.length, 1);
  }
});
test('PXE sync and witness reads named in review #3 retry', async () => {
  for (const method of 'getChainTips findLeavesIndexes getNullifierMembershipWitness getPublicDataWitness getNoteHashMembershipWitness getBlockHashMembershipWitness getPrivateLogsByTags getProtocolContractAddresses getL1ToL2MessageMembershipWitness simulatePublicCalls getWorldStateSyncStatus'.split(' ')) {
    const f = fixture([fail(), ok()]);
    await run(f, call(1, `aztec_${method}`));
    assert.equal(f.requests.length, 2, method);
  }
});
test('RPC slow read methods use a 10s attempt and 20s total budget', async (t) => {
  let now = 0, budget = 0;
  const budgets: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    budgets.push(ms); budget = ms;
    return new AbortController().signal;
  });
  const transport = makeRpcFetch(undefined, (async () => {
    now += budget;
    throw new DOMException('timed out', 'TimeoutError');
  }) as typeof fetch, { now: () => now, random: () => 0.5, sleep: async (ms) => { now += ms; } });
  const result = (await transport('http://127.0.0.1', call(1, 'aztec_getContractClass'))).response;
  assert.deepEqual(budgets, [10000, 9850]);
  assert.ok(budgets.reduce((a, b) => a + b, 0) <= 20000);
  assert.equal(now, 20000);
  assert.equal(result.error.rpcRetry.timeout, true);
  console.log('slow budgets:', budgets, 'elapsed:', now);
});
test('RPC a batch mixing fast and slow reads uses the slow budget', async (t) => {
  const budgets: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    budgets.push(ms); return new AbortController().signal;
  });
  const f = fixture([[ok(), ok(2)]]);
  await run(f, [call(), call(2, 'aztec_simulatePublicCalls')]);
  assert.deepEqual(budgets, [10000]);
});

test('RPC failures carry the methods of the failed request', async () => {
  const f = fixture([[fail(), fail(2)]]);
  const result = (await run(f, [call(), call(2, 'aztec_getPublicDataWitness')])).response;
  assert.deepEqual(result.map((r: any) => r.error.rpcMethods), [['aztec_getPublicStorageAt'], ['aztec_getPublicDataWitness']]);
  const g = fixture([new TypeError('Failed to fetch')]);
  await assert.rejects(run(g, [call(), call(2, 'aztec_sendTx')]), (e: any) => {
    assert.deepEqual(e.rpcMethods, ['aztec_getPublicStorageAt', 'aztec_sendTx']);
    return true;
  });
  const { createAztecNodeClient } = await import('@aztec-labs/aztec.js/node');
  for (const failure of [new TypeError('Failed to fetch'), 'rpc']) {
    const transport = makeRpcFetch(undefined, (async (_url, init) => {
      if (failure instanceof Error) throw failure;
      return Response.json(JSON.parse(init!.body as string).map((c: any) => fail(c.id)));
    }) as typeof fetch, { now: () => 0, random: () => 0, sleep: async () => {} });
    const node = createAztecNodeClient('http://127.0.0.1', { fetch: transport });
    await assert.rejects(node.getBlockNumber(), (e: any) => {
      const marker = e.cause.rpcMethods ?? e.cause.data?.rpcMethods;
      assert.deepEqual(marker, ['aztec_getBlockNumber']);
      return true;
    });
  }
});

test('RPC missing ids cannot turn an HTTP failure into a per-id reply', async () => {
  const f = fixture([http({}, 503)]);
  await assert.rejects(f.run('http://127.0.0.1', { method: 'node_sendTx', params: [123n] }), /RPC unavailable/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].params[0], '123');
});
