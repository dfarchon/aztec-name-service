import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { FeeJuicePortalAbi } from '@aztec-foundation/l1-artifacts/FeeJuicePortalAbi';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { computeSecretHash } from '@aztec-labs/stdlib/hash';
import { REPO } from './deploy-v6-plan.js';
import {
  MAINNET_FEE_JUICE_PORTAL,
  MAINNET_FEE_JUICE_TOKEN,
  MAINNET_ROLLUP,
  MAINNET_V8_ADMIN_STATE_SCHEMA,
  MAINNET_V8_BRIDGE_SCHEMA,
  buildMainnetV8Manifest,
  loadMainnetV8Credentials,
  mainnetReservedCallGroups,
  mainnetV8AdminConfirmation,
  mainnetV8BridgeConfirmation,
  mainnetV8LaunchConfirmation,
  parseMainnetV8Args,
  runMainnetV8Cli,
  stepAdmissionGasLimit,
} from './mainnet-v8-launch.js';

const { operatorSlotProblems } = createRequire(import.meta.url)(
  '../../scripts/operator-slot.mjs',
) as {
  operatorSlotProblems: (configs: Array<[string, { vars?: Record<string, string> }]>) => Promise<
    string[]
  >;
};
const { v6ManifestProblems } = createRequire(import.meta.url)(
  '../../scripts/deployment-config.mjs',
) as {
  v6ManifestProblems: (m: unknown, options?: { expectNetwork?: string }) => string[];
};

function mockMainnetNode(overrides: {
  l1ChainId?: number;
  feePerDaGas?: bigint;
  feePerL2Gas?: bigint;
  balance?: bigint;
} = {}) {
  const calls: string[] = [];
  const node = {
    getNodeInfo: async () => {
      calls.push('getNodeInfo');
      return {
        nodeVersion: '6.0.0',
        l1ChainId: overrides.l1ChainId ?? 1,
        rollupVersion: 2070860440,
        realProofs: true,
        l1ContractAddresses: {
          rollupAddress: MAINNET_ROLLUP,
          feeJuicePortalAddress: MAINNET_FEE_JUICE_PORTAL,
          feeJuiceAddress: MAINNET_FEE_JUICE_TOKEN,
        },
      };
    },
    getCurrentMinFees: async () => {
      calls.push('getCurrentMinFees');
      return {
        feePerDaGas: overrides.feePerDaGas ?? 0n,
        feePerL2Gas: overrides.feePerL2Gas ?? 2_292_722_339_404n,
      };
    },
    getContractClass: async () => {
      calls.push('getContractClass');
      return undefined;
    },
    getPublicStorageAt: async () => {
      calls.push('getPublicStorageAt');
      return new Fr(overrides.balance ?? 180n * 10n ** 18n);
    },
  };
  return { node, calls };
}

