import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { assertDeploymentConfig, deploymentConfigMismatches } from './deployment-config.mjs';
// macOS tmpdir() is under /var, a symlink to /private/var; path checks compare physical paths.
const tmpdir = () => realpathSync(osTmpdir());

function fixture(t, { unconfiguredMainnet = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fog-deployment-config-'));
  const root = pathToFileURL(`${directory}/`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [
    ...(!unconfiguredMainnet ? ['deployments/mainnet.json'] : []),
    'deployments/mainnet.template.json',
    'deployments/reserved-labels.json',
    'ops/wrangler-mainnet.jsonc',
    'ops/wrangler-monitor-mainnet.jsonc',
    'deployments/aztec-pricing.json',
    'deployments/testnet.json',
    'deployments/testnet-v6.json',
    'ops/wrangler.jsonc',
    'ops/wrangler-monitor.jsonc',
    'web/src/public-metadata.json',
    'scripts/fixtures/aztec5-final-metadata.json',
  ];
  for (const file of files) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(new URL(file, root), readFileSync(new URL(`../${file}`, import.meta.url)));
  }
  if (unconfiguredMainnet) {
    for (const file of ['ops/wrangler-mainnet.jsonc', 'ops/wrangler-monitor-mainnet.jsonc']) {
      const path = new URL(file, root);
      const data = JSON.parse(
        readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('//'))
          .join('\n'),
      );
      data.d1_databases[0].database_id = '00000000-0000-0000-0000-000000000000';
      data.vars.REGISTRY = 'UNDECIDED';
      data.vars.OPERATOR = 'UNDECIDED';
      data.vars.OPERATOR_BALANCE_SLOT = 'UNDECIDED';
      data.vars.OPERATOR_LOW_WATERMARK = 'UNDECIDED';
      writeFileSync(
        path,
        `// PLACEHOLDER: REGISTRY, OPERATOR and D1 database_id remain undecided until contract deployment.\n${JSON.stringify(data, null, 2)}\n`,
      );
    }
  }
  const update = (file, edit) => {
    const path = new URL(file, root),
      data = JSON.parse(readFileSync(path, 'utf8'));
    edit(data);
    writeFileSync(path, JSON.stringify(data, null, 2));
  };
  return { root, update };
}

test('canonical deployment agrees with both Workers', () => {
  assert.deepEqual(deploymentConfigMismatches(), []);
});

test('matching but incorrect Worker rollups are rejected against the canonical address', (t) => {
  const { root, update } = fixture(t);
  for (const file of ['ops/wrangler.jsonc', 'ops/wrangler-monitor.jsonc'])
    update(file, (config) => {
      config.vars.ROLLUP = `0x${'0'.repeat(40)}`;
    });
  assert.equal(
    deploymentConfigMismatches(root).filter((problem) => problem.includes('vars.ROLLUP=')).length,
    2,
  );
  assert.throws(() => assertDeploymentConfig(root), /ROLLUP/);
});

test('a missing canonical v6 Rollup cannot disable network validation', (t) => {
  const { root, update } = fixture(t);
  update('deployments/testnet-v6.json', (deployment) => {
    delete deployment.rollup;
  });
  assert.throws(() => assertDeploymentConfig(root), /v6 rollup address/);
});

test('Wrangler JSONC accepts comments and trailing commas without changing URL strings', (t) => {
  const { root } = fixture(t);
  for (const file of ['ops/wrangler.jsonc', 'ops/wrangler-monitor.jsonc']) {
    const path = new URL(file, root),
      content = readFileSync(path, 'utf8').trimEnd();
    writeFileSync(path, `// JSONC comment\n${content.slice(0, -1)},\n}`);
  }
  assert.deepEqual(deploymentConfigMismatches(root), []);
});

test('malformed JSONC fails with the configuration file and parse error', (t) => {
  const { root } = fixture(t);
  writeFileSync(new URL('ops/wrangler.jsonc', root), '{ "vars": invalid }');
  assert.throws(() => deploymentConfigMismatches(root), /ops\/wrangler\.jsonc:.*InvalidSymbol/);
});

test('current v6 FPC metadata and historical v5 FPC metadata are checked independently', (t) => {
  const { root, update } = fixture(t);
  update('web/src/public-metadata.json', (metadata) => {
    metadata.fpcAddress = `0x${'1'.repeat(64)}`;
  });
  assert.throws(() => assertDeploymentConfig(root), /v6 public metadata fpcAddress/);
  update('web/src/public-metadata.json', (metadata) => {
    metadata.fpcAddress = v6Canonical.sponsoredFpc;
  });
  update('deployments/testnet.json', (deployment) => {
    deployment.sponsoredFpc = `0x${'2'.repeat(64)}`;
  });
  assert.throws(() => assertDeploymentConfig(root), /v5 archive fpcAddress/);
});

