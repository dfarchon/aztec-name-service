import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
export function normalizeContractPath(file, repoRoot) {
  const fromRoot = relative(repoRoot, file).replaceAll('\\', '/');
  if (fromRoot !== '..' && !fromRoot.startsWith('../') && !isAbsolute(fromRoot)) return fromRoot;
  const posix = file.replaceAll('\\', '/');
  const segment = posix.lastIndexOf('/contracts/');
  return segment >= 0 ? `contracts/${posix.slice(segment + '/contracts/'.length)}` : posix;
}
export function normalizePath(path) {
  path = path.replaceAll('\\', '/');
  if (path.includes('/aztec-nr/v6.0.0/')) return `aztec-nr@v6.0.0/${path.split('/aztec-nr/v6.0.0/')[1]}`;
  if (path.includes('/contracts/')) return normalizeContractPath(path, root);
  if (/^(?:ans_common|name_registry(?:_v[3-6])?|name_registrar(?:_tiered|_launch)?|name_resolver|test_token|registry_upgrade_test|v4_test_module)\//.test(path)) return `contracts/${path}`;
  // Never retain machine-specific home paths, even for an unrecognized dependency.
  return path.replace(/^.*\/nargo\//, 'nargo/').replace(/^\/(?:home|Users)\/[^/]+\//, '~/');
}
export function parseLog(raw) {
  const log = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const rows = [];
  for (const block of log.split(/\n(?=bug: )/)) {
    const header = block.match(/^bug: (.+)/)?.[1];
    if (!header?.includes('Brillig')) continue;
    const kind = /^Brillig function call isn['’]?t properly covered by a manual constraint$/.test(header) ? 'covered'
      : header === 'Input to Brillig function is in a separate subgraph to output' ? 'subgraph' : undefined;
    const match = block.match(/┌─ (\S+):(\d+):(\d+)/);
    if (!kind || !match) throw new Error(`Unparsed Brillig diagnostic: ${header}`);
    const primary = `${normalizePath(match[1])}:${match[2]}:${match[3]}`;
    const frames = [...block.matchAll(/^\s+\d+: (.+)\n\s+at (\S+):(\d+):(\d+)/gm)].map(m => ({
      function: m[1], file: normalizePath(m[2]), line: Number(m[3]), col: Number(m[4]),
    }));
    const ansFrames = frames.filter(f => f.file.startsWith('contracts/'));
    const businessFrames = ansFrames.filter(f => !f.file.startsWith('contracts/test_token/'));
    const tokenFrames = ansFrames.filter(f => f.file.startsWith('contracts/test_token/'));
    const category = businessFrames.length ? 'ans-business' : tokenFrames.length ? 'test_token' : 'upstream';
    const fingerprint = `${kind} | ${primary} | ${ansFrames.map(f => f.function).join(' > ')}`;
    rows.push({ fingerprint, kind, primary, category, frames, ansFrames, businessFrames, tokenFrames });
  }
  if (/Brillig/i.test(log) && !rows.length) throw new Error('Brillig text present but parsed zero diagnostics');
  if (/^(?:error:|error\[)|Failed to compile|Compilation failed/m.test(log)) throw new Error('Compilation failed');
  return rows;
}
export function makeBaseline(rows, toolchain) {
  const entries = new Map();
  for (const row of rows) {
    if (entries.has(row.fingerprint)) entries.get(row.fingerprint).count++;
    else entries.set(row.fingerprint, { fingerprint: row.fingerprint, kind: row.kind, primary: row.primary,
      category: row.category, count: 1, ansFrames: row.ansFrames,
      review: row.businessFrames.length > 0, separateSubgraph: row.kind === 'subgraph' });
  }
  return { toolchain, aztecNr: `v${toolchain}`, total: rows.length,
    byKind: { covered: rows.filter(r => r.kind === 'covered').length, subgraph: rows.filter(r => r.kind === 'subgraph').length },
    entries: [...entries.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)) };
}
export function check(rows, baseline, toolchain) {
  const errors = [];
  const actual = makeBaseline(rows, toolchain);
  const expected = new Map(baseline.entries.map(e => [e.fingerprint, e]));
  const counts = new Map(actual.entries.map(e => [e.fingerprint, e.count]));
  const newFingerprints = actual.entries.filter(e => !expected.has(e.fingerprint));
  if (baseline.toolchain !== toolchain) errors.push('R3: baseline toolchain differs from .aztecrc');
  for (const row of rows) {
    if (row.primary.startsWith('contracts/')) errors.push(`R1: ANS primary: ${row.primary}`);
    else if (!row.primary.startsWith(`aztec-nr@v${toolchain}/`)) errors.push(`Unknown primary origin: ${row.primary}`);
  }
  for (const row of actual.entries) {
    const old = expected.get(row.fingerprint);
    if (!old || row.count > old.count || old.category !== row.category) errors.push(`R2: 新上游诊断，需要人工确认后更新基线: ${row.fingerprint}`);
  }
  // Scheduler ruling: all three categories must retain their full fingerprint multisets.
  for (const row of baseline.entries) {
    if ((counts.get(row.fingerprint) ?? 0) < row.count) errors.push(`Baseline diagnostic missing: ${row.fingerprint}`);
  }
  const summary = { total: rows.length, ...actual.byKind,
    upstreamPrimary: rows.filter(r => r.primary.startsWith(`aztec-nr@v${toolchain}/`)).length,
    ansPrimary: rows.filter(r => r.primary.startsWith('contracts/')).length,
    throughBusinessANS: rows.filter(r => r.businessFrames.length).length,
    throughTestToken: rows.filter(r => r.tokenFrames.length).length,
    categories: Object.fromEntries(['upstream', 'ans-business', 'test_token'].map(c => [c, rows.filter(r => r.category === c).length])),
    newFingerprints: newFingerprints.length };
  return { summary, errors };
}
function main() {
  const args = process.argv.slice(2);
  const option = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const toolchain = readFileSync(resolve(root, '.aztecrc'), 'utf8').trim();
  const baseline = JSON.parse(readFileSync(option('--baseline') ?? resolve(root, 'scripts/brillig-baseline.json'), 'utf8'));
  let log;
  if (option('--log')) log = readFileSync(option('--log'), 'utf8');
  else {
    const result = spawnSync(process.execPath, ['../scripts/aztec.mjs', 'compile'], {
      cwd: resolve(root, 'contracts'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    log = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
    if (result.error || result.status !== 0) throw new Error(`R4: compiler failed: ${result.error?.message ?? result.status}\n${log.slice(-4000)}`);
  }
  const rows = parseLog(log);
  const result = check(rows, baseline, toolchain);
  if (args.includes('--json')) process.stdout.write(JSON.stringify({ ...result, diagnostics: rows }, null, 2) + '\n');
  else {
    console.log(JSON.stringify(result.summary));
    for (const error of result.errors) console.error(error);
  }
  process.exitCode = result.errors.length ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