test('mainnet V8 offline account generator enforces signer isolation and precomputes operator slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mainnet-signer-test-'));
  await chmod(root, 0o700);
  const savedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /(?:NODE|RPC|ANVIL).*URL/i.test(k)),
  );
  for (const k of Object.keys(savedEnv)) delete process.env[k];

  try {
    for (const signerName of ['fog-signer', 'ans-signer']) {
      const stateDir = join(root, `mainnet-v8-launch-20261119-${signerName.slice(0, 3)}`);
      const fakeSigner = { uid: process.getuid!(), username: signerName, signerRoot: root };
      const out = (await runMainnetV8Cli(
        ['--init-accounts', '--state-dir', stateDir],
        {
          signerIdentity: () => fakeSigner,
          createNode: () => assert.fail('network forbidden in --init-accounts'),
          createL1: () => assert.fail('L1 forbidden in --init-accounts'),
        },
      )) as { status: string };
      assert.equal(out.status, 'ACCOUNTS_INITIALIZED');
      assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(stateDir, 'credentials.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(join(stateDir, 'public.json'))).mode & 0o777, 0o600);

      const publicRaw = await readFile(join(stateDir, 'public.json'), 'utf8');
      assert(!/secret|signingKey|privateKey|salts/i.test(publicRaw));
      assert(!/secret|signingKey|privateKey/i.test(JSON.stringify(out)));

      const publicAccounts = JSON.parse(publicRaw);
      const creds = await loadMainnetV8Credentials(stateDir, publicAccounts, fakeSigner);
      assert.equal(creds.admin.address, publicAccounts.admin);
      assert.deepEqual(
        await operatorSlotProblems([
          [
            'mainnet',
            {
              vars: {
                OPERATOR: publicAccounts.admin,
                OPERATOR_BALANCE_SLOT: publicAccounts.operatorBalanceSlot,
              },
            },
          ],
        ]),
        [],
      );
    }

    // Reject root, shared grokbot user, non-dated directory, and RPC env vars.
    await assert.rejects(
      runMainnetV8Cli(
        ['--init-accounts', '--state-dir', join(root, 'mainnet-v8-launch-20261119-root')],
        {
          signerIdentity: () => ({ uid: 0, username: 'fog-signer', signerRoot: root }),
          createNode: () => assert.fail(),
          createL1: () => assert.fail(),
        },
      ),
      /uid 0/,
    );
    await assert.rejects(
      runMainnetV8Cli(
        ['--init-accounts', '--state-dir', join(root, 'mainnet-v8-launch-20261119-bot')],
        {
          signerIdentity: () => ({ uid: process.getuid!(), username: 'grokbot', signerRoot: root }),
          createNode: () => assert.fail(),
          createL1: () => assert.fail(),
        },
      ),
      /Mainnet signer requires dedicated Linux user/,
    );
    await assert.rejects(
      runMainnetV8Cli(['--init-accounts', '--state-dir', join(root, 'bad-name')], {
        signerIdentity: () => ({ uid: process.getuid!(), username: 'fog-signer', signerRoot: root }),
        createNode: () => assert.fail(),
        createL1: () => assert.fail(),
      }),
      /Dated mainnet-v8-launch-YYYYMMDD/,
    );
    process.env.RPC_URL = 'https://aztec-mainnet.drpc.org';
    await assert.rejects(
      runMainnetV8Cli(
        ['--init-accounts', '--state-dir', join(root, 'mainnet-v8-launch-20261119-env')],
        {
          signerIdentity: () => ({
            uid: process.getuid!(),
            username: 'fog-signer',
            signerRoot: root,
          }),
          createNode: () => assert.fail(),
          createL1: () => assert.fail(),
        },
      ),
      /Offline account generator refuses/,
    );
  } finally {
    delete process.env.RPC_URL;
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('mainnet V8 dry-run preflight never opens credentials, guards DA/L2 fees and builds valid manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mainnet-dryrun-test-'));
  await chmod(root, 0o700);
  const savedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /(?:NODE|RPC|ANVIL).*URL/i.test(k)),
  );
  for (const k of Object.keys(savedEnv)) delete process.env[k];

  try {
    const stateDir = join(root, 'mainnet-v8-launch-20261119');
    const fakeSigner = { uid: process.getuid!(), username: 'ans-signer', signerRoot: root };
    await runMainnetV8Cli(['--init-accounts', '--state-dir', stateDir], {
      signerIdentity: () => fakeSigner,
      createNode: () => assert.fail(),
      createL1: () => assert.fail(),
    });
    // Remove read permission from credentials.json during dry-run to prove it is untouched.
    await chmod(join(stateDir, 'credentials.json'), 0o000);

    const manifestOut = join(root, 'out/mainnet.json');
    const { node, calls } = mockMainnetNode();
    const preview = (await runMainnetV8Cli(
      [
        '--state-dir',
        stateDir,
        '--node-url',
        'https://aztec-mainnet.drpc.org',
        '--domain',
        'fog.example',
        '--manifest-out',
        manifestOut,
        '--max-fee-juice',
        '180',
        '--dry-run',
      ],
      {
        signerIdentity: () => assert.fail('dry-run must not inspect signer identity'),
        createNode: () => node as never,
        createL1: () => assert.fail('deploy dry-run must not call L1'),
      },
    )) as {
      confirm: string;
      domain: string;
      reservedLabels: { count: number; batches: number; calls: number };
      estimatedCost: { estimatedDeployL2Gas: string; recommendedMinFundingFJ: string };
    };

    const publicAccounts = JSON.parse(await readFile(join(stateDir, 'public.json'), 'utf8'));
    assert.equal(preview.domain, 'https://fog.example');
    assert.deepEqual(
      {
        count: preview.reservedLabels.count,
        batches: preview.reservedLabels.batches,
        calls: preview.reservedLabels.calls,
      },
      { count: 325, batches: 6, calls: 11 },
    );
    assert.equal(preview.estimatedCost.estimatedDeployL2Gas, '19913000');
    assert(/^[1-9][0-9]*$/.test(preview.estimatedCost.recommendedMinFundingFJ));
    assert.equal(
      preview.confirm,
      mainnetV8LaunchConfirmation(publicAccounts, {
        domain: 'https://fog.example',
        maxFeeJuiceWei: 180n * 10n ** 18n,
      }),
    );
    assert(calls.includes('getNodeInfo') && calls.includes('getCurrentMinFees'));

    // Bridge dry-run verifies L1 chain 1 + bytecode + balances without opening credentials.json.
    const bridgePreview = (await runMainnetV8Cli(
      [
        '--bridge',
        '--state-dir',
        stateDir,
        '--node-url',
        'https://aztec-mainnet.drpc.org',
        '--l1-rpc-url',
        'https://eth.llamarpc.com',
        '--amount-fj',
        '180',
        '--dry-run',
      ],
      {
        signerIdentity: () => assert.fail('bridge dry-run must not inspect signer identity'),
        createNode: () => node as never,
        createL1: () =>
          ({
            getChainId: async () => 1,
            getCode: async () => '0x60016000',
            getBalance: async () => 20_000_000_000_000_000n,
            readContract: async () => 200n * 10n ** 18n,
          }) as never,
      },
    )) as { confirm: string; sufficientL1Aztec: boolean };
    assert.equal(bridgePreview.sufficientL1Aztec, true);
    assert.equal(
      bridgePreview.confirm,
      mainnetV8BridgeConfirmation(publicAccounts, 180n * 10n ** 18n),
    );

    // Nonzero DA fee or excessive L2 fee stops preflight.
    await assert.rejects(
      runMainnetV8Cli(
        [
          '--state-dir',
          stateDir,
          '--node-url',
          'https://aztec-mainnet.drpc.org',
          '--domain',
          'https://fog.example',
          '--manifest-out',
          manifestOut,
        ],
        {
          signerIdentity: () => fakeSigner,
          createNode: () => mockMainnetNode({ feePerDaGas: 1n }).node as never,
          createL1: () => assert.fail(),
        },
      ),
      /DA fee changed from zero/,
    );
    await assert.rejects(
      runMainnetV8Cli(
        [
          '--state-dir',
          stateDir,
          '--node-url',
          'https://aztec-mainnet.drpc.org',
          '--domain',
          'https://fog.example',
          '--manifest-out',
          manifestOut,
          '--max-l2-fee-per-gas',
          '1000',
        ],
        {
          signerIdentity: () => fakeSigner,
          createNode: () => node as never,
          createL1: () => assert.fail(),
        },
      ),
      /exceeds ceiling/,
    );

    // --send with wrong confirmation fails closed before opening credentials.json (still mode 0000!).
    await assert.rejects(
      runMainnetV8Cli(
        [
          '--state-dir',
          stateDir,
          '--node-url',
          'https://aztec-mainnet.drpc.org',
          '--domain',
          'https://fog.example',
          '--manifest-out',
          manifestOut,
          '--send',
          '--confirm',
          'wrong-confirm',
        ],
        {
          signerIdentity: () => assert.fail('wrong confirm must fail before signer load'),
          createNode: () => node as never,
          createL1: () => assert.fail(),
        },
      ),
      /Exact --confirm required/,
    );

    // Generated manifest passes canonical mainnet validation with zero problems.
    const tx = `0x${'a'.repeat(64)}`;
    const manifest = buildMainnetV8Manifest({
      accounts: publicAccounts,
      nodeUrl: 'https://aztec-mainnet.drpc.org',
      domain: 'https://fog.example',
      transactions: {
        'deploy-registry': tx,
        'deploy-resolver': tx,
        'deploy-registrar': tx,
        ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`seed-reserved-${i}`, tx])),
        bootstrap: tx,
      },
      deployedAt: '2026-11-19T00:00:00.000Z',
    });
    assert.deepEqual(v6ManifestProblems(manifest, { expectNetwork: 'mainnet' }), []);

    // Argument guards: --manifest-out inside deployments/ or overwriting state.json is rejected.
    assert.throws(
      () =>
        parseMainnetV8Args([
          '--state-dir',
          stateDir,
          '--node-url',
          'https://aztec-mainnet.drpc.org',
          '--domain',
          'https://fog.example',
          '--manifest-out',
          join(REPO, 'deployments/mainnet.json'),
        ]),
      /outside deployments/,
    );
    assert.throws(
      () =>
        parseMainnetV8Args([
          '--state-dir',
          stateDir,
          '--node-url',
          'https://aztec-mainnet.drpc.org',
          '--domain',
          'https://fog.example',
          '--manifest-out',
          join(stateDir, 'state.json'),
        ]),
      /overwrite private state/,
    );

    // Admin action parsing and confirmation binding.
    const mintParsed = parseMainnetV8Args([
      '--admin-action',
      'mint',
      '--label',
      'Fog.fog',
      '--recipient',
      publicAccounts.admin,
      '--state-dir',
      stateDir,
      '--node-url',
      'https://aztec-mainnet.drpc.org',
    ]);
    assert.equal(mintParsed.mode, 'admin');
    assert.deepEqual(mintParsed.action, {
      kind: 'mint',
      label: 'fog',
      recipient: publicAccounts.admin.toLowerCase(),
    });
    assert.match(
      mainnetV8AdminConfirmation(publicAccounts, mintParsed.action),
      /:mint:fog:0x/,
    );
  } finally {
    Object.assign(process.env, savedEnv);
    await chmod(join(root, 'mainnet-v8-launch-20261119/credentials.json'), 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('parseMainnetV8Args rejects mode-inappropriate flags across bridge, deploy and admin modes', () => {
  const stateDir = '/var/lib/ans-signer/mainnet-v8-launch-20261119';
  const nodeUrl = 'https://aztec-mainnet.drpc.org';
  const l1Rpc = 'https://eth.llamarpc.com';
  const adminAddr = `0x${'1'.repeat(64)}`;

  for (const args of [
    ['--bridge', '--state-dir', stateDir, '--node-url', nodeUrl, '--l1-rpc-url', l1Rpc, '--amount-fj', '10', '--domain', 'https://fog.example'],
    ['--bridge', '--state-dir', stateDir, '--node-url', nodeUrl, '--l1-rpc-url', l1Rpc, '--amount-fj', '10', '--manifest-out', '/tmp/m.json'],
    ['--state-dir', stateDir, '--node-url', nodeUrl, '--domain', 'https://fog.example', '--manifest-out', '/tmp/m.json', '--amount-fj', '10'],
    ['--state-dir', stateDir, '--node-url', nodeUrl, '--domain', 'https://fog.example', '--manifest-out', '/tmp/m.json', '--l1-rpc-url', l1Rpc],
    ['--admin-action', 'unpause', '--state-dir', stateDir, '--node-url', nodeUrl, '--length', '7'],
    ['--admin-action', 'pause', '--state-dir', stateDir, '--node-url', nodeUrl, '--label', 'alice'],
    ['--admin-action', 'pause', '--state-dir', stateDir, '--node-url', nodeUrl, '--recipient', adminAddr],
    ['--admin-action', 'unpause', '--state-dir', stateDir, '--node-url', nodeUrl, '--l1-rpc-url', l1Rpc],
  ]) {
    assert.throws(() => parseMainnetV8Args(args), /refuses/);
  }
});

test('runMainnetBridge recovers saved l1-deposit receipt when post-deposit L1 balance is zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mainnet-bridge-resume-'));
  await chmod(root, 0o700);
  const savedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /(?:NODE|RPC|ANVIL).*URL/i.test(k)),
  );
  for (const k of Object.keys(savedEnv)) delete process.env[k];

  try {
    const stateDir = join(root, 'mainnet-v8-launch-20261119');
    const fakeSigner = { uid: process.getuid!(), username: 'ans-signer', signerRoot: root };
    await runMainnetV8Cli(['--init-accounts', '--state-dir', stateDir], {
      signerIdentity: () => fakeSigner,
      createNode: () => assert.fail(),
      createL1: () => assert.fail(),
    });
    const publicAccounts = JSON.parse(await readFile(join(stateDir, 'public.json'), 'utf8'));
    const amountWei = 180n * 10n ** 18n;
    const confirm = mainnetV8BridgeConfirmation(publicAccounts, amountWei);
    const claimSecret = Fr.random();
    const claimSecretHash = (await computeSecretHash(claimSecret)).toString() as Hex;
    const approveHash = `0x${'a'.repeat(64)}` as Hex;
    const depositHash = `0x${'b'.repeat(64)}` as Hex;
    const messageKey = `0x${'c'.repeat(64)}` as Hex;

    await writeFile(
      join(stateDir, 'bridge-state.json'),
      JSON.stringify({
        schema: MAINNET_V8_BRIDGE_SCHEMA,
        confirmation: confirm,
        recipient: publicAccounts.admin,
        l1Address: publicAccounts.l1FundingAddress,
        amountWei: String(amountWei),
        claimSecret: claimSecret.toString(),
        claimSecretHash,
        l1Transactions: {
          'l1-approve': approveHash,
          'l1-deposit': depositHash,
        },
        l1Done: ['l1-approve'],
        l1FeesWei: { 'l1-approve': '1000' },
        observations: {},
        provenObservations: 0,
      }),
      { mode: 0o600 },
    );

    const topics = encodeEventTopics({
      abi: FeeJuicePortalAbi,
      eventName: 'DepositToAztecPublic',
      args: { to: publicAccounts.admin as Hex },
    });
    const data = encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
      ],
      [amountWei, claimSecretHash, messageKey, 42n],
    );

    const { node } = mockMainnetNode({ balance: 0n });
    const out = (await runMainnetV8Cli(
      [
        '--bridge',
        '--state-dir',
        stateDir,
        '--node-url',
        'https://aztec-mainnet.drpc.org',
        '--l1-rpc-url',
        'https://eth.llamarpc.com',
        '--amount-fj',
        '180',
        '--send',
        '--confirm',
        confirm,
      ],
      {
        signerIdentity: () => fakeSigner,
        createNode: () => node as never,
        createL1: () =>
          ({
            getChainId: async () => 1,
            getCode: async () => '0x60016000',
            getBalance: async () => 0n,
            readContract: async () => 0n,
            getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
              assert.equal(hash, depositHash);
              return {
                status: 'success',
                gasUsed: 100_000n,
                effectiveGasPrice: 10n ** 9n,
                logs: [{ address: MAINNET_FEE_JUICE_PORTAL, topics, data }],
              };
            },
            estimateContractGas: async () => assert.fail('must not re-estimate on resume'),
            waitForTransactionReceipt: async () => assert.fail('must not wait for new tx on resume'),
          }) as never,
      },
    )) as { depositTx: string; messageHash: string; leafIndex: string };

    assert.equal(out.depositTx, depositHash);
    assert.equal(out.messageHash, messageKey);
    assert.equal(out.leafIndex, '42');
    const updated = JSON.parse(await readFile(join(stateDir, 'bridge-state.json'), 'utf8'));
    assert(updated.l1Done.includes('l1-deposit'));
    assert.equal(updated.observations['l1-deposit'], 1);
  } finally {
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('admin-actions.json blocks concurrent unfinished action and allows repeated unpause cycles after completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mainnet-admin-lifecycle-'));
  await chmod(root, 0o700);
  const savedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /(?:NODE|RPC|ANVIL).*URL/i.test(k)),
  );
  for (const k of Object.keys(savedEnv)) delete process.env[k];

  try {
    const stateDir = join(root, 'mainnet-v8-launch-20261119');
    const fakeSigner = { uid: process.getuid!(), username: 'ans-signer', signerRoot: root };
    await runMainnetV8Cli(['--init-accounts', '--state-dir', stateDir], {
      signerIdentity: () => fakeSigner,
      createNode: () => assert.fail(),
      createL1: () => assert.fail(),
    });
    const publicAccounts = JSON.parse(await readFile(join(stateDir, 'public.json'), 'utf8'));
    const unpauseConfirm = mainnetV8AdminConfirmation(publicAccounts, { kind: 'unpause' });
    const pauseConfirm = mainnetV8AdminConfirmation(publicAccounts, { kind: 'pause' });

    let pausedState = true;
    let pendingPauseTarget: boolean | undefined;
    let txSeq = 0;
    const { node: baseNode } = mockMainnetNode();
    const rawNode = {
      ...baseNode,
      sendTx: async () => {},
      getTxReceipt: async () => ({
        hasExecutionSucceeded: () => true,
        transactionFee: 1_000_000n,
      }),
    };
    const fakeReader = {
      registry: AztecAddress.fromStringUnsafe(publicAccounts.addresses.registry),
      deployment: { chainId: 1n },
      snapshot: async () => ({ blockNumber: 1, blockHash: '0x1', timestamp: 1_800_000_000n, finality: 'confirmed' }),
      getAdministrator: async () => AztecAddress.fromStringUnsafe(publicAccounts.admin),
      getConfig: async () => ({
        feeToken: AztecAddress.ZERO,
        treasury: AztecAddress.ZERO,
        annualPrice: 0n,
        priceVersion: 1,
        registrar: AztecAddress.fromStringUnsafe(publicAccounts.addresses.registrar),
        launch: { paused: pausedState, minPublicLength: 7, maxRenewAhead: 31_536_000n },
      }),
      getName: async () => ({ generation: 0 }),
      getCommit: async () => ({ committedAt: 0n }),
    };

    // An unfinished active action blocks starting a different action before wallet creation.
    await writeFile(
      join(stateDir, 'admin-actions.json'),
      JSON.stringify({
        schema: MAINNET_V8_ADMIN_STATE_SCHEMA,
        active: {
          confirmation: pauseConfirm,
          action: { kind: 'pause' },
          txHashes: {},
          done: [],
          l2FeesWei: {},
          observations: {},
        },
        completed: [],
      }),
      { mode: 0o600 },
    );

    await assert.rejects(
      runMainnetV8Cli(
        [
          '--admin-action',
          'unpause',
          '--state-dir',
          stateDir,
          '--node-url',
          'https://aztec-mainnet.drpc.org',
          '--send',
          '--confirm',
          unpauseConfirm,
        ],
        {
          signerIdentity: () => fakeSigner,
          createNode: () => rawNode as never,
          createL1: () => assert.fail(),
          connectReader: async () => fakeReader as never,
          createWallet: async () => assert.fail('must refuse before wallet creation'),
        },
      ),
      /Unfinished admin action in progress/,
    );

    // Clear active to run unpause -> pause -> unpause cleanly.
    await writeFile(
      join(stateDir, 'admin-actions.json'),
      JSON.stringify({ schema: MAINNET_V8_ADMIN_STATE_SCHEMA, active: null, completed: [] }),
      { mode: 0o600 },
    );

    let capturedProxyNode: { sendTx: (tx: unknown) => Promise<void> } | undefined;
    const deps = {
      signerIdentity: () => fakeSigner,
      createNode: () => rawNode as never,
      createL1: () => assert.fail(),
      connectReader: async () => fakeReader as never,
      createWallet: async (n: unknown) => {
        capturedProxyNode = n as { sendTx: (tx: unknown) => Promise<void> };
        return {
          createSchnorrInitializerlessAccount: async () => ({
            address: AztecAddress.fromStringUnsafe(publicAccounts.admin),
          }),
          registerContract: async () => {},
          stop: async () => {},
        } as never;
      },
      launchContractAt: () =>
        ({
          methods: {
            set_paused: (paused: boolean) => ({
              send: async () => {
                pendingPauseTarget = paused;
                const hash = new Fr(BigInt(++txSeq));
                await capturedProxyNode!.sendTx({ getTxHash: async () => hash });
              },
            }),
          },
        }) as never,
      trackTx: async (_node: unknown, txHash: string) => {
        if (pendingPauseTarget !== undefined) {
          pausedState = pendingPauseTarget;
          pendingPauseTarget = undefined;
        }
        return { txHash, state: 'confirmed' as const };
      },
    };

    for (const [stepIdx, [kind, confirm, expectedPaused]] of (
      [
        ['unpause', unpauseConfirm, false],
        ['pause', pauseConfirm, true],
        ['unpause', unpauseConfirm, false],
      ] as const
    ).entries()) {
      const res = (await runMainnetV8Cli(
        [
          '--admin-action',
          kind,
          '--state-dir',
          stateDir,
          '--node-url',
          'https://aztec-mainnet.drpc.org',
          '--send',
          '--confirm',
          confirm,
        ],
        deps,
      )) as { paused: boolean };
      assert.equal(res.paused, expectedPaused);
      const history = JSON.parse(await readFile(join(stateDir, 'admin-actions.json'), 'utf8'));
      assert.equal(history.active, null);
      assert.equal(history.completed.length, stepIdx + 1);
    }
    assert.equal(txSeq, 3);
  } finally {
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  }
});