// Canonical v6 publication is required; synthetic samples remain useful for schema checks.
import { assertV6ManifestFile, v6ManifestProblems } from './deployment-config.mjs';
const v6Canonical = JSON.parse(
  readFileSync(new URL('../deployments/testnet-v6.json', import.meta.url), 'utf8'),
);
const v6Sample = JSON.parse(
  readFileSync(new URL('./fixtures/v6-manifest-testnet-sample.json', import.meta.url), 'utf8'),
);
test('synthetic tiered v6 testnet manifest validates independently of current Workers', () => {
  assert.deepEqual(v6ManifestProblems(v6Sample, { expectNetwork: 'testnet-v6' }), []);
});
test('v6 rejects every testnet identity drift', () => {
  for (const key of ['chainId', 'rollupVersion', 'rollup', 'sponsoredFpc', 'realProofs']) {
    const m = structuredClone(v6Sample);
    m[key] = key === 'realProofs' ? false : 'wrong';
    assert(v6ManifestProblems(m, { expectNetwork: 'testnet-v6' }).some((p) => p.includes(key)));
  }
});
test('v6 rejects schema, classes, token metadata, addresses, prices and missing hashes', () => {
  for (const edit of [
    (m) => {
      m.schema = 'wrong';
    },
    (m) => {
      m.protocol = 5;
    },
    (m) => {
      m.registry = '0x01';
    },
    (m) => {
      m.legacy = m.registry;
    },
    (m) => {
      m.priceVersion = 0;
    },
    (m) => {
      delete m.lengthPrices['4'];
    },
    (m) => {
      m.registrarKind = 'flat';
    },
    (m) => {
      m.feeDecimals = 6;
    },
    (m) => {
      m.classIds.registry = m.registry;
    },
    (m) => {
      m.classIds.token = m.registry;
    },
    (m) => {
      delete m.transactions.bootstrap;
    },
    (m) => {
      m.annualPrice = '-1';
    },
  ]) {
    const m = structuredClone(v6Sample);
    edit(m);
    assert(v6ManifestProblems(m).length > 0);
  }
});
test('v6 rejects nested private fields', () => {
  for (const field of [
    'secret',
    'salt',
    'signingKey',
    'keys',
    'privateKey',
    'mnemonic',
    'private_key',
    'seed',
    'credentials',
    'statePath',
    'walletDirectory',
    'apiKey',
  ]) {
    const m = structuredClone(v6Sample);
    m.extra = { nested: { [field]: 'redacted' } };
    assert(v6ManifestProblems(m).includes('v6 forbidden private/path field'));
  }
});
test('sample v6 manifest cannot masquerade as canonical public deployment', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'fog-v6-sample-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const path = join(d, 'testnet-v6.json');
  writeFileSync(path, JSON.stringify(v6Sample));
  assert.throws(
    () => assertV6ManifestFile(path, { expectNetwork: 'testnet-v6', canonical: true }),
    /sample/,
  );
  assert.doesNotThrow(() => assertV6ManifestFile(path));
});
test('valid v6 presence cannot hide v5 deployment drift', (t) => {
  const { root, update } = fixture(t);
  writeFileSync(
    new URL('deployments/testnet-v6.json', root),
    JSON.stringify({ ...v6Sample, sample: false }),
  );
  assert.deepEqual(v6ManifestProblems(v6Sample), []);
  update('deployments/testnet.json', (m) => {
    delete m.rollup;
  });
  assert.throws(() => assertDeploymentConfig(root), /must identify the L1 rollup address/);
});
test('local v6 manifest must remain local and proof-disabled', () => {
  const m = {
    ...v6Sample,
    network: 'local',
    chainId: '31337',
    realProofs: false,
    nodeUrl: 'http://127.0.0.1:8080',
  };
  assert.deepEqual(v6ManifestProblems(m, { expectNetwork: 'local' }), []);
  assert(v6ManifestProblems({ ...m, nodeUrl: 'https://example.com' }).length);
  assert(v6ManifestProblems({ ...m, realProofs: true }).length);
  assert(v6ManifestProblems(m, { expectNetwork: 'testnet-v6' }).length);
});

test('canonical v6 manifest validates and its absence cannot be skipped', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(
    assertV6ManifestFile(new URL('deployments/testnet-v6.json', root), {
      expectNetwork: 'testnet-v6',
      canonical: true,
    }),
    v6Canonical,
  );
  rmSync(new URL('deployments/testnet-v6.json', root));
  assert.throws(() => assertDeploymentConfig(root), /ENOENT/);
});

