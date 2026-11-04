import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { getSchnorrAccountContractAddress } from '@aztec-labs/accounts/schnorr';
import { generatePlaceholderAdmin, placeholderOptions } from './generate-placeholder-admin.js';

test('offline placeholder uses private exclusive files and address derivation without reading key files or using a network', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ans-placeholder-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldMask = process.umask(0);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network forbidden'); });
  let image = '';
  const keys = { secret: Fr.random(), salt: Fr.random(), signingKey: Fq.random() };
  try {
    const options = placeholderOptions(['--dir-name', 'test-account'], { HOME: root, ANS_DATA_DIR: join(root, 'private') });
    const result = await generatePlaceholderAdmin(options, { now: () => new Date('2026-11-05T00:00:00Z'), randomKeys: () => keys, randomSalt: () => Fr.random(),
      write: (fd, bytes) => { image = bytes; writeSync(fd, bytes); } });
    assert.equal(statSync(result.dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(result.dir, 'keys.json')).mode & 0o777, 0o600);
    const publicOutput = JSON.stringify(result);
    for (const value of [keys.secret, keys.salt, keys.signingKey]) assert(!publicOutput.includes(value.toString()), 'secret leaked into public result');
    // Recompute from the exact write image held in test memory, never by reading keys.json.
    const persisted = JSON.parse(image);
    assert.equal(persisted.schema, 'ans-v6-keys/1'); assert.equal(persisted.network, 'mainnet');
    assert(JSON.stringify(persisted.owner) === JSON.stringify(persisted.treasury), 'placeholder owner/treasury differ');
    assert.equal((await getSchnorrAccountContractAddress(Fq.fromString(persisted.owner.signingKey), Fr.fromString(persisted.owner.salt), Fr.fromString(persisted.owner.secret))).toString(), result.address);
    await assert.rejects(generatePlaceholderAdmin(options), { code: 'EEXIST' });
  } finally { process.umask(oldMask); }
});
test('placeholder arguments reject URLs, paths, unknown and duplicate options; HOME override stays local', () => {
  for (const args of [['--node-url', 'http://127.0.0.1:8082'], ['https://rpc.invalid'], ['--dir-name', '../escape'], ['--dir-name', 'a', '--dir-name', 'b'], ['--dir-name']])
    assert.throws(() => placeholderOptions(args));
  assert.equal(placeholderOptions([], { HOME: '/tmp/offline-home' }).baseDir, '/tmp/offline-home/.local/share/ans');
});
test('placeholder entry imports no network/wallet/deployment module and prints only its public projection', () => {
  const source = readFileSync(new URL('./generate-placeholder-admin.ts', import.meta.url), 'utf8');
  assert(!/from ['"][^'"]*(?:\/node|\/wallet|\/pxe|common|deploy-v6|init-keys)[^'"]*['"]/.test(source));
  assert.match(source, /output\(JSON\.stringify\(result\)/);
  assert(!/console\.(log|error)/.test(source));
});