test('mainnetReservedCallGroups packs 325 nodes into 6 safe Batched transactions and pre-prove admission guard blocks underfunded send', async () => {
  const nodes = Array.from({ length: 325 }, (_, i) => BigInt(i + 1));
  const groups = mainnetReservedCallGroups(nodes);
  assert.equal(groups.length, 6);
  for (let i = 0; i < 5; i++) {
    assert.equal(groups[i]!.length, 2);
    assert.equal(groups[i]![0]!.length, 32);
    assert.equal(groups[i]![1]!.length, 32);
    assert.equal(
      groups[i]!.flat().filter((n) => n !== 0n).length,
      60,
    );
  }
  assert.equal(groups[5]!.length, 1);
  assert.equal(groups[5]![0]!.length, 32);
  assert.equal(
    groups[5]![0]!.filter((n) => n !== 0n).length,
    25,
  );
  assert.deepEqual(
    groups.flat(2).filter((n) => n !== 0n),
    nodes,
  );
  assert.throws(() => mainnetReservedCallGroups(nodes, 63), /1 and 62/);
  assert.throws(() => mainnetReservedCallGroups(nodes, 0), /1 and 62/);
  assert.equal(stepAdmissionGasLimit('seed-reserved-0'), 3_300_000n);
  assert.equal(stepAdmissionGasLimit('deploy-registry'), 2_200_000n);
  assert.equal(stepAdmissionGasLimit('unpause'), 1_200_000n);

  const root = await mkdtemp(join(tmpdir(), 'mainnet-underfunded-guard-'));
  await chmod(root, 0o700);
  const savedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /(?:NODE|RPC|ANVIL).*URL/i.test(k)),
  );
  for (const k of Object.keys(savedEnv)) delete process.env[k];
  try {
    const stateDir = join(root, 'mainnet-v8-launch-20261119');
    const fakeSigner = { uid: process.getuid!(), username: 'ans-signer', signerRoot: root };
    await runMainnetV8Cli(['--init-accounts', '--state-dir', stateDir], {
      signerIdentity: () => fakeSigner,
      createNode: () => assert.fail(),
      createL1: () => assert.fail(),
    });
    const publicAccounts = JSON.parse(await readFile(join(stateDir, 'public.json'), 'utf8'));
    const unpauseConfirm = mainnetV8AdminConfirmation(publicAccounts, { kind: 'unpause' });
    const { node: lowBalNode } = mockMainnetNode({ balance: 1n * 10n ** 18n });
    const fakeReader = {
      registry: AztecAddress.fromStringUnsafe(publicAccounts.addresses.registry),
      deployment: { chainId: 1n },
      snapshot: async () => ({
        blockNumber: 1,
        blockHash: '0x1',
        timestamp: 1_800_000_000n,
        finality: 'confirmed',
      }),
      getAdministrator: async () => AztecAddress.fromStringUnsafe(publicAccounts.admin),
      getConfig: async () => ({
        feeToken: AztecAddress.ZERO,
        treasury: AztecAddress.ZERO,
        annualPrice: 0n,
        priceVersion: 1,
        registrar: AztecAddress.fromStringUnsafe(publicAccounts.addresses.registrar),
        launch: { paused: true, minPublicLength: 7, maxRenewAhead: 31_536_000n },
      }),
    };
    await assert.rejects(
      runMainnetV8Cli(
        [
          '--admin-action',
          'unpause',
          '--state-dir',
          stateDir,
          '--node-url',
          'https://aztec-mainnet.drpc.org',
          '--send',
          '--confirm',
          unpauseConfirm,
        ],
        {
          signerIdentity: () => fakeSigner,
          createNode: () => lowBalNode as never,
          createL1: () => assert.fail(),
          connectReader: async () => fakeReader as never,
          createWallet: async () => assert.fail('underfunded guard must fire before wallet/proving'),
        },
      ),
      /Insufficient Fee Juice for admin action unpause mempool admission/,
    );
    await assert.rejects(stat(join(stateDir, 'admin-actions.json')), /ENOENT/);
  } finally {
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  }
});