test('canonical v6 validation rejects address, network, class and private data tampering', (t) => {
  const { root, update } = fixture(t);
  const edits = [
    (m) => {
      m.registry = '0x01';
    },
    (m) => {
      m.chainId = '31337';
    },
    (m) => {
      m.rollupVersion = '1821665230';
    },
    (m) => {
      m.rollup = '0x' + '1'.repeat(40);
    },
    (m) => {
      m.classIds.registry = '0x' + '1'.repeat(64);
    },
    (m) => {
      m.classIds.registrar = m.classIds.resolver;
    },
    (m) => {
      m.classIds.token = m.classIds.registry;
    },
    (m) => {
      m.extra = { privateKey: 'redacted' };
    },
    (m) => {
      m.extra = { statePath: '/redacted' };
    },
    (m) => {
      m.nodeUrl = 'https://other.example';
    },
    (m) => {
      m.sample = true;
    },
  ];
  for (const edit of edits) {
    writeFileSync(new URL('deployments/testnet-v6.json', root), JSON.stringify(v6Canonical));
    update('deployments/testnet-v6.json', edit);
    assert.throws(() => assertDeploymentConfig(root), /Invalid v6 manifest/);
  }
});

test('every current Worker network var is checked against v6 even when both drift together', (t) => {
  const { root, update } = fixture(t);
  const files = ['ops/wrangler.jsonc', 'ops/wrangler-monitor.jsonc'];
  for (const key of [
    'RPC_URL',
    'REGISTRY',
    'SPONSORED_FPC',
    'CHAIN_ID',
    'ROLLUP_VERSION',
    'ROLLUP',
  ]) {
    for (const file of files)
      update(file, (c) => {
        c.vars[key] = 'drift';
      });
    assert.equal(
      deploymentConfigMismatches(root).filter((p) => p.includes(`vars.${key}=`)).length,
      2,
    );
    assert.throws(() => assertDeploymentConfig(root), new RegExp(key));
    for (const file of files)
      writeFileSync(new URL(file, root), readFileSync(new URL(`../${file}`, import.meta.url)));
  }
  update('deployments/testnet-v6.json', (m) => {
    m.registry = '0x' + '1'.repeat(64);
  });
  assert.throws(() => assertDeploymentConfig(root), /vars.REGISTRY/);
});

test('Worker bindings, shared vars, account_id and RELEASE drift are rejected', (t) => {
  const { root, update } = fixture(t);
  update('ops/wrangler.jsonc', (c) => {
    c.vars.SITE_URL = 'https://drift.example';
    c.vars.RELEASE = 'hard-coded';
    c.account_id = 'do-not-commit';
    c.d1_databases[0].database_id = 'drift';
  });
  const problems = deploymentConfigMismatches(root).join('\n');
  for (const pattern of [/SITE_URL differs/, /hard-code RELEASE/, /account_id/, /D1 bindings/])
    assert.match(problems, pattern);
});

test('v6 public fee token class metadata cannot drift from the manifest', (t) => {
  const { root, update } = fixture(t);
  update('web/src/public-metadata.json', (m) => {
    m.tokenClassId = v6Canonical.classIds.registry;
  });
  assert.throws(() => assertDeploymentConfig(root), /tokenClassId/);
});

