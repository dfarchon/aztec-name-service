import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebNode, makeRpcFetch } from '../../web/src/rpc.js';

test('a failed broadcast gets one attempt and retains valid BigInt wire encoding', async () => {
  let attempts = 0;
  const transport = makeRpcFetch(1000, (async (_url, options) => {
    attempts++;
    const wire = JSON.parse(options!.body as string);
    assert.equal(wire.params[0], '123');
    return new Response('{}', { status: 503 });
  }) as typeof fetch);
  await assert.rejects(transport('https://rpc.test', { method: 'node_sendTx', params: [123n] }), /RPC unavailable/);
  assert.equal(attempts, 1);
});

test('a stalled RPC request aborts so connection recovery can continue', async () => {
  const transport = makeRpcFetch(5, ((_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason));
  })) as typeof fetch);
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(transport('https://rpc.test', { method: 'node_getNodeInfo' })); }
  finally { clearTimeout(keepAlive); }
});

test('web V6 drpc client receives maxBatchSize three and the bounded fetch', t => {
  const createNode = t.mock.fn<typeof import('@aztec-labs/aztec.js/node').createAztecNodeClient>();
  const url = 'https://aztec-testnet.drpc.org/';
  createWebNode(url, createNode);
  assert.equal(createNode.mock.callCount(), 1);
  const [actualUrl, options] = createNode.mock.calls[0].arguments;
  assert.equal(actualUrl, url);
  assert.equal(options?.maxBatchSize, 3);
  assert.equal(typeof options?.fetch, 'function');
});

test('web preserves default batching for local, v5 and unrelated RPC endpoints', t => {
  for (const url of ['http://127.0.0.1:8080', 'https://v5.testnet.rpc.aztec-labs.com', 'https://aztec-testnet.drpc.org.example.com']) {
    const createNode = t.mock.fn<typeof import('@aztec-labs/aztec.js/node').createAztecNodeClient>();
    createWebNode(url, createNode);
    assert.equal(createNode.mock.callCount(), 1);
    const [actualUrl, options] = createNode.mock.calls[0].arguments;
    assert.equal(actualUrl, url);
    assert.equal(Object.hasOwn(options!, 'maxBatchSize'), false);
    assert.equal(typeof options?.fetch, 'function');
  }
});
