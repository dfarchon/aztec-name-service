import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gunzipSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import { Agent, makeUndiciFetch } from '@aztec-labs/foundation/json-rpc/undici';
import { createSafeJsonRpcClient } from '@aztec-labs/foundation/json-rpc/client';
import { createSafeJsonRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import { WalletSchema, type Wallet } from '@aztec-labs/aztec.js/wallet';

test('Node TypeScript runner preserves the wallet RPC server CommonJS interop', async () => {
  const wallet = { getAccounts: async () => [] } as unknown as Wallet;
  const rpc = createSafeJsonRpcServer<Wallet>(wallet, WalletSchema);
  const server = createServer(rpc.getApp().callback());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    const client = createSafeJsonRpcClient<Wallet>(`http://127.0.0.1:${port}`, WalletSchema);
    assert.deepEqual(await client.getAccounts(), []);
  } finally { server.close(); await once(server, 'close'); }
});

test('patched Undici preserves Aztec RPC plain and gzip transport', async () => {
  const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      bodies.push(JSON.parse((req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString()));
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 11155111 })));
    } catch { res.writeHead(400); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const agent = new Agent({ headersTimeout: 5000, bodyTimeout: 5000 });
  try {
    const fetch = makeUndiciFetch(agent);
    for (const payload of [{ jsonrpc: '2.0', method: 'node_getNodeInfo', params: [] }, { jsonrpc: '2.0', method: 'node_sendTx', params: ['a'.repeat(2048)] }]) {
      const response = await fetch(`http://127.0.0.1:${port}`, payload);
      assert.equal(response.response.result, 11155111);
      assert.deepEqual(bodies.at(-1), payload);
    }
  } finally { await agent.close(); server.close(); await once(server, 'close'); }
});