import { mainnetTemplateProblems } from './deployment-config.mjs';
import { mainnetBlockers } from './mainnet-readiness.mjs';
import { buildSite } from './build-site.mjs';
import { deploySite } from './deploy-site.mjs';
import { operatorSlotProblems } from './operator-slot.mjs';
test('mainnet template validates, live mainnet has zero blockers, and each undecided item has a named blocker', (t) => {
  assert.deepEqual(mainnetTemplateProblems(), []);
  assert.deepEqual(mainnetBlockers(), []);

  const { root } = fixture(t, { unconfiguredMainnet: true });
  const blockers = mainnetBlockers(root);
  for (const item of [
    'settlement.l2Token',
    'annualPriceStatus provisional',
    'admin/multisig',
    'treasury',
    'domain',
    'nodeUrl',
    'site.REGISTRY',
    'site.D1 id',
    'monitor.REGISTRY',
    'monitor.D1 id',
    'deployments/mainnet.json absent',
  ])
    assert.ok(blockers.includes(item), item);

  for (const file of ['ops/wrangler-mainnet.jsonc', 'ops/wrangler-monitor-mainnet.jsonc']) {
    writeFileSync(
      new URL(file, root),
      JSON.stringify({
        name: 'UNDECIDED',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'UNDECIDED',
            database_id: '00000000-0000-0000-0000-000000000000',
          },
        ],
        vars: { RPC_URL: 'UNDECIDED', REGISTRY: 'UNDECIDED', SITE_URL: 'UNDECIDED' },
      }),
    );
  }
  const undecidedBlockers = mainnetBlockers(root);
  for (const item of [
    'site.SITE_URL',
    'site.RPC_URL',
    'site.worker name',
    'site.monitor service',
    'site.RUM_LIMITER namespace_id',
    'monitor.SITE_URL',
    'monitor.RPC_URL',
    'monitor.worker name',
  ])
    assert.ok(undecidedBlockers.includes(item), item);
});
test('mainnet build and site deploy refuse unconfigured root before any exec spy', (t) => {
  const { root } = fixture(t, { unconfiguredMainnet: true });
  let calls = 0;
  const exec = () => {
    calls++;
    throw new Error('exec forbidden');
  };
  assert.throws(
    () => buildSite(['--network', 'mainnet'], { exec, root }),
    /Mainnet blocked:.*settlement.l2Token/,
  );
  assert.throws(
    () => deploySite(['--network', 'mainnet'], { exec, root }),
    /Mainnet blocked:.*admin\/multisig/,
  );
  assert.equal(calls, 0);
});
test('fee-juice manifests require null sponsor while absent feePayment retains sponsored validation', () => {
  assert.deepEqual(v6ManifestProblems(v6Canonical), []);
  assert.deepEqual(
    v6ManifestProblems({ ...v6Canonical, feePayment: 'fee-juice', sponsoredFpc: null }),
    [],
  );
  assert.ok(
    v6ManifestProblems({ ...v6Canonical, feePayment: 'fee-juice' }).includes(
      'v6 sponsoredFpc/feePayment',
    ),
  );
  assert.ok(
    v6ManifestProblems({ ...v6Canonical, sponsoredFpc: null }).includes(
      'v6 sponsoredFpc/feePayment',
    ),
  );
});
test('canonical templates cannot masquerade as a deployment', (t) => {
  const { root } = fixture(t);
  const path = new URL('deployments/testnet-v6.json', root);
  writeFileSync(path, JSON.stringify({ ...v6Canonical, template: true }));
  assert.throws(() => assertV6ManifestFile(path, { canonical: true }), /sample cannot/);
});
test('mainnet template detects invented values, FPC, identities and missing placeholder comments', (t) => {
  const { root, update } = fixture(t, { unconfiguredMainnet: true });
  update('deployments/mainnet.template.json', (m) => {
    m.treasury = 'invented';
    m.chainId = '2';
  });
  assert.ok(mainnetTemplateProblems(root).some((p) => p.includes('treasury')));
  const path = new URL('ops/wrangler-mainnet.jsonc', root);
  writeFileSync(
    path,
    readFileSync(path, 'utf8')
      .replace('// PLACEHOLDER:', '// resources:')
      .replace('"FEE_PAYMENT": "fee-juice"', '"FEE_PAYMENT": "sponsored"'),
  );
  const p = mainnetTemplateProblems(root);
  assert.ok(p.some((p) => p.includes('FEE_PAYMENT')));
  assert.ok(p.some((p) => p.includes('resource placeholders')));
});
test('operator slot validation rejects wrong slots and ignores undecided operators', async () => {
  assert.deepEqual(
    await operatorSlotProblems([['mainnet', { vars: { OPERATOR: 'UNDECIDED' } }]]),
    [],
  );
  const vars = {
    OPERATOR: '0x' + '0'.repeat(63) + '1',
    OPERATOR_BALANCE_SLOT: '0x' + '0'.repeat(64),
  };
  assert.deepEqual(await operatorSlotProblems([['monitor', { vars }]]), [
    'monitor OPERATOR_BALANCE_SLOT mismatch',
  ]);
});

test('external preview refuses canonical output and output containing its manifest before exec', (t) => {
  const { root } = fixture(t);
  const manifest = new URL('preview.json', root).pathname;
  writeFileSync(
    manifest,
    JSON.stringify({ ...v6Canonical, sample: true, feePayment: 'fee-juice', sponsoredFpc: null }),
  );
  let calls = 0;
  const exec = () => {
    calls++;
    throw new Error('exec forbidden');
  };
  for (const argv of [
    ['--network', 'testnet-v6', '--manifest', manifest],
    [
      '--network',
      'testnet-v6',
      '--manifest',
      manifest,
      '--out',
      new URL('web/dist', root).pathname,
    ],
    ['--network', 'testnet-v6', '--manifest', manifest, '--out', new URL('.', root).pathname],
    [
      '--network',
      'testnet-v6',
      '--manifest',
      new URL('deployments/testnet-v6.json', root).pathname,
      '--out',
      new URL('preview', root).pathname,
    ],
  ])
    assert.throws(() => buildSite(argv, { exec, root }), /Preview requires/);
  assert.equal(calls, 0);
});

import { execFileSync } from 'node:child_process';
import { symlinkSync, unlinkSync } from 'node:fs';
import { consumerFiles, packageConsumer } from './package-consumer.mjs';

function consumerFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fog-consumer-files-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', directory]);
  const dir = join(directory, 'examples/consumer');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'read.ts'), 'export {};\n');
  writeFileSync(join(dir, 'nested/browser.ts'), 'export {};\n');
  writeFileSync(join(directory, '.gitignore'), '*.log\n');
  execFileSync('git', ['add', '.'], { cwd: directory });
  const exec = (command, args, options) =>
    execFileSync(command, args, { ...options, cwd: directory });
  return { dir, exec };
}

