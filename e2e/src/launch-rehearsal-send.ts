/** Explicitly confirmed, real-proof execution; never imported by the dry-run path. */
import assert from 'node:assert/strict';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import {
  Contract,
  NO_WAIT,
  getContractInstanceFromInstantiationParams,
} from '@aztec-labs/aztec.js/contracts';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { setLogLevel } from '@aztec-labs/foundation/log';
import {
  AnsContext,
  RegistryReader,
  NameResolverContract,
  NameRegistrarLaunchContract,
  prepareRegistration,
  serializePlan,
  deserializePlan,
  submitCommit,
  submitRegistration,
  waitUntilRegistrable,
  trackTx,
  getFeeQuote,
  inspectHolding,
  setResolver,
  setAddress,
  offerTransfer,
  acceptTransfer,
  normalizeName,
  nodeOf,
} from '@ans/sdk';
import { ExecutionQueue } from '../../sdk/src/wallet/queue.js';
import { assertWalletNetwork } from '../../sdk/src/wallet/network.js';
import { NameRegistryV7Contract } from '@ans/sdk/contracts/v7';
import { readKeys } from './init-keys.js';
import { instances, v6Artifacts } from './deploy-v6.js';
import type { Policy } from './deploy-v6-plan.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { acceptanceChecks, runCheckpointedStep } from './testnet-checkpoint.js';
import { savePrivateJson } from './testnet-v6-e2e-state.js';
import { readFeeJuiceBalance } from './fee-juice-payment.js';
import {
  reservedNodes,
  reservedBatches,
  verifyReservations,
  reservedListHash,
} from './launch-policy.js';
import { assertV6Network, assertV6FeeJuice } from './v6-network.js';
import {
  quoteWindowMeasurements,
  type RehearsalConfig,
  type rehearsalPlan,
} from './launch-rehearsal-plan.js';
type Plan = ReturnType<typeof rehearsalPlan>;
type State = {
  schema: string;
  binding: string;
  owner: string;
  recipient: string;
  transactions: Record<string, string>;
  done: string[];
  registration?: string;
  mint?: { expiry: string; secret: string; commitment: string };
  commitStartedAt?: number;
  commitChainStart?: string;
  deployment?: Record<string, string>;
  commitCheckpointMs?: number;
  commitMeasurementQuality?: 'observed_checkpoint_poll' | 'resume_upper_bound';
  checks?: string[];
  quoteMeasurements?: unknown;
  quotePreflight?: unknown;
  fees: Record<string, string>;
};
/** Injectable boundaries let unit tests exercise orchestration without files, keys, proving or RPC. */
export const rehearsalSendDependencies = {
  lstat,
  open,
  readKeys,
  acquireTestnetLock,
  savePrivateJson,
  trackTx,
  createWallet: EmbeddedWallet.create.bind(EmbeddedWallet),
  readFeeJuiceBalance,
  assertWalletNetwork,
  v6Artifacts,
  instances,
  getContractInstanceFromInstantiationParams,
  deploy: Contract.deploy,
  registryAt: NameRegistryV7Contract.at,
  registrarAt: NameRegistrarLaunchContract.at,
  resolverAt: NameResolverContract.at,
  connectReader: RegistryReader.connect,
  Context: AnsContext,
  prepareRegistration,
  submitCommit,
  submitRegistration,
  waitUntilRegistrable,
  getFeeQuote,
  inspectHolding,
  setResolver,
  setAddress,
  offerTransfer,
  acceptTransfer,
};
export async function sendRehearsal(
  c: { stateDir: string; nodeUrl: string },
  config: RehearsalConfig,
  plan: Plan,
  raw: AztecNode,
  deps = rehearsalSendDependencies,
) {
  const {
    lstat,
    open,
    readKeys,
    acquireTestnetLock,
    savePrivateJson,
    trackTx,
    createWallet,
    readFeeJuiceBalance,
    assertWalletNetwork,
    v6Artifacts,
    instances,
    getContractInstanceFromInstantiationParams,
    deploy,
    registryAt,
    registrarAt,
    resolverAt,
    connectReader,
    Context,
    prepareRegistration,
    submitCommit,
    submitRegistration,
    waitUntilRegistrable,
    getFeeQuote,
    inspectHolding,
    setResolver,
    setAddress,
    offerTransfer,
    acceptTransfer,
  } = deps;
  setLogLevel('silent');
  const stat = await lstat(c.stateDir);
  assert(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid!() &&
      (stat.mode & 0o077) === 0,
    'Supervisor must create a private directory first',
  );
  const unlock = acquireTestnetLock(join(c.stateDir, 'runner.lock'));
  let wallet: EmbeddedWallet | undefined;
  try {
    const identity = async () => {
      const info = await raw.getNodeInfo();
      assertV6Network('testnet-v6', info, c.nodeUrl);
      assertV6FeeJuice('testnet-v6', info);
    };
    await identity();
    const keys = await readKeys(join(c.stateDir, 'keys.json'), 'testnet-v6');
    const owner = AztecAddress.fromStringUnsafe(keys.owner.address),
      recipient = AztecAddress.fromStringUnsafe(keys.treasury.address);
    assert(
      !config.balanceAccounts.includes(owner.toString()) &&
        !config.balanceAccounts.includes(recipient.toString()),
      'Fresh accounts required; never reuse prior rehearsal owner',
    );
    const checkpoint = join(c.stateDir, 'rehearsal-checkpoint.json');
    let s: State;
    try {
      const file = await open(checkpoint, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = await file.stat();
        assert(
          st.isFile() && st.uid === process.getuid!() && (st.mode & 0o777) === 0o600,
          'Private checkpoint required',
        );
        s = JSON.parse(await file.readFile('utf8'));
      } finally {
        await file.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      s = {
        schema: 'ans-v7-rehearsal-checkpoint/1',
        binding: plan.configHash,
        owner: owner.toString(),
        recipient: recipient.toString(),
        transactions: {},
        done: [],
        fees: {},
      };
    }
    assert.equal(s.schema, 'ans-v7-rehearsal-checkpoint/1');
    assert.equal(s.binding, plan.configHash);
    assert.equal(s.owner, owner.toString());
    assert.equal(s.recipient, recipient.toString());
    const checks = acceptanceChecks(s.checks ?? (s.checks = []));
    const resumedCommit = !!s.transactions.commit;
    const save = async () => {
      await savePrivateJson(checkpoint, s);
      await savePrivateJson(join(c.stateDir, 'rehearsal-report.json'), {
        schema: s.schema,
        binding: s.binding,
        owner: s.owner,
        recipient: s.recipient,
        deployment: s.deployment,
        transactions: s.transactions,
        done: s.done,
        fees: s.fees,
        commitCheckpointMs: s.commitCheckpointMs,
        quoteMeasurements: s.quoteMeasurements,
        quotePreflight: s.quotePreflight,
        commitMeasurementQuality: s.commitMeasurementQuality,
        ...checks.report(),
      });
    };
    // Before restoring a wallet, inspect every recorded hash; never erase or retry a terminal or ambiguous transaction.
    for (const hash of Object.values(s.transactions))
      await trackTx(raw, hash, { waitFor: 'proven', timeoutMs: 1800000 });
    let active: string | undefined;
    const node = new Proxy(raw, {
      get(target, prop) {
        if (prop === 'sendTx')
          return async (tx: Tx) => {
            assert(active, 'Uncheckpointed broadcast prohibited');
            await identity();
            const hash = tx.getTxHash().toString();
            assert(!s.transactions[active], 'Duplicate transaction prohibited');
            s.transactions[active] = hash;
            await save();
            return target.sendTx(tx);
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AztecNode;
    wallet = await createWallet(node, {
      pxe: { proverEnabled: true, dataDirectory: join(c.stateDir, 'wallet') },
    });
    let operationQueue: Pick<ExecutionQueue, 'run'> = new ExecutionQueue();
    const queued = <T>(operation: () => Promise<T>) =>
      operationQueue.run(async () => {
        await identity();
        await assertWalletNetwork(wallet!, { chainId: 11155111n, rollupVersion: 679261766n });
        return operation();
      });
    for (const k of [keys.owner, keys.treasury]) {
      await queued(async () => {
        assert(
          (await readFeeJuiceBalance(node, AztecAddress.fromStringUnsafe(k.address))) > 0n,
          'Bridge Fee Juice to both new accounts first',
        );
        assert.equal(
          (
            await wallet!.createSchnorrInitializerlessAccount(
              Fr.fromString(k.secret),
              Fr.fromString(k.salt),
              Fq.fromString(k.signingKey),
            )
          ).address.toString(),
          k.address,
        );
      });
    }
    const { artifacts, classIds } = await v6Artifacts('none', 'launch', 7);
    const policy: Policy = {
      registryVersion: 7,
      registrar: 'launch',
      token: 'none',
      treasury: recipient.toString(),
      annualPrice: '0',
      lengthPrices: { '3': '0', '4': '0' },
      priceVersion: 1,
      tokenName: 'FREE',
      tokenSymbol: 'FREE',
      decimals: 18,
      minPublicLength: 7,
      initialPaused: true,
      maxRenewAhead: config.maxRenewAhead,
      reservedLabels: config.reservedLabels,
      reservedListHash: reservedListHash(config.reservedLabels),
    };
    const prepared = await instances(artifacts, policy, owner, keys.salts),
      addresses = prepared.values;
    const deployment = {
      ...Object.fromEntries(
        Object.entries(addresses).map(([key, value]) => [key, value.address.toString()]),
      ),
      ...Object.fromEntries(
        Object.entries(classIds).map(([key, value]) => [`${key}ClassId`, value]),
      ),
    };
    if (s.deployment)
      assert.deepEqual(
        s.deployment,
        deployment,
        'Checkpoint deployment salts or artifacts changed',
      );
    else {
      assert.equal(Object.keys(s.transactions).length, 0, 'Deployment binding missing');
      s.deployment = deployment;
      await save();
    }
    const core = registryAt(addresses.registry.address, wallet),
      registrar = registrarAt(addresses.registrar.address, wallet);
    const customSalt = Fr.fromString(keys.salts.token);
    const customInstance = await getContractInstanceFromInstantiationParams(artifacts.resolver, {
      constructorArgs: [core.address],
      salt: customSalt,
      deployer: owner,
    });
    const custom = resolverAt(customInstance.address, wallet);
    const step = async (
      name: string,
      send: () => Promise<unknown>,
      verify: () => Promise<void>,
    ) => {
      active = name;
      try {
        await runCheckpointedStep(
          s,
          name,
          send,
          async (hash) => {
            if (name === 'commit' && s.commitCheckpointMs === undefined) {
              await trackTx(node, hash, { waitFor: 'confirmed', timeoutMs: 1800000 });
              s.commitCheckpointMs = Date.now() - s.commitStartedAt!;
              s.commitMeasurementQuality = resumedCommit
                ? 'resume_upper_bound'
                : 'observed_checkpoint_poll';
              const timestamp = (await node.getBlock('latest'))!.header.globalVariables.timestamp;
              s.quoteMeasurements = quoteWindowMeasurements(
                config.quoteWindowsSeconds,
                s.commitCheckpointMs,
                Number(timestamp - BigInt(s.commitChainStart!)),
              );
              await save();
            }
            const result = await trackTx(node, hash, { waitFor: 'proven', timeoutMs: 1800000 });
            const receipt = await node.getTxReceipt(
              (await import('@aztec-labs/aztec.js/tx')).TxHash.fromString(hash),
            );
            assert(receipt.transactionFee !== undefined, 'Receipt fee required');
            s.fees[name] = String(receipt.transactionFee);
            await save();
            return result;
          },
          async () => {
            await verify();
            checks.check(name, true);
          },
          save,
        );
      } finally {
        active = undefined;
      }
    };
    for (const key of ['registry', 'resolver', 'registrar'] as const)
      await step(
        `deploy-${key}`,
        () =>
          queued(async () => {
            return deploy(wallet!, artifacts[key], prepared.args[key], undefined, {
              salt: Fr.fromString(keys.salts[key]),
              deployer: owner,
            }).send({
              from: owner,
              skipClassPublication: !!(await node.getContractClass(
                addresses[key].currentContractClassId,
              )),
              wait: NO_WAIT,
            });
          }),
        async () => {
          assert.equal(
            (await node.getContract(addresses[key].address))?.currentContractClassId.toString(),
            classIds[key],
          );
        },
      );
    await step(
      'deploy-custom-resolver',
      () =>
        queued(async () => {
          return deploy(wallet!, artifacts.resolver, [core.address], undefined, {
            salt: customSalt,
            deployer: owner,
          }).send({ from: owner, skipClassPublication: true, wait: NO_WAIT });
        }),
      async () => {
        assert.equal(
          (await node.getContract(custom.address))?.currentContractClassId.toString(),
          classIds.resolver,
        );
      },
    );
    const direct = async (build: () => ReturnType<typeof core.methods.bootstrap>, from = owner) =>
      queued(async () => build().send({ from, wait: NO_WAIT }));
    await step(
      'configure',
      () => direct(() => core.methods.bootstrap(registrar.address, addresses.resolver.address)),
      async () => {
        const r = await connectReader(node, core.address);
        assert((await r.getModules()).registrar.equals(registrar.address));
      },
    );
    const reader = await connectReader(node, core.address);
    const ctx = new Context(reader, { wallet, account: owner, beforeSend: identity }),
      buyer = ctx.as(recipient);
    operationQueue = ctx.queue;
    await ctx.queue.run(async () => {
      await identity();
      await ctx.ensureRegistered();
    });
    await buyer.queue.run(async () => {
      await identity();
      await buyer.ensureRegistered();
    });
    for (const [i, batch] of reservedBatches(await reservedNodes(config.reservedLabels)).entries())
      await step(
        i === 0 ? 'seed-reserved' : `seed-reserved-${i}`,
        () => direct(() => registrar.methods.set_reserved(batch, true)),
        async () => {
          await verifyReservations(
            batch.filter((n) => n !== 0n).map((node) => ({ node, reserved: true })),
            async (n) => reader.isReserved(n),
          );
        },
      );
    await step(
      'resume',
      () => direct(() => registrar.methods.set_paused(false)),
      async () => {
        assert.equal((await reader.getConfig()).launch?.paused, false);
      },
    );
    assert(!s.transactions.commit || s.registration, 'Missing saved registration');
    const registration = () => deserializePlan(s.registration!);
    if (!s.quotePreflight) {
      const rows = [];
      for (const seconds of config.quoteWindowsSeconds) {
        const q = await getFeeQuote(reader, {
          operation: 'register',
          duration: 31536000n,
          labelLength: config.name.length,
          validForSeconds: BigInt(seconds),
        });
        let accepted = false;
        try {
          await prepareRegistration(ctx, {
            name: config.name,
            duration: 31536000n,
            acceptedQuote: q,
          });
          accepted = true;
        } catch (e) {
          assert(
            (e as { code?: string }).code === 'quote_expired',
            'Unexpected quote-window preflight error',
          );
        }
        rows.push({ seconds, accepted });
      }
      s.quotePreflight = rows;
      await save();
    }
    await step(
      'commit',
      async () => {
        // Only the unsent commitment may change; saved hashes retain their exact bound plan.
        s.registration = serializePlan(
          await prepareRegistration(ctx, { name: config.name, duration: 31536000n }),
        );
        s.commitStartedAt = Date.now();
        s.commitChainStart = String((await reader.snapshot()).timestamp);
        await save();
        return submitCommit(ctx, registration());
      },
      async () => {
        s.registration = serializePlan({ ...registration(), commitTx: s.transactions.commit });
        await save();
      },
    );
    await step(
      'register',
      async () => {
        await waitUntilRegistrable(reader, registration(), { timeoutMs: 1800000, pollMs: 5000 });
        return submitRegistration(ctx, registration());
      },
      async () => {
        assert((await inspectHolding(ctx, config.name)).isHolder);
      },
    );
    await step(
      'choose-custom-resolver',
      () => setResolver(ctx, { name: config.name, resolver: custom.address }),
      async () => {
        const h = await inspectHolding(ctx, config.name);
        assert((await reader.getResolver(h.node, h.record.generation)).equals(custom.address));
      },
    );
    await step(
      'custom-write',
      () => setAddress(ctx, { name: config.name, address: owner }),
      async () => {
        const h = await inspectHolding(ctx, config.name);
        assert(
          (await reader.getAddress(h.node, h.record.generation, h.snapshot)).addr.equals(owner),
        );
      },
    );
    await step(
      'offer-transfer',
      () => offerTransfer(ctx, { name: config.name, recipient }),
      async () => {
        const h = await inspectHolding(ctx, config.name);
        assert(
          (await reader.getTransfer(h.node, h.record.generation, h.snapshot)).recipient.equals(
            recipient,
          ),
        );
      },
    );
    await step(
      'accept-transfer',
      () => acceptTransfer(buyer, { name: config.name }),
      async () => {
        const h = await inspectHolding(buyer, config.name);
        assert(h.isHolder);
        assert(
          (await reader.getResolver(h.node, h.record.generation)).equals(
            addresses.resolver.address,
          ),
        );
      },
    );
    // These probes simulate only. A transport error cannot satisfy an expected contract rejection.
    const after = await inspectHolding(buyer, config.name);
    await buyer.queue.run(async () => {
      await identity();
      await buyer.assertWalletNetwork();
      await assert.rejects(
        custom.methods
          .set_address(after.node, after.record.generation, after.recordRevision, true, owner)
          .simulate({ from: recipient }),
        (e) => /unauthorized resolver/i.test(String(e)),
      );
    });
    checks.check('old-resolver-rejected', true);
    await save();
    await assert.rejects(
      prepareRegistration(ctx, { name: config.reservedLabels[0], duration: 31536000n }),
      (e: any) => e.code === 'name_reserved',
    );
    checks.check('reserved-rejected', true);
    await save();
    await assert.rejects(
      prepareRegistration(ctx, { name: 'short', duration: 31536000n }),
      (e: any) => e.code === 'name_not_available_yet',
    );
    checks.check('short-rejected', true);
    await save();
    assert(!s.transactions['admin-commit'] || s.mint, 'Missing saved mint');
    const prepareMint = async () => {
      const label = normalizeName(config.mintName),
        expiry = (await reader.snapshot()).timestamp + 86400n,
        secret = Fr.random();
      const commitment = await queued(
        async () =>
          (
            await registrar.methods
              .admin_commitment(recipient, label.bytes, label.len, 0, expiry, secret)
              .simulate({ from: owner })
          ).result,
      );
      s.mint = {
        expiry: String(expiry),
        secret: secret.toString(),
        commitment: String(commitment),
      };
      await save();
    };
    await step(
      'admin-commit',
      async () => {
        // Expiry is part of the admin commitment, so refresh immediately before its first send.
        await prepareMint();
        return direct(() => registrar.methods.commit(Fr.fromString(s.mint!.commitment)));
      },
      async () => {
        assert(
          (
            await reader.getCommit(
              Fr.fromString(s.mint!.commitment).toBigInt(),
              await reader.snapshot(),
            )
          ).committedAt > 0n,
        );
      },
    );
    await step(
      'admin-mint',
      async () => {
        const end = Date.now() + 1800000;
        while (true) {
          const snap = await reader.snapshot(),
            commit = await reader.getCommit(Fr.fromString(s.mint!.commitment).toBigInt(), snap);
          if (snap.timestamp >= commit.committedAt + 60n) break;
          assert(Date.now() < end, 'Mint commit maturity timeout');
          await new Promise((r) => setTimeout(r, 5000));
        }
        const label = normalizeName(config.mintName);
        return direct(() =>
          registrar.methods.admin_register(
            label.bytes,
            label.len,
            recipient,
            0,
            BigInt(s.mint!.expiry),
            Fr.fromString(s.mint!.secret),
          ),
        );
      },
      async () => {
        assert((await inspectHolding(buyer, config.mintName)).isHolder);
      },
    );
    await step(
      'pause',
      () => direct(() => registrar.methods.set_paused(true)),
      async () => {
        assert((await reader.getConfig()).launch?.paused);
      },
    );
    // Run the paused probe only while the pause still applies; record that assertion separately on resume.
    if (!s.transactions['resume-final']) {
      await assert.rejects(
        prepareRegistration(ctx, { name: 'pausedlaunch', duration: 31536000n }),
        (e: any) => e.code === 'registration_paused',
      );
      checks.check('paused-rejected', true);
      await save();
    }
    await step(
      'resume-final',
      () => direct(() => registrar.methods.set_paused(false)),
      async () => {
        assert.equal((await reader.getConfig()).launch?.paused, false);
      },
    );
    await save();
    console.log(
      'Rehearsal complete; public results are in rehearsal-report.json. Historical checkpointed steps were resumed, not rebroadcast.',
    );
  } finally {
    try {
      await wallet?.stop();
    } finally {
      unlock();
    }
  }
}
