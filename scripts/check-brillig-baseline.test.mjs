import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLog, normalizePath, normalizeContractPath, makeBaseline, check } from './check-brillig-baseline.mjs';

const fixture = readFileSync(new URL('./fixtures/brillig/two-kinds.log', import.meta.url), 'utf8');
const rows = parseLog(fixture);
const baseline = makeBaseline(rows, '6.0.0');
function cli(log, reference = baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'ans-brillig-'));
  try {
    writeFileSync(join(dir, 'input.log'), log);
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify(reference));
    return spawnSync(process.execPath, ['scripts/check-brillig-baseline.mjs', '--log', join(dir, 'input.log'), '--baseline', join(dir, 'baseline.json')], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('parses both diagnostic kinds and apostrophe variants', () => {
  assert.deepEqual(rows.map(r => r.kind), ['covered', 'subgraph']);
  assert.equal(parseLog(fixture.replace("isn't", 'isnt')).length, 2);
  assert.equal(parseLog(fixture.replace("isn't", 'isn’t')).length, 2);
});
test('normalizes cache, repository and relative paths without home paths', () => {
  assert.equal(normalizePath('/home/build/nargo/github.com/aztec-labs-eng/aztec-nr/v6.0.0/aztec/src/a.nr'), 'aztec-nr@v6.0.0/aztec/src/a.nr');
  assert.equal(normalizePath('/home/build/repo/contracts/test_token/src/main.nr'), 'contracts/test_token/src/main.nr');
  assert.equal(normalizePath('name_registrar/src/main.nr'), 'contracts/name_registrar/src/main.nr');
});
test('matching baseline exits zero', () => { assert.equal(cli(fixture).status, 0); });
test('R1 ANS primary exits one', () => {
  const result = cli(fixture.replace(/┌─ \S+:18:29/, '┌─ test_token/src/main.nr:18:29'));
  assert.equal(result.status, 1); assert.match(result.stderr, /R1/);
});
test('R2 new upstream fingerprint exits one', () => {
  const result = cli(fixture.replace(':18:29', ':18:30'));
  assert.equal(result.status, 1); assert.match(result.stderr, /R2/);
});
test('R2 excess fingerprint count exits one', () => {
  const result = cli(fixture + '\n' + fixture);
  assert.equal(result.status, 1); assert.match(result.stderr, /R2/);
});
test('R3 mismatched toolchain exits one', () => {
  assert.equal(cli(fixture, { ...baseline, toolchain: '5.2.1' }).status, 1);
});
test('R4 unparsed Brillig text exits one', () => {
  assert.equal(cli('Brillig diagnostic format changed').status, 1);
});
test('compiler error in an imported log exits one', () => {
  assert.equal(cli(fixture + '\nerror: compilation failed').status, 1);
});
test('scheduler ruling rejects missing diagnostics in any category', () => {
  assert.ok(check(rows.slice(0, 1), baseline, '6.0.0').errors.some(e => e.startsWith('Baseline diagnostic missing')));
});
test('test_token stays ANS for primary checks and has a separate stack category', () => {
  const tokenRows = parseLog(fixture.replaceAll('name_registrar/src/', 'test_token/src/'));
  assert.equal(tokenRows[1].category, 'test_token');
  assert.equal(tokenRows[1].businessFrames.length, 0);
  assert.ok(tokenRows[1].ansFrames.length > 0);
});
test('ANS line shifts preserve fingerprints but function changes do not', () => {
  const shifted = parseLog(fixture.replace('name_registrar/src/main.nr:44:', 'name_registrar/src/main.nr:99:'));
  assert.deepEqual(shifted.map(r => r.fingerprint), rows.map(r => r.fingerprint));
  assert.notEqual(parseLog(fixture.replace('NameRegistrar::commit', 'NameRegistrar::new_commit'))[1].fingerprint, rows[1].fingerprint);
});

test('brillig path normalization survives a checkout under a contracts directory', () => {
  assert.equal(normalizeContractPath('/home/u/contracts/ans/contracts/name_registry_v5/src/main.nr', '/home/u/contracts/ans'), 'contracts/name_registry_v5/src/main.nr');
});
test('brillig path normalization handles a foreign checkout path', () => {
  assert.equal(normalizeContractPath('/x/contracts/y/contracts/name_resolver/src/main.nr', '/another/repo'), 'contracts/name_resolver/src/main.nr');
  assert.equal(normalizePath('/x/contracts/y/contracts/name_resolver/src/main.nr'), 'contracts/name_resolver/src/main.nr');
});
test('brillig path normalization keeps an ordinary path unchanged', () => {
  assert.equal(normalizeContractPath('/home/u/ans/contracts/name_resolver/src/main.nr', '/home/u/ans'), 'contracts/name_resolver/src/main.nr');
  assert.equal(normalizePath('contracts/name_resolver/src/main.nr'), 'contracts/name_resolver/src/main.nr');
});
