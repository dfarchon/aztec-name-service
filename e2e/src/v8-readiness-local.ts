/** Local loopback node integration for V8 readiness adapters and Schnorr initializerless parity. */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { publishContractClass } from '@aztec-labs/aztec.js/deployment';
import { NameRegistryV8Contract, NameRegistryV8RehearsalContract } from '@fog/sdk/contracts/v8';
import {
  FogContext,
  CORE_UPGRADE_FAMILY,
  RegistryReader,
  administerCoreUpgrade,
} from '@fog/sdk';
import { NameRegistrarLaunchContract, NameResolverContract } from '@fog/sdk/contracts';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import { sponsoredFpc } from './common.js';
import { assertV8DeploymentOwner, v8BoundDeployment } from './v8-deployment.js';
import { writeDeterministicFixtures } from './v8-fixture-generator.js';
import { LocalPinnedAdapters } from './v8-real-adapters.js';
import { MockJournal, digest, type Binding } from './v8-safe-operator.js';

const nodeUrl = process.env.NODE_URL ?? 'http://127.0.0.1:8082';
const l1Url = process.env.ANVIL_URL ?? 'http://127.0.0.1:8547';

// writeDeterministicFixtures refuses NODE_URL / ANVIL_URL in process.env to stay offline-only.
const savedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => /(?:NODE|RPC|ANVIL).*URL/i.test(k)),
);
for (const key of Object.keys(savedEnv)) delete process.env[key];

const scratch = await mkdtemp(join(tmpdir(), 'fog-v8-readiness-local-'));
await chmod(scratch, 0o700);
const fixtureDir = join(scratch, 'fixtures');
const journalDir = join(scratch, 'journal');

type FixtureFile = {
  actors: { role: string; secret: string; salt: string; signingKey: string; address: string }[];
  fundingFixture: `0x${string}`;
};

