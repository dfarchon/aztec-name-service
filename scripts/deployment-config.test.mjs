import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { assertDeploymentConfig, deploymentConfigMismatches } from './deployment-config.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ans-deployment-config-'));
  const root = pathToFileURL(`${directory}/`);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [
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
  const d = mkdtempSync(join(tmpdir(), 'ans-v6-sample-'));
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
