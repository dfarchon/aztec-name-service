import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentSecurityPolicy } from './testnet-security.mjs';

test('a build without web wallets only permits same-origin frames', () => {
  assert.ok(contentSecurityPolicy().split('; ').includes("frame-src 'self'"));
});

test('only configured wallet origins are allowed, deduplicated across paths', () => {
  const policy = contentSecurityPolicy(
    'https://wallet.example/app, https://wallet.example/other, http://127.0.0.1:5194/wallet',
  );
  assert.ok(
    policy.split('; ').includes("frame-src 'self' https://wallet.example http://127.0.0.1:5194"),
  );
  assert.ok(policy.includes("script-src 'self' 'wasm-unsafe-eval'"));
  assert.ok(!policy.includes("'unsafe-eval'"));
});

test('wallet URLs cannot introduce script or opaque frame origins', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,wallet',
    'https://user:secret@wallet.example',
    'not a URL',
  ])
    assert.throws(() => contentSecurityPolicy(url));
});