try {
  await writeDeterministicFixtures(fixtureDir);
  Object.assign(process.env, savedEnv);

  const fixtures = JSON.parse(
    await readFile(join(fixtureDir, 'TEST-ONLY.json'), 'utf8'),
  ) as FixtureFile;
  const [actorA, actorB, actorC] = fixtures.actors;
  assert(actorA && actorB && actorC);

  const node = createAztecNodeClient(nodeUrl);
  const info = await node.getNodeInfo();
  assert.equal(info.realProofs, false);
  assert.equal(Number(info.l1ChainId), 31337);

  const A = Fr.fromString(metadata.v8.classId);
  const B = Fr.fromString(metadata.v8Rehearsal.classId);
  const binding: Binding = {
    schema: 'fog-v8-safe-prep/1',
    run: 'v8-readiness-local',
    identity: {
      chainId: 31337,
      rollupVersion: info.rollupVersion,
      realProofs: false,
      nodeVersion: '6.0.0',
      classes: [A.toString(), B.toString()],
      codeHashes: [digest('local-loopback-only')],
    },
    actors: {
      owner: actorA.address,
      administrator: actorA.address,
      treasury: actorA.address,
      holder: actorB.address,
      recipient: actorC.address,
    },
    artifacts: { metadata: digest(metadata) },
    reservations: {
      count: 325,
      hash: '743b1b4c3ab4762cb2d12662765406fdf91971845a5ec6137b1f7444223657fa',
      batches: 11,
    },
    edges: [
      [A.toString(), B.toString()],
      [B.toString(), A.toString()],
    ],
    configHash: digest('v8-readiness-local'),
  };

  const adapter = await LocalPinnedAdapters.connect(nodeUrl, l1Url, binding);
  await mkdir(journalDir, { mode: 0o700 });
  let journal = await MockJournal.acquire(journalDir, binding);
  const reopen = async () => {
    await journal.close();
    journal = await MockJournal.acquire(journalDir, binding);
  };

  try {
    const l1 = createPublicClient({
      chain: foundry,
      transport: http(l1Url, { retryCount: 0 }),
    });
    const signer = privateKeyToAccount(fixtures.fundingFixture);
    await l1.request({
      method: 'anvil_setBalance' as never,
      params: [signer.address, '0x56bc75e2d63100000'] as never,
    });
    const l1Hash = await adapter.l1Step(journal, 'L1-local-transfer', {
      type: 'legacy',
      chainId: 31337,
      nonce: await l1.getTransactionCount({ address: signer.address }),
      gasPrice: await l1.getGasPrice(),
      gas: 21000n,
      to: signer.address,
      value: 0n,
    });
    assert(typeof l1Hash === 'string');
    await l1.waitForTransactionReceipt({ hash: l1Hash });
    await reopen();
    await adapter.l1Step(
      journal,
      'L1-local-transfer',
      new Proxy({} as never, {
        get() {
          assert.fail('resume inspected replacement transaction');
        },
      }),
    );
    assert.equal(journal.latest()?.phase, 'confirmed');
    assert.equal(journal.trackAttempts('L1-local-transfer'), 1);
    await reopen();
    await adapter.l1Step(journal, 'L1-local-transfer', {} as never);
    assert.equal(journal.trackAttempts('L1-local-transfer'), 2);

    const wallet = await adapter.wallet();
    const createdAccounts = await Promise.all(
      [actorA, actorB, actorC].map(async (entry) => ({
        role: entry.role,
        expected: entry.address,
        account: await wallet.createSchnorrInitializerlessAccount(
          Fr.fromString(entry.secret),
          Fr.fromString(entry.salt),
          Fq.fromString(entry.signingKey),
        ),
      })),
    );
    for (const item of createdAccounts) {
      assert.equal(
        item.account.address.toString(),
        item.expected,
        `Initializerless Schnorr address mismatch for actor ${item.role}`,
      );
    }
    const owner = createdAccounts[0]!.account.address;

    const fpc = await sponsoredFpc();
    await wallet.registerContract(fpc.instance, fpc.artifact);
    const opts = { from: owner, fee: fpc.fee.fee };

    let sdkSends = 0;
    const step = async <T>(
      label: string,
      run: () => Promise<T>,
      readback: () => Promise<void> = async () => {},
    ) => {
      const result = await adapter.aztecStep(
        journal,
        label,
        async () => {
          sdkSends++;
          return run();
        },
        readback,
      );
      await reopen();
      await adapter.aztecStep(
        journal,
        label,
        async () => {
          assert.fail('reopen replay');
        },
        readback,
      );
      assert.equal(journal.latest()?.phase, 'confirmed');
      const checkpoint = journal.latest()!;
      const receipt = JSON.parse(checkpoint.outcome!) as {
        timestamp?: string;
        blockHash?: string;
        status?: string;
      };
      assert.notEqual(receipt.timestamp, undefined);
      assert(receipt.blockHash);
      assert.equal(journal.trackAttempts(label), 1);
      assert(adapter.lastSerialization && adapter.lastSerialization.bytes > 0);
      await reopen();
      await adapter.aztecStep(
        journal,
        label,
        async () => {
          assert.fail('confirmed replay');
        },
        readback,
      );
      assert.equal(journal.trackAttempts(label), 2);
      return result as T;
    };

    const { contract: core } = await step('deploy-v8', () =>
      NameRegistryV8Contract.deploy(wallet, AztecAddress.ZERO, A, v8BoundDeployment(owner)).send(
        opts,
      ),
    );
    const reader = await RegistryReader.connect(node, core.address, {
      allowRehearsalSuccessor: true,
    });
    const deployedInstance = await node.getContract(core.address);
    assert(deployedInstance);
    assertV8DeploymentOwner(owner, deployedInstance.deployer, await reader.getAdministrator());

    const { contract: resolver } = await step('deploy-resolver', () =>
      NameResolverContract.deploy(wallet, core.address).send(opts),
    );
    const { contract: launch } = await step('deploy-registrar', () =>
      NameRegistrarLaunchContract.deploy(
        wallet,
        core.address,
        AztecAddress.ZERO,
        owner,
        0n,
        0n,
        0n,
        1,
        7,
        true,
        31536000n,
      ).send(opts),
    );
    await step(
      'bootstrap',
      () => core.methods.bootstrap(launch.address, resolver.address).send(opts),
      async () => {
        const modules = await reader.getModules();
        assert(modules.registrar.equals(launch.address));
        assert(modules.resolver.equals(resolver.address));
      },
    );

    await step('publish-successor', async () =>
      (await publishContractClass(wallet, NameRegistryV8RehearsalContract.artifact)).send(opts),
    );

    const adminCtx = new FogContext(reader, { wallet, account: owner, fee: fpc.fee.fee });
    const adminAction = async (
      label: string,
      build: (expectedNonce: bigint) => Parameters<typeof administerCoreUpgrade>[1],
      readback: () => Promise<void> = async () => {},
    ) =>
      step(
        label,
        async () => {
          const state = await reader.getCoreUpgradeState();
          return administerCoreUpgrade(adminCtx, build(state.nonce));
        },
        readback,
      );

    await adminAction('approve-release', (expectedNonce) => ({
      kind: 'approve_release',
      expectedNonce,
      classId: B.toBigInt(),
      family: CORE_UPGRADE_FAMILY,
      releaseSeq: 2,
    }));
    await adminAction('approve-edge', (expectedNonce) => ({
      kind: 'approve_edge_pair',
      expectedNonce,
      older: A.toBigInt(),
      newer: B.toBigInt(),
    }));
    await adminAction(
      'propose',
      (expectedNonce) => ({
        kind: 'propose',
        expectedNonce,
        from: A.toBigInt(),
        to: B.toBigInt(),
      }),
      async () => {
        const current = await reader.getCoreUpgradeState();
        assert.equal(current.pending.active, true);
        assert.equal(current.pending.to, B.toBigInt());
      },
    );
    await adminAction(
      'cancel-proposal',
      (expectedNonce) => ({
        kind: 'cancel_proposal',
        expectedNonce,
      }),
      async () => {
        const current = await reader.getCoreUpgradeState();
        assert.equal(current.pending.active, false);
        assert.equal(current.protocol.delay, 86400n);
      },
    );

    assert.equal(sdkSends, 9);
    console.log(
      JSON.stringify({
        ok: true,
        sdkSends,
        l1Sends: 1,
        actorParityVerified: 3,
        actualCancelMethod: 'cancel_upgrade',
        applicationDelay: 86400,
        protocolDelay: 86400,
        proofs: false,
      }),
    );
  } finally {
    await journal.close();
    await adapter.close();
  }
} finally {
  Object.assign(process.env, savedEnv);
  await rm(scratch, { recursive: true, force: true });
}
