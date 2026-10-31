import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireTestnetLock } from './testnet-lock.js';

test('testnet state has one writer and a private recoverable lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ans-testnet-lock-'));
  const path = join(dir, 'lock');
  try {
    const release = acquireTestnetLock(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => acquireTestnetLock(path), /already owns/);
    release();
    const next = acquireTestnetLock(path);
    next();
    writeFileSync(path, JSON.stringify({ pid: 2147483647, token: 'stale' }));
    acquireTestnetLock(path)();
    writeFileSync(path, JSON.stringify({ pid: 0 }));
    assert.throws(() => acquireTestnetLock(path), /Invalid testnet lock/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