test('consumer packaging accepts only tracked regular files, including nested files', (t) => {
  const { dir, exec } = consumerFixture(t);
  assert.deepEqual(consumerFiles(dir, { exec }), ['nested/browser.ts', 'read.ts']);
});
for (const kind of ['ignored', 'untracked', 'symlink', 'missing']) {
  test(`consumer packaging rejects ${kind} files before any copy`, (t) => {
    const { dir, exec } = consumerFixture(t);
    if (kind === 'ignored') writeFileSync(join(dir, 'canary.log'), 'harmless ignored canary');
    if (kind === 'untracked') writeFileSync(join(dir, 'extra.txt'), 'harmless untracked canary');
    if (kind === 'symlink') symlinkSync('read.ts', join(dir, 'link.ts'));
    if (kind === 'missing') unlinkSync(join(dir, 'read.ts'));
    assert.throws(() => consumerFiles(dir, { exec }), /untracked|symlink|missing|regular/i);
  });
}

test('consumer packaging requires an explicitly validated deployment before work begins', () => {
  assert.throws(() => packageConsumer('/unused-output', 'test'), /deployment/i);
});

for (const preview of [false, true]) {
  test(`${preview ? 'preview' : 'canonical'} site passes its validated deployment to consumer packaging`, (t) => {
    const { root } = fixture(t);
    const deployment = preview
      ? {
          ...v6Canonical,
          registry: `0x${'1'.repeat(64)}`,
          sample: true,
          feePayment: 'fee-juice',
          sponsoredFpc: null,
        }
      : v6Canonical;
    const out = new URL(preview ? 'preview-out' : 'web/dist', root).pathname;
    mkdirSync(out, { recursive: true });
    const manifest = new URL('preview.json', root).pathname;
    if (preview) writeFileSync(manifest, JSON.stringify(deployment));
    const argv = [
      '--network',
      'testnet-v6',
      ...(preview ? ['--manifest', manifest, '--out', out] : []),
    ];
    const calls = [];
    buildSite(argv, {
      root,
      exec: (command, args) => (command === 'git' ? (args[0] === 'rev-parse' ? 'abc123' : '') : ''),
      packageConsumer: (...args) => {
        calls.push(args);
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `${out}/downloads/sdk`);
    assert.equal(calls[0][1], 'abc123');
    assert.deepEqual(calls[0][2], deployment);
  });
}

test('launch manifests validate both free and paid modes without changing the testnet manifest', async () => {
  const { v6ManifestProblems } = await import('./deployment-config.mjs');
  const baseline = JSON.parse(
    readFileSync(new URL('../sdk/test/fixtures/classids-6.0.0.json', import.meta.url)),
  ).classIds;
  const m = JSON.parse(readFileSync(new URL('../deployments/testnet-v6.json', import.meta.url)));
  Object.assign(m, {
    registrarKind: 'launch',
    minPublicLength: 7,
    initialPaused: true,
    maxRenewAhead: '0',
    reservedListHash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    reservedVerified: true,
  });
  m.classIds.registrar = baseline.registrarLaunch;
  assert.deepEqual(v6ManifestProblems(m), []);
  const zero = '0x' + '0'.repeat(64);
  Object.assign(m, {
    feeToken: zero,
    feeTokenSource: 'none',
    feeTokenClassId: zero,
    annualPrice: '0',
    lengthPrices: { 3: '0', 4: '0' },
    treasury: null,
  });
  m.classIds.token = zero;
  assert.deepEqual(v6ManifestProblems(m), []);
  for (const patch of [
    { minPublicLength: 2 },
    { maxRenewAhead: null },
    { reservedListHash: null },
    { reservedVerified: false },
    { feeTokenSource: 'official' },
    { annualPrice: '1' },
  ])
    assert(v6ManifestProblems({ ...m, ...patch }).length > 0);
});

test('mainnet launch readiness requires exactly one year and rejects all other caps', (t) => {
  const f = fixture(t);
  for (const [maxRenewAhead, blocked] of [
    ['31536000', false],
    ['0', true],
    ['315360000', true],
    ['315360001', true],
    ['18446744073709551615', true],
    ['-1', true],
    ['1.5', true],
    [null, true],
  ]) {
    writeFileSync(
      new URL('deployments/mainnet.json', f.root),
      JSON.stringify({ registrarKind: 'launch', maxRenewAhead }),
    );
    assert.equal(mainnetBlockers(f.root).includes('maxRenewAhead'), blocked, String(maxRenewAhead));
  }
});

test('V8 mainnet template pins free launch defaults, the reserved hash and a flagged placeholder administrator', (t) => {
  const { root, update } = fixture(t, { unconfiguredMainnet: true });
  assert.deepEqual(mainnetTemplateProblems(root), []);
  const template = JSON.parse(
    readFileSync(new URL('deployments/mainnet.template.json', root), 'utf8'),
  );
  assert.match(template.admin, /^0x[0-9a-f]{64}$/);
  assert.equal(template.treasury, template.admin);
  assert.equal(template.protocol, 8);
  assert.equal(template.registryVersion, 8);
  assert.equal(template.allowRehearsalSuccessor, false);
  assert.equal(template.feeTokenSource, 'none');
  assert.equal(template.annualPrice, '0');
  assert.equal(template.adminPlaceholder, true);
  assert.equal(template.maxRenewAhead, '31536000');
  writeFileSync(new URL('deployments/mainnet.json', root), JSON.stringify(template));
  assert(mainnetBlockers(root).includes('admin placeholder'));
  update('deployments/mainnet.template.json', (m) => {
    m.protocol = 7;
    m.maxRenewAhead = '0';
    m.reservedListHash = '0'.repeat(64);
  });
  const errors = mainnetTemplateProblems(root);
  for (const text of ['identity', 'maxRenewAhead', 'reservedListHash'])
    assert(errors.some((error) => error.includes(text)));
});
test('readiness rejects V6/V7 mainnet, rehearsal successor flags and every launch renewal horizon other than one year', (t) => {
  const { root } = fixture(t);
  for (const protocol of [6, 7]) {
    writeFileSync(
      new URL('deployments/mainnet.json', root),
      JSON.stringify({ protocol, registrarKind: 'launch', maxRenewAhead: '31536000' }),
    );
    assert(mainnetBlockers(root).includes('protocol 8 required'));
    assert(!mainnetBlockers(root).includes('maxRenewAhead'));
  }
  writeFileSync(
    new URL('deployments/mainnet.json', root),
    JSON.stringify({
      protocol: 8,
      registryVersion: 8,
      allowRehearsalSuccessor: true,
      registrarKind: 'launch',
      maxRenewAhead: '31536000',
    }),
  );
  assert(mainnetBlockers(root).includes('allowRehearsalSuccessor forbidden'));
  assert.deepEqual(v6ManifestProblems(v6Canonical), []);
});

test('configured V8 free-launch mainnet manifest and Wrangler configs pass readiness and deploy cleanly', (t) => {
  const { root } = fixture(t);
  const baseline = JSON.parse(
    readFileSync(new URL('../sdk/test/fixtures/classids-6.0.0.json', import.meta.url), 'utf8'),
  ).classIds;
  const zero = '0x' + '0'.repeat(64);
  const admin = `0x${'0'.repeat(63)}1`;
  const registry = `0x${'0'.repeat(63)}2`;
  const resolver = `0x${'0'.repeat(63)}3`;
  const registrar = `0x${'0'.repeat(63)}4`;
  const tx = `0x${'5'.repeat(64)}`;
  const template = JSON.parse(
    readFileSync(new URL('deployments/mainnet.template.json', root), 'utf8'),
  );
  const mainnetManifest = {
    schema: 'fog-deployment-v6/1',
    network: 'mainnet',
    aztecVersion: '6.0.0',
    protocol: 8,
    registryVersion: 8,
    allowRehearsalSuccessor: false,
    nodeUrl: 'https://aztec-mainnet.drpc.org',
    domain: 'https://fog.example',
    chainId: '1',
    rollupVersion: '2070860440',
    rollup: '0xe37a2663cc9c119ba41572c40fab0bbb23a5402f',
    realProofs: true,
    feePayment: 'fee-juice',
    sponsoredFpc: null,
    admin,
    owner: admin,
    treasury: null,
    registry,
    resolver,
    registrar,
    registrarKind: 'launch',
    legacy: zero,
    feeToken: zero,
    feeTokenSource: 'none',
    feeTokenClassId: zero,
    feeSymbol: 'FREE',
    feeDecimals: 18,
    annualPrice: '0',
    lengthPrices: { 3: '0', 4: '0' },
    priceVersion: 1,
    minPublicLength: 7,
    initialPaused: true,
    maxRenewAhead: '31536000',
    reservedListHash: template.reservedListHash,
    reservedVerified: true,
    classIds: {
      registry: baseline.v8,
      resolver: baseline.resolver,
      registrar: baseline.registrarLaunch,
      token: zero,
    },
    transactions: {
      'deploy-registry': tx,
      'deploy-resolver': tx,
      'deploy-registrar': tx,
      bootstrap: tx,
    },
    generator: 'e2e/src/mainnet-v8-launch.ts',
    deployedAt: '2026-11-19T00:00:00.000Z',
  };
  assert.deepEqual(v6ManifestProblems(mainnetManifest, { expectNetwork: 'mainnet' }), []);
  assert(
    v6ManifestProblems(
      {
        ...mainnetManifest,
        classIds: { ...mainnetManifest.classIds, registry: baseline.v8Rehearsal },
      },
      { expectNetwork: 'mainnet' },
    ).includes('v6 frozen Fog classes'),
  );
  writeFileSync(
    new URL('deployments/mainnet.json', root),
    JSON.stringify(mainnetManifest, null, 2),
  );
  const sharedVars = {
    RPC_URL: 'https://aztec-mainnet.drpc.org',
    REGISTRY: registry,
    SITE_URL: 'https://fog.example',
    CHAIN_ID: '1',
    ROLLUP_VERSION: '2070860440',
    ROLLUP: '0xe37a2663cc9c119ba41572c40fab0bbb23a5402f',
    FEE_PAYMENT: 'fee-juice',
    NETWORK_LABEL: 'mainnet',
    OPERATOR: 'UNDECIDED',
    OPERATOR_BALANCE_SLOT: 'UNDECIDED',
    OPERATOR_LOW_WATERMARK: 'UNDECIDED',
    BLOCK_STALE_SECONDS: '600',
  };
  const d1 = [
    {
      binding: 'DB',
      database_name: 'fog-mainnet-monitor',
      database_id: '11111111-2222-3333-4444-555555555555',
    },
  ];
  writeFileSync(
    new URL('ops/wrangler-monitor-mainnet.jsonc', root),
    JSON.stringify({
      name: 'fog-mainnet-monitor',
      main: 'src/probe-worker.ts',
      compatibility_date: '2026-10-08',
      workers_dev: false,
      preview_urls: false,
      d1_databases: d1,
      vars: sharedVars,
      triggers: { crons: ['* * * * *'] },
      compatibility_flags: ['global_fetch_strictly_public'],
    }),
  );
  writeFileSync(
    new URL('ops/wrangler-mainnet.jsonc', root),
    JSON.stringify({
      name: 'fog-mainnet',
      main: 'src/worker.ts',
      compatibility_date: '2026-10-08',
      workers_dev: false,
      preview_urls: false,
      d1_databases: d1,
      vars: sharedVars,
      assets: { directory: '../web/dist', binding: 'ASSETS', run_worker_first: ['/api/*'] },
      services: [{ binding: 'MONITOR', service: 'fog-mainnet-monitor' }],
      ratelimits: [
        { name: 'RUM_LIMITER', namespace_id: '1001', simple: { limit: 12, period: 60 } },
      ],
    }),
  );
  assert.deepEqual(mainnetBlockers(root), []);
  assert.doesNotThrow(() => assertDeploymentConfig(root));
  mkdirSync(new URL('web/dist', root), { recursive: true });
  writeFileSync(new URL('web/dist/health.txt', root), 'fog:abc1234\n');
  const commands = [];
  const release = deploySite(['--network', 'mainnet'], {
    root,
    env: { CLOUDFLARE_ACCOUNT_ID: 'cf-acc' },
    exec: (cmd, args) => {
      commands.push([cmd, ...args]);
      return '';
    },
  });
  assert.equal(release, 'abc1234');
  assert.deepEqual(commands, [
    ['git', 'status', '--porcelain'],
    ['node', 'scripts/deployment-config.mjs'],
    ['node', 'scripts/build-site.mjs', '--network', 'mainnet'],
    [
      'wrangler',
      'deploy',
      '--config',
      'ops/wrangler-monitor-mainnet.jsonc',
      '--var',
      'RELEASE:abc1234',
    ],
    ['wrangler', 'deploy', '--config', 'ops/wrangler-mainnet.jsonc', '--var', 'RELEASE:abc1234'],
  ]);
  assert.throws(
    () =>
      deploySite(['--network', 'mainnet'], {
        root,
        env: { CLOUDFLARE_ACCOUNT_ID: 'cf-acc' },
        exec: (cmd) => (cmd === 'git' ? ' M README.md\n' : ''),
      }),
    /Commit source changes/,
  );

  // Partial OPERATOR configuration (OPERATOR UNDECIDED with concrete slot) fails assertDeploymentConfig.
  const siteCfg = JSON.parse(readFileSync(new URL('ops/wrangler-mainnet.jsonc', root), 'utf8'));
  const monitorCfg = JSON.parse(
    readFileSync(new URL('ops/wrangler-monitor-mainnet.jsonc', root), 'utf8'),
  );
  writeFileSync(
    new URL('ops/wrangler-mainnet.jsonc', root),
    JSON.stringify({
      ...siteCfg,
      vars: { ...siteCfg.vars, OPERATOR_BALANCE_SLOT: `0x${'1'.repeat(64)}` },
    }),
  );
  writeFileSync(
    new URL('ops/wrangler-monitor-mainnet.jsonc', root),
    JSON.stringify({
      ...monitorCfg,
      vars: { ...monitorCfg.vars, OPERATOR_BALANCE_SLOT: `0x${'1'.repeat(64)}` },
    }),
  );
  assert.throws(() => assertDeploymentConfig(root), /partial OPERATOR configuration/);

  // Mismatched REGISTRY and monitor service name are flagged by mainnetBlockers.
  writeFileSync(new URL('ops/wrangler-monitor-mainnet.jsonc', root), JSON.stringify(monitorCfg));
  writeFileSync(
    new URL('ops/wrangler-mainnet.jsonc', root),
    JSON.stringify({
      ...siteCfg,
      vars: { ...siteCfg.vars, REGISTRY: `0x${'0'.repeat(63)}9` },
      services: [{ binding: 'MONITOR', service: 'wrong-monitor' }],
    }),
  );
  const mismatchBlockers = mainnetBlockers(root);
  assert(mismatchBlockers.includes('site.REGISTRY mismatch'));
  assert(mismatchBlockers.includes('site.monitor service mismatch'));

  // Temporary workers.dev SITE_URL requires workers_dev: true and monitor requires global_fetch_strictly_public.
  const workersDomain = 'https://fog-mainnet.huantian233.workers.dev';
  writeFileSync(
    new URL('deployments/mainnet.json', root),
    JSON.stringify({ ...mainnetManifest, domain: workersDomain }, null, 2),
  );
  const workersVars = { ...sharedVars, SITE_URL: workersDomain };
  writeFileSync(
    new URL('ops/wrangler-mainnet.jsonc', root),
    JSON.stringify({ ...siteCfg, workers_dev: false, vars: workersVars }),
  );
  writeFileSync(
    new URL('ops/wrangler-monitor-mainnet.jsonc', root),
    JSON.stringify({ ...monitorCfg, vars: workersVars, compatibility_flags: [] }),
  );
  assert.throws(() => assertDeploymentConfig(root), /workers_dev must be true/);
  assert.throws(() => assertDeploymentConfig(root), /global_fetch_strictly_public/);
  writeFileSync(
    new URL('ops/wrangler-mainnet.jsonc', root),
    JSON.stringify({ ...siteCfg, workers_dev: true, vars: workersVars }),
  );
  writeFileSync(
    new URL('ops/wrangler-monitor-mainnet.jsonc', root),
    JSON.stringify({ ...monitorCfg, vars: workersVars }),
  );
  assert.deepEqual(mainnetBlockers(root), []);
  assert.doesNotThrow(() => assertDeploymentConfig(root));
});

test('buildSite strips VITE_ALLOW_V8_REHEARSAL_SUCCESSOR from inherited environment', (t) => {
  const { root } = fixture(t);
  const out = new URL('web/dist', root).pathname;
  mkdirSync(out, { recursive: true });
  const seenEnvs = [];
  const prior = process.env.VITE_ALLOW_V8_REHEARSAL_SUCCESSOR;
  process.env.VITE_ALLOW_V8_REHEARSAL_SUCCESSOR = 'true';
  try {
    buildSite(['--network', 'testnet-v6'], {
      root,
      exec: (command, args, opts) => {
        if (command === 'npm') seenEnvs.push(opts?.env);
        return command === 'git' ? (args[0] === 'rev-parse' ? 'abc123' : '') : '';
      },
      packageConsumer: () => {},
    });
  } finally {
    if (prior === undefined) delete process.env.VITE_ALLOW_V8_REHEARSAL_SUCCESSOR;
    else process.env.VITE_ALLOW_V8_REHEARSAL_SUCCESSOR = prior;
  }
  assert.equal(seenEnvs.length, 1);
  assert.equal('VITE_ALLOW_V8_REHEARSAL_SUCCESSOR' in seenEnvs[0], false);
});

test('template and readiness require reserved minLength to equal deployment minPublicLength', (t) => {
  const { root, update } = fixture(t, { unconfiguredMainnet: true });
  const template = JSON.parse(
    readFileSync(new URL('deployments/mainnet.template.json', root), 'utf8'),
  );
  writeFileSync(new URL('deployments/mainnet.json', root), JSON.stringify(template));
  const issue = 'reserved minLength must equal minPublicLength';
  assert(!mainnetBlockers(root).includes(issue));
  for (const minLength of [3, 6, 8, null]) {
    update('deployments/reserved-labels.json', (list) => {
      list.minLength = minLength;
    });
    assert(mainnetTemplateProblems(root).includes(issue), String(minLength));
    assert(mainnetBlockers(root).includes(issue), String(minLength));
  }
  update('deployments/reserved-labels.json', (list) => {
    list.minLength = 7;
  });
  assert(!mainnetTemplateProblems(root).includes(issue));
  assert(!mainnetBlockers(root).includes(issue));
});

test('mainnet rejects the published placeholder address even when its flag is false or absent', (t) => {
  const { root } = fixture(t);
  const admin = '0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68';
  for (const address of [admin, `0x${admin.slice(2).toUpperCase()}`]) {
    for (const flag of [{}, { adminPlaceholder: false }, { adminPlaceholder: true }]) {
      const manifest = { ...v6Canonical, network: 'mainnet', admin: address, ...flag };
      writeFileSync(new URL('deployments/mainnet.json', root), JSON.stringify(manifest));
      assert(mainnetBlockers(root).includes('admin placeholder'));
      assert(v6ManifestProblems(manifest).includes('admin placeholder'));
    }
  }
  writeFileSync(
    new URL('deployments/mainnet.json', root),
    JSON.stringify({ admin: v6Canonical.admin }),
  );
  assert(!mainnetBlockers(root).includes('admin placeholder'));
});
