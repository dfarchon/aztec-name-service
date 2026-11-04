import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { operatorSlotProblems } from './operator-slot.mjs';
import { parse, printParseErrorCode } from 'jsonc-parser';

const repository = new URL('../', import.meta.url);
function read(path, root) {
  const content = readFileSync(new URL(path, root), 'utf8');
  if (!path.endsWith('.jsonc')) return JSON.parse(content);
  const errors = [];
  const value = parse(content, errors, { allowTrailingComma: true });
  if (errors.length)
    throw new Error(
      `${path}: ${errors.map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`).join(', ')}`,
    );
  return value;
}

/** Validate the canonical v6 deployment and compare both current Worker configurations. */
export function deploymentConfigMismatches(root = repository) {
  const deployment = assertV6ManifestFile(new URL('deployments/testnet-v6.json', root), {
    expectNetwork: 'testnet-v6',
    canonical: true,
  });
  const expected = {
    RPC_URL: deployment.nodeUrl,
    REGISTRY: deployment.registry,
    SPONSORED_FPC: deployment.sponsoredFpc,
    CHAIN_ID: deployment.chainId,
    ROLLUP_VERSION: deployment.rollupVersion,
    ROLLUP: deployment.rollup,
  };
  const problems = [];
  const publicMetadata = read('web/src/public-metadata.json', root);
  if (publicMetadata.fpcAddress !== deployment.sponsoredFpc)
    problems.push('v6 public metadata fpcAddress differs from deployment');
  if (publicMetadata.tokenClassId !== deployment.feeTokenClassId)
    problems.push('v6 public metadata tokenClassId differs from deployment');
  const configs = ['ops/wrangler.jsonc', 'ops/wrangler-monitor.jsonc'].map((path) => [
    path,
    read(path, root),
  ]);
  for (const [path, config] of configs) {
    for (const [key, value] of Object.entries(expected)) {
      if (config.vars?.[key] !== value)
        problems.push(`${path} vars.${key}=${config.vars?.[key]} expected ${value}`);
    }
    if ('RELEASE' in (config.vars ?? {})) problems.push(`${path} must not hard-code RELEASE`);
    if ('account_id' in config) problems.push(`${path} must not commit account_id`);
  }
  const [[, site], [, monitor]] = configs;
  for (const key of new Set([...Object.keys(site.vars), ...Object.keys(monitor.vars)])) {
    if (site.vars[key] !== monitor.vars[key])
      problems.push(`vars.${key} differs between Worker configs`);
  }
  if (JSON.stringify(site.d1_databases) !== JSON.stringify(monitor.d1_databases))
    problems.push('D1 bindings differ between Worker configs');
  // Historical v5 deployment validation remains independent of the current website.
  const archivedDeployment = read('deployments/testnet.json', root);
  if (!/^0x[0-9a-fA-F]{40}$/.test(archivedDeployment.rollup ?? ''))
    problems.push('deployments/testnet.json must identify the L1 rollup address');
  if (archivedDeployment.aztecVersion !== '5.2.1' || archivedDeployment.protocol !== 5)
    problems.push('v5 archive version/protocol');
  const archive = read('scripts/fixtures/aztec5-final-metadata.json', root);
  if (archive.public.fpcAddress !== archivedDeployment.sponsoredFpc)
    problems.push('v5 archive fpcAddress differs from deployment');
  return problems;
}

export function assertDeploymentConfig(root = repository) {
  const problems = [...deploymentConfigMismatches(root), ...mainnetTemplateProblems(root)];
  if (problems.length) throw new Error(`Deployment configuration drift:\n${problems.join('\n')}`);
}

/** Independent mjs profile; deployment tests compare it to the TypeScript runner. */
export const V6_TESTNET = Object.freeze({
  nodeVersion: '6.0.0',
  chainId: '11155111',
  rollupVersion: '679261766',
  rollup: '0x1f435a7f2da358caf887a470faeee7d5d5f4efba',
  realProofs: true,
  feePayment: 'sponsored',
  feeJuicePortal: '0xe59acba462a0324b1d619a7a1b219419f156f505',
  feeAssetHandler: '0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9',
  l1FeeJuice: null,
  sponsoredFpc: '0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3',
});
export function v6ManifestProblems(m, { expectNetwork } = {}) {
  const problems = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['v6 manifest must be an object'];
  const check = (ok, label) => {
    if (!ok) problems.push(label);
  };
  check(m.schema === 'ans-deployment-v6/1', 'v6 schema');
  check(m.aztecVersion === '6.0.0' && [6, 7].includes(m.protocol), 'v6 version/protocol');
  check(['local', 'testnet-v6', 'mainnet'].includes(m.network), 'v6 network');
  if (expectNetwork) check(m.network === expectNetwork, 'v6 expected network');
  if (m.registryVersion !== undefined)
    check(m.registryVersion === m.protocol, 'registryVersion/protocol');
  const address = (x) =>
    typeof x === 'string' &&
    /^0x[0-9a-f]{64}$/i.test(x) &&
    BigInt(x) < 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const zero = '0x' + '0'.repeat(64);
  const launch = m.registrarKind === 'launch';
  const free = launch && m.feeTokenSource === 'none' && m.annualPrice === '0';
  for (const key of [
    'registry',
    'resolver',
    'registrar',
    'owner',
    ...(!free ? ['feeToken', 'treasury'] : []),
  ])
    check(address(m[key]) && m[key] !== zero, `v6 address ${key}`);
  const fee = m.feePayment ?? 'sponsored';
  check(['sponsored', 'fee-juice'].includes(fee), 'v6 feePayment');
  check(
    fee === 'fee-juice'
      ? m.sponsoredFpc === null
      : address(m.sponsoredFpc) && m.sponsoredFpc !== zero,
    'v6 sponsoredFpc/feePayment',
  );
  check(/^0x[0-9a-f]{40}$/i.test(m.rollup ?? ''), 'v6 rollup address');
  check(m.legacy === zero, 'v6 legacy must be zero');
  check(
    Number.isSafeInteger(m.priceVersion) && m.priceVersion > 0 && m.priceVersion <= 4294967295,
    'v6 positive priceVersion',
  );
  const price = (x) => typeof x === 'string' && /^[1-9][0-9]*$/.test(x) && BigInt(x) < 1n << 128n;
  check(free || price(m.annualPrice), 'v6 annualPrice');
  if (free) {
    check(m.feeToken === null || m.feeToken === zero, 'v6 free feeToken');
    check(m.treasury === null || address(m.treasury), 'v6 free treasury');
    check(m.lengthPrices?.['3'] === '0' && m.lengthPrices?.['4'] === '0', 'v6 free tiers');
  }
  if (launch) {
    check(
      Number.isInteger(m.minPublicLength) && m.minPublicLength >= 3 && m.minPublicLength <= 31,
      'v6 minPublicLength',
    );
    check(typeof m.initialPaused === 'boolean', 'v6 initialPaused');
    check(
      typeof m.maxRenewAhead === 'string' &&
        /^(0|[1-9][0-9]*)$/.test(m.maxRenewAhead) &&
        BigInt(m.maxRenewAhead) < 1n << 64n,
      'v6 maxRenewAhead',
    );
    check(/^[a-f0-9]{64}$/.test(m.reservedListHash ?? ''), 'v6 reservedListHash');
    check(m.reservedVerified === true, 'v6 reservedVerified');
  }
  check(
    m.registrarKind === 'flat'
      ? m.lengthPrices === null
      : ['tiered', 'launch'].includes(m.registrarKind) &&
          (free ||
            (price(m.lengthPrices?.['3']) &&
              price(m.lengthPrices?.['4']) &&
              BigInt(m.lengthPrices['3']) >= BigInt(m.lengthPrices['4']) &&
              BigInt(m.lengthPrices['4']) >= BigInt(m.annualPrice))),
    'v6 registrarKind/lengthPrices',
  );
  check(free || ['official', 'repo'].includes(m.feeTokenSource), 'v6 feeTokenSource');
  check(
    typeof m.feeSymbol === 'string' &&
      /^[\x20-\x7e]{1,31}$/.test(m.feeSymbol) &&
      m.feeDecimals === 18,
    'v6 token metadata',
  );
  for (const key of ['registry', 'resolver', 'registrar', 'token'])
    check(address(m.classIds?.[key]), `v6 classIds.${key}`);
  const baseline = read('sdk/test/fixtures/classids-6.0.0.json', repository).classIds;
  check(
    m.classIds?.registry === (m.protocol === 7 ? baseline.v7 : baseline.v6) &&
      m.classIds?.resolver === baseline.resolver &&
      m.classIds?.registrar ===
        (launch
          ? baseline.registrarLaunch
          : m.registrarKind === 'tiered'
            ? baseline.registrarTiered
            : baseline.registrar),
    'v6 frozen ANS classes',
  );
  const tokenId = free
    ? zero
    : m.feeTokenSource === 'official'
      ? '0x067df4ddda0b0872ef604f47f3681d5e8c0de98280ac6b79963851c055ba91e0'
      : baseline.testToken;
  check(m.feeTokenClassId === tokenId && m.classIds?.token === tokenId, 'v6 token class');
  for (const key of [
    ...(!free ? ['deploy-token'] : []),
    'deploy-registry',
    'deploy-resolver',
    'deploy-registrar',
    'bootstrap',
  ])
    check(/^0x[0-9a-f]{64}$/i.test(m.transactions?.[key] ?? ''), `v6 transaction ${key}`);
  check(
    m.generator === 'e2e/src/deploy-v6.ts' &&
      typeof m.deployedAt === 'string' &&
      Number.isFinite(Date.parse(m.deployedAt)),
    'v6 generator/date',
  );
  const forbidden =
    /secret|salt|signing.?key|private.?key|mnemonic|credential|password|token.?path|path|directory|wallet|^keys$|^seed$|api.?key/i;
  const scan = (value) => {
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        check(!forbidden.test(key), 'v6 forbidden private/path field');
        scan(child);
      }
  };
  scan(m);
  try {
    const url = new URL(m.nodeUrl);
    check(
      ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      'v6 nodeUrl',
    );
    if (m.network === 'local')
      check(['127.0.0.1', 'localhost'].includes(url.hostname), 'v6 local URL');
  } catch {
    problems.push('v6 nodeUrl');
  }
  check(typeof m.chainId === 'string' && /^[1-9][0-9]*$/.test(m.chainId), 'v6 chainId');
  check(
    typeof m.rollupVersion === 'string' && /^[0-9]+$/.test(m.rollupVersion),
    'v6 rollupVersion',
  );
  check(typeof m.realProofs === 'boolean', 'v6 realProofs');
  if (m.network === 'local')
    check(m.chainId === '31337' && m.realProofs === false, 'v6 local identity');
  if (expectNetwork === 'testnet-v6' || m.network === 'testnet-v6') {
    check(m.protocol === 6, 'testnet requires protocol 6');
    check(m.nodeUrl === 'https://aztec-testnet.drpc.org', 'v6 testnet nodeUrl');
    for (const key of ['chainId', 'rollupVersion', 'rollup', 'sponsoredFpc', 'realProofs'])
      check(
        key === 'sponsoredFpc' && fee === 'fee-juice'
          ? m[key] === null
          : m[key] === V6_TESTNET[key],
        `v6 testnet ${key}`,
      );
  }
  if (m.network === 'mainnet') {
    check(m.protocol === 7, 'mainnet requires protocol 7');
    check(m.adminPlaceholder !== true, 'admin placeholder');
    if (launch) check(m.maxRenewAhead === '31536000', 'mainnet maxRenewAhead must be 31536000');
    check(fee === 'fee-juice', 'v6 mainnet feePayment');
    for (const key of ['chainId', 'rollupVersion', 'rollup', 'realProofs'])
      check(m[key] === V6_MAINNET[key], `v6 mainnet ${key}`);
  }
  return problems;
}
export function assertV6ManifestFile(path, { expectNetwork, canonical = false } = {}) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const problems = v6ManifestProblems(manifest, { expectNetwork });
  if (canonical && (manifest.sample === true || manifest.template === true))
    problems.push('sample cannot be a canonical testnet deployment');
  if (problems.length) throw new Error(`Invalid v6 manifest: ${problems.join(', ')}`);
  return manifest;
}

export const V6_MAINNET = Object.freeze({
  nodeVersion: '6.0.0',
  chainId: '1',
  rollupVersion: '2070860440',
  rollup: '0xe37a2663cc9c119ba41572c40fab0bbb23a5402f',
  realProofs: true,
  sponsoredFpc: null,
  feePayment: 'fee-juice',
  feeJuicePortal: '0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3',
  feeAssetHandler: null,
  l1FeeJuice: '0xa27ec0006e59f245217ff08cd52a7e8b169e62d2',
});
export function mainnetTemplateProblems(root = repository) {
  const m = read('deployments/mainnet.template.json', root),
    problems = [];
  if (
    m.template !== true ||
    m.network !== 'mainnet' ||
    m.protocol !== 7 ||
    m.registryVersion !== 7 ||
    m.aztecVersion !== '6.0.0'
  )
    problems.push('mainnet template marker/identity');
  for (const [key, value] of Object.entries(V6_MAINNET))
    if (m[key] !== value) problems.push(`mainnet template ${key}`);
  for (const key of [
    'nodeUrl',
    'domain',
    'registry',
    'resolver',
    'registrar',
    'feeToken',
    'annualPrice',
    'lengthPrices',
    'priceVersion',
    'owner',
    'operator',
    'operatorBalanceSlot',
    'operatorLowWatermark',
  ])
    if (m[key] !== null) problems.push(`mainnet undecided ${key} must be null`);
  const address = (value) =>
    typeof value === 'string' &&
    /^0x[0-9a-f]{64}$/i.test(value) &&
    BigInt(value) > 0n &&
    BigInt(value) < 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  if (m.admin !== null && !address(m.admin)) problems.push('mainnet template admin');
  if (m.treasury !== m.admin)
    problems.push('mainnet template treasury must match placeholder admin');
  if (m.adminPlaceholder !== true || !/PLACEHOLDER/.test(m._note ?? ''))
    problems.push('mainnet template admin placeholder marker');
  if (m.registrarKind !== 'launch' || m.minPublicLength !== 7 || m.initialPaused !== true)
    problems.push('mainnet template launch policy');
  if (m.maxRenewAhead !== '31536000')
    problems.push('mainnet template maxRenewAhead must be 31536000');
  const reserved = read('deployments/reserved-labels.json', root);
  const hash = createHash('sha256')
    .update(JSON.stringify(Object.values(reserved.categories).flat().sort()))
    .digest('hex');
  if (m.reservedListHash !== hash) problems.push('mainnet template reservedListHash');
  const paths = ['ops/wrangler-mainnet.jsonc', 'ops/wrangler-monitor-mainnet.jsonc'];
  const configs = paths.map((path) => read(path, root));
  const expected = {
    CHAIN_ID: V6_MAINNET.chainId,
    ROLLUP_VERSION: V6_MAINNET.rollupVersion,
    ROLLUP: V6_MAINNET.rollup,
    FEE_PAYMENT: 'fee-juice',
    NETWORK_LABEL: 'mainnet',
  };
  configs.forEach((c, i) => {
    for (const [key, value] of Object.entries(expected))
      if (c.vars?.[key] !== value) problems.push(`${paths[i]} ${key}`);
    for (const key of [
      'RPC_URL',
      'REGISTRY',
      'SITE_URL',
      'OPERATOR',
      'OPERATOR_BALANCE_SLOT',
      'OPERATOR_LOW_WATERMARK',
    ])
      if (c.vars?.[key] !== 'UNDECIDED') problems.push(`${paths[i]} placeholder ${key}`);
    if (
      c.name !== 'UNDECIDED' ||
      c.d1_databases?.[0]?.database_id !== '00000000-0000-0000-0000-000000000000' ||
      !readFileSync(new URL(paths[i], root), 'utf8').includes('// PLACEHOLDER')
    )
      problems.push(`${paths[i]} resource placeholders`);
    if ('account_id' in c || 'RELEASE' in (c.vars ?? {}) || 'SPONSORED_FPC' in (c.vars ?? {}))
      problems.push(`${paths[i]} forbidden configuration`);
  });
  if (
    JSON.stringify(configs[0].vars) !== JSON.stringify(configs[1].vars) ||
    JSON.stringify(configs[0].d1_databases) !== JSON.stringify(configs[1].d1_databases)
  )
    problems.push('mainnet Worker configs disagree');
  return problems;
}

async function cli() {
  assertDeploymentConfig();
  const slots = await operatorSlotProblems(
    [
      'ops/wrangler.jsonc',
      'ops/wrangler-monitor.jsonc',
      'ops/wrangler-mainnet.jsonc',
      'ops/wrangler-monitor-mainnet.jsonc',
    ].map((path) => [path, read(path, repository)]),
  );
  if (slots.length) throw new Error(slots.join(', '));
  console.log('Deployment configuration is consistent.');
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--v6-manifest')
      throw new Error('Expected --v6-manifest <path>');
    assertV6ManifestFile(resolve(args[1]));
    console.log('V6 explicit manifest is consistent.');
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
