import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './txe-loopback.cjs';

for (const [label, args, expected] of [
  ['numeric', [0], '127.0.0.1'],
  ['numeric string and backlog', ['0', 8], '127.0.0.1'],
  ['whitespace numeric string', [' 0 '], '127.0.0.1'],
  ['hex numeric string', ['0x0'], '127.0.0.1'],
  ['wildcard IPv4', [0, '0.0.0.0', 8], '127.0.0.1'],
  ['options', [{ port: 0, exclusive: true }], '127.0.0.1'],
  ['wildcard IPv6', [{ port: 0, host: '::', ipv6Only: true }], '::1'],
]) test(`TCP ${label} stays loopback with callback`, async () => {
  const server = net.createServer(); let called = false;
  server.listen(...args, () => { called = true; });
  await once(server, 'listening');
  try { assert.equal(server.address().address, expected); assert(called); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
test('TCP Unix sockets retain their argument shape', async () => {
  const server = net.createServer(), path = join(tmpdir(), `ans-txe-${process.pid}.sock`);
  server.listen({ path }); await once(server, 'listening');
  assert.equal(server.address(), path); await new Promise(resolve => server.close(resolve));
});
test('TCP rejects external hosts and unsupported handles before binding', () => {
  for (const args of [[0, '192.0.2.1'], [{ port: 0, host: 'localhost' }], [{ fd: 1 }], [{ handle: {} }], [{}]])
    assert.throws(() => net.createServer().listen(...args), /TXE listener policy/);
});
test('TCP retains native rejection of an empty port without binding', () => {
  const server = net.createServer();
  assert.throws(() => server.listen(''), { code: 'ERR_SOCKET_BAD_PORT' });
  assert.equal(server.address(), null);
});
for (const [label, type, args, expected] of [
  ['port callback', 'udp4', [0], '127.0.0.1'],
  ['wildcard', 'udp4', [0, '0.0.0.0'], '127.0.0.1'],
  ['options', 'udp4', [{ port: 0, exclusive: true }], '127.0.0.1'],
  ['IPv6 default', 'udp6', [0], '::1'],
  ['IPv6 wildcard', 'udp6', [{ port: 0, address: '::' }], '::1'],
]) test(`UDP ${label} stays loopback with callback`, async () => {
  const socket = dgram.createSocket(type); let called = false;
  socket.bind(...args, () => { called = true; }); await once(socket, 'listening');
  try { assert.equal(socket.address().address, expected); assert(called); } finally { socket.close(); }
});
test('UDP rejects external addresses and prebound handles', () => {
  for (const args of [[0, '192.0.2.1'], [{ port: 0, address: 'localhost' }], [{ fd: 1 }], [{}]]) {
    const socket = dgram.createSocket('udp4');
    try { assert.throws(() => socket.bind(...args), /TXE listener policy/); } finally { socket.close(); }
  }
});
test('UDP callback-only and implicit outbound bind use loopback', async () => {
  const receiver = dgram.createSocket('udp4'), sender = dgram.createSocket('udp4');
  receiver.bind(() => {}); await once(receiver, 'listening');
  try {
    assert.equal(receiver.address().address, '127.0.0.1');
    const message = once(receiver, 'message');
    await new Promise((resolve, reject) => sender.send(Buffer.from('test'), receiver.address().port, '127.0.0.1', error => error ? reject(error) : resolve()));
    assert.equal((await message)[0].toString(), 'test');
    assert.equal(sender.address().address, '127.0.0.1');
  } finally { sender.close(); receiver.close(); }
});
test('outbound TCP connections remain available', async () => {
  const server = net.createServer(socket => socket.end()); server.listen(0); await once(server, 'listening');
  try { const socket = net.connect(server.address().port, '127.0.0.1'); await once(socket, 'close'); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
test('repository launcher inherits test policy only for test and preserves existing Node options', () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-txe-launcher-'));
  try {
    mkdirSync(join(root, 'node_modules/@aztec-labs/aztec'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'node_modules/@aztec-labs/aztec/package.json'), JSON.stringify({ version: '6.0.0' }));
    writeFileSync(join(root, 'bin/aztec'), `#!/usr/bin/env node
const net = require('node:net');
const result = { action: process.argv[2], options: process.env.NODE_OPTIONS };
if (result.action === 'test') {
  const server = net.createServer();
  server.listen(0, () => { result.address = server.address().address; console.log(JSON.stringify(result)); server.close(); });
} else console.log(JSON.stringify(result));
`, { mode: 0o700 });
    for (const action of ['test', 'compile', 'start', 'deploy']) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./aztec.mjs', import.meta.url)), action], {
        encoding: 'utf8', env: { ...process.env, ANS_AZTEC_TOOLCHAIN_DIR: root, NODE_OPTIONS: '--no-warnings' },
      });
      assert.equal(result.status, 0, result.stderr);
      const value = JSON.parse(result.stdout);
      if (action === 'test') { assert.equal(value.address, '127.0.0.1'); assert.match(value.options, /txe-loopback.cjs/); }
      else assert.equal(value.options, '--no-warnings');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
