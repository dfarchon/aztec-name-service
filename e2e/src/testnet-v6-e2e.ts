/** Public V6 acceptance against the canonical deployment. Never deploys or changes modules. */
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnsContext,
  RegistryReader,
  checkRegistration,
  deserializePlan,
  getAvailability,
  getFeeQuote,
  inspectHolding,
  prepareRegistration,
  serializePlan,
  submitCommit,
  submitRegistration,
  waitUntilRegistrable,
  setAddress,
  resolveAddress,
  renew,
  offerTransfer,
  acceptTransfer,
  trackTx,
} from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Contract, NO_WAIT } from '@aztec-labs/aztec.js/contracts';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec-labs/aztec.js/node';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { TxHash, TxStatus } from '@aztec-labs/aztec.js/tx';
import { setLogLevel } from '@aztec-labs/foundation/log';
import { newWallet, randomKeys, sponsoredFpc, sleep } from './common.js';
import { V6_PROFILES, assertV6Fpc, type V6NodeInfo } from './v6-network.js';
import { REPO, assertPrivateDir, within, type Manifest } from './deploy-v6-plan.js';
import { physicalPath, v6Artifacts } from './deploy-v6.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { readKeys } from './init-keys.js';
import {
  assertPayment,
  assertStableBaseline,
  assertRebroadcastStep,
  prepareRebroadcast,
  parseRebroadcast,
  COMMIT_OPTIONS,
  TX_OPTIONS,
  STEPS,
  captureBroadcast,
  checkpointStep,
  loadManifest,
  manifestBinding,
  preflightIdentity,
  privateDirectory,
  publicReport,
  readPrivateState,
  safeFailure,
  savePrivateJson,
  testNames,
  validateState,
  type AccountKeys,
  type Before,
  type E2EState,
  type Step,
} from './testnet-v6-e2e-state.js';

/** Identity precedes the existing loader, including on resume. Tests inject temporary fake keys. */
export async function loadE2EKeys(
  getInfo: () => Promise<V6NodeInfo>,
  path: string,
  manifest: Manifest,
  loader = readKeys,
) {
  await preflightIdentity(getInfo);
  const keys = await loader(path, 'testnet-v6');
  assert(keys.owner.address === manifest.owner, 'Owner keys do not match manifest');
  assert(keys.treasury.address === manifest.treasury, 'Treasury keys do not match manifest');
  return keys;
}

export async function main() {
  if (process.argv.slice(2).join(' ') === '--help') {
    console.log(`Usage: testnet-v6-e2e [--rebroadcast <step>]\nSteps: ${STEPS.join(', ')}\nExplicit recovery requires a pending last hash, DROPPED receipt and absent chain effect.`);
    return;
  }
  const rebroadcast = parseRebroadcast(process.argv.slice(2));
  const manifest = loadManifest(join(REPO, 'deployments/testnet-v6.json'));
  assert(process.env.ANS_V6_E2E_REPORT, 'ANS_V6_E2E_REPORT is required');
  const deploymentDir = await physicalPath(
    resolve(
      process.env.ANS_V6_STATE_DIR ?? join(homedir(), '.local/share/ans/testnet-aztec6-6.0.0'),
    ),
  );
  const dir = await physicalPath(
    resolve(
      process.env.ANS_V6_E2E_STATE_DIR ??
        join(homedir(), '.local/share/ans/testnet-aztec6-6.0.0-e2e'),
    ),
  );
  const reportPath = await physicalPath(resolve(process.env.ANS_V6_E2E_REPORT));
  for (const path of [deploymentDir, dir]) {
    assertPrivateDir(path, 'testnet-v6');
    assert(!within(path, REPO), 'State must not contain repository');
  }
  assert(
    !within(deploymentDir, dir) && !within(dir, deploymentDir),
    'Deployment and e2e state directories must be independent',
  );
  assert(
    !within(REPO, reportPath) && !within(deploymentDir, reportPath) && !within(dir, reportPath),
    'Report must be outside repository and private state directories',
  );
  console.log(
    `PLAN testnet-v6 realProofs=true SponsoredFPC transactions=${STEPS.length} steps=${STEPS.join(',')}`,
  );
  // Suppress third-party diagnostics, including worker diagnostics. Our own output is an explicit public projection.
  process.env.LOG_LEVEL = 'silent';
  setLogLevel('silent');
  const previousMask = process.umask(0o077);
  const profile = V6_PROFILES['testnet-v6'];
  const rawNode = createAztecNodeClient(profile.nodeUrl, { maxBatchSize: profile.maxBatchSize });
  const identity = () => preflightIdentity(() => rawNode.getNodeInfo());
  let wallet: Awaited<ReturnType<typeof newWallet>> | undefined, unlock: (() => void) | undefined;
  let activeStep: Step | undefined;
  try {
    await identity(); // No private keys/checkpoints have been opened at this point.
    await privateDirectory(dir);
    unlock = acquireTestnetLock(join(dir, 'runner.lock'));
    process.once('exit', unlock);
    const keys = await loadE2EKeys(
      () => rawNode.getNodeInfo(),
      join(deploymentDir, 'keys.json'),
      manifest,
    );
    let state = await readPrivateState(join(dir, 'state.json'));
    const freshAccount = async (): Promise<AccountKeys> => {
      const { getSchnorrInitializerlessAccountContractAddress } =
        await import('@aztec-labs/accounts/schnorr');
      const k = randomKeys();
      const address = await getSchnorrInitializerlessAccountContractAddress(
        k.signingKey,
        k.salt,
        k.secret,
      );
      return {
        address: address.toString(),
        secret: k.secret.toString(),
        salt: k.salt.toString(),
        signingKey: k.signingKey.toString(),
      };
    };
    if (!state)
      state = {
        schema: 'ans-testnet-v6-e2e/1',
        binding: manifestBinding(manifest),
        names: testNames(),
        accounts: { user: await freshAccount(), recipient: await freshAccount() },
        plans: {},
        before: {},
        transactions: {},
        done: [],
      };
    const s = state;
    validateState(s, manifest);
    if (rebroadcast) assertRebroadcastStep(s, rebroadcast);
    const save = () => savePrivateJson(join(dir, 'state.json'), s);
    await save();
    const node = new Proxy(rawNode, {
      get(target, prop) {
        if (prop === 'sendTx')
          return async (tx: Tx) => {
            await captureBroadcast(s, activeStep, tx.getTxHash().toString(), identity, save, () =>
              target.sendTx(tx),
            );
            console.log(`BROADCAST ${activeStep} ${s.transactions[activeStep!]}`);
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AztecNode;
    // Ephemeral wallet: private account material persists only in the 0600 checkpoint, never a second wallet store.
    wallet = await newWallet(node, true);
    const fpc = await sponsoredFpc(),
      publishedFpc = await node.getContract(fpc.instance.address);
    assertV6Fpc(
      'testnet-v6',
      fpc.instance,
      (await getContractClassFromArtifact(fpc.artifact)).id.toString(),
      publishedFpc,
    );
    const restore = async (k: AccountKeys) => {
      const address = (
        await wallet!.createSchnorrInitializerlessAccount(
          Fr.fromString(k.secret),
          Fr.fromString(k.salt),
          Fq.fromString(k.signingKey),
        )
      ).address;
      assert(address.toString() === k.address, 'Restored account mismatch');
      return address;
    };
    const admin = await restore(keys.owner),
      treasury = await restore(keys.treasury);
    const user = await restore(s.accounts.user),
      recipient = await restore(s.accounts.recipient);
    assert(admin.toString() === manifest.owner, 'Restored owner does not match manifest');
    const reader = await RegistryReader.connect(
      node,
      AztecAddress.fromStringUnsafe(manifest.registry),
    );
    const { artifacts } = await v6Artifacts(manifest.feeTokenSource, manifest.registrarKind);
    assert(reader.classId === manifest.classIds.registry, 'Registry class mismatch');
    const fee = fpc.fee.fee,
      ctx = new AnsContext(reader, { wallet, account: user, fee }),
      other = ctx.as(recipient);
    await ctx.queue.run(async () => {
      await identity();
      await ctx.assertWalletNetwork();
      await wallet!.registerContract(publishedFpc!, fpc.artifact);
      await ctx.ensureRegistered({
        feeToken: {
          address: AztecAddress.fromStringUnsafe(manifest.feeToken),
          artifact: artifacts.token,
        },
      });
    });
    const token = await Contract.at(
      AztecAddress.fromStringUnsafe(manifest.feeToken),
      artifacts.token,
      wallet,
    );
    const config = await reader.getConfig();
    assert(
      config.feeToken.toString() === manifest.feeToken &&
        config.treasury.equals(treasury) &&
        config.registrar?.toString() === manifest.registrar &&
        config.priceVersion === manifest.priceVersion &&
        config.annualPrice === BigInt(manifest.annualPrice) &&
        config.lengthPrices?.four === 32n * 10n ** 18n,
      'Manifest fee configuration mismatch',
    );
    const year = 31536000n,
      annual = BigInt(manifest.annualPrice),
      four = 32n * 10n ** 18n,
      funding = annual * 2n + four;
    // Only read operations retry. A send failure exits with its saved hash; rerunning tracks that hash.
    const read = async <T>(fn: () => Promise<T>): Promise<T> => {
      const deadline = Date.now() + TX_OPTIONS.timeoutMs;
      while (true) {
        try {
          return await fn();
        } catch (e) {
          const err = e as { code?: string; message?: string };
          if (
            Date.now() >= deadline ||
            !(
              err.code === 'network' ||
              /fetch failed|ECONN|ETIMEDOUT|429|502|503|504|rate.?limit|socket|timeout|rpc.*(unavailable|error)/i.test(
                err.message ?? '',
              )
            )
          )
            throw e;
          await sleep(5000);
          await identity();
        }
      }
    };
    const balances = () =>
      ctx.queue.run(async () => {
        await identity();
        await ctx.assertWalletNetwork();
        const balance = async (a: AztecAddress) =>
          String((await token.methods.balance_of_private(a).simulate({ from: a })).result);
        return { user: await balance(user), treasury: await balance(treasury) };
      });
    const record = (name: string) => getAvailability(reader, name).then((r) => r.record);
    const rememberBefore = async (step: Step, name?: string) => {
      const b: Before = await balances();
      if (name) {
        const r = await record(name);
        Object.assign(b, {
          expiry: String(r.expiresAt),
          generation: r.generation,
          revision: r.revision,
        });
      }
      if (s.before[step]) assertStableBaseline(s.before[step]!, b);
      // Refresh shared treasury before captureBroadcast persists any hash.
      s.before[step] = b;
      await save();
    };
    const exactPayment = async (step: Step, amount: bigint) => {
      const b = s.before[step];
      assert(b, 'Missing payment baseline');
      assertPayment(b, await balances(), amount);
    };
    const step = async (
      name: Step,
      preSend: () => Promise<void>,
      send: () => Promise<unknown>,
      verify: () => Promise<void>,
    ) => {
      activeStep = name;
      if (rebroadcast === name) {
        // deploy-v6 checks DROPPED directly; trackTx has the normal propagation grace period.
        const receiptStatus = await read(async () => {
          await identity();
          const hash = TxHash.fromString(s.transactions[name]);
          const receipt = await node.getTxReceipt(hash);
          assert(receipt.status === TxStatus.DROPPED, 'Rebroadcast requires a DROPPED receipt');
          assert(!(await node.getTxEffect(hash)), 'Rebroadcast forbidden: chain effect exists');
          // Reuse every step's chain precondition (including unchanged payer/name baselines).
          await preSend();
          return receipt.status;
        });
        Object.assign(s, prepareRebroadcast(s, name, { receiptStatus, effectAbsent: true }));
        await save(); // Persist removal before the normal flow can prepare another transaction.
      }
      const resumed = s.done.includes(name);
      console.log(
        `${s.transactions[name] ? 'RESUME' : 'STEP'} ${name}${s.transactions[name] ? ` tx=${s.transactions[name]}` : ''}`,
      );
      await checkpointStep(
        s,
        name,
        () =>
          read(async () => {
            await identity();
            await preSend();
          }),
        send,
        (hash) => trackTx(node, hash, TX_OPTIONS),
        () => read(verify),
        save,
      );
      console.log(
        `PASS ${name} tx=${s.transactions[name]}${resumed ? ' receipt rechecked; assertions previously saved' : ''}`,
      );
      activeStep = undefined;
    };
    await step(
      'mint',
      async () => {
        await rememberBefore('mint');
        assert(BigInt(s.before.mint!.user) === 0n, 'Fresh test user must have zero balance');
      },
      () =>
        ctx.queue.run(async () => {
          await identity();
          await ctx.assertWalletNetwork();
          return token.methods
            .mint_to_private(user, funding)
            .send({ from: admin, fee, wait: NO_WAIT });
        }),
      async () => {
        const b = await balances();
        assert(BigInt(b.user) === funding, 'Minted test balance mismatch');
      },
    );

    const register = async (kind: 'long' | 'short', expected: bigint) => {
      const commit = `${kind}-commit` as Step,
        registration = `${kind}-register` as Step;
      if (!s.plans[kind]) {
        assert(!s.transactions[commit], 'Commit hash exists without recovery plan');
        // Find a free random name before saving its permanent plan; never replace a committed name.
        for (let i = 0; ; i++) {
          if ((await read(() => getAvailability(reader, s.names[kind]))).available) break;
          assert(i < 100, 'Unable to find an available test name');
          s.names[kind] = testNames()[kind];
          await save();
        }
        const quote = await read(() =>
          getFeeQuote(reader, {
            operation: 'register',
            duration: year,
            labelLength: s.names[kind].length,
          }),
        );
        assert(
          quote.fee === expected && quote.registrar?.toString() === manifest.registrar,
          'Registration quote mismatch',
        );
        s.plans[kind] = serializePlan(
          await read(() =>
            prepareRegistration(ctx, { name: s.names[kind], duration: year, acceptedQuote: quote }),
          ),
        );
        await save();
      }
      const plan = () => deserializePlan(s.plans[kind]!);
      await step(
        commit,
        async () => {
          assert(
            (await checkRegistration(reader, plan())).state === 'commit_missing',
            'Commit already exists without hash; inspect checkpoint',
          );
        },
        () => submitCommit(ctx, plan(), TX_OPTIONS),
        async () => {
          const p = { ...plan(), commitTx: s.transactions[commit] };
          s.plans[kind] = serializePlan(p);
          assert(
            ['commit_wait', 'ready_to_register'].includes(
              (await checkRegistration(reader, p)).state,
            ),
            'Commit not persisted',
          );
        },
      );
      await step(
        registration,
        async () => {
          const status = await waitUntilRegistrable(reader, plan(), COMMIT_OPTIONS);
          assert(
            status.state === 'ready_to_register',
            'Registration already exists without hash; inspect checkpoint',
          );
          await rememberBefore(registration);
        },
        () => submitRegistration(ctx, plan(), TX_OPTIONS),
        async () => {
          await exactPayment(registration, expected);
          assert((await record(s.names[kind])).owner.equals(user), 'Registered owner mismatch');
        },
      );
    };
    await register('long', annual);
    await step(
      'set-address',
      async () => {
        assert((await record(s.names.long)).owner.equals(user), 'Address setter must own name');
        const r = await resolveAddress(reader, s.names.long);
        assert(
          r.status !== 'resolved' || !r.address.equals(user),
          'Address effect exists without hash',
        );
      },
      () => setAddress(ctx, { name: s.names.long, address: user }, TX_OPTIONS),
      async () => {
        const r = await resolveAddress(reader, s.names.long);
        assert(r.status === 'resolved' && r.address.equals(user), 'Address resolution mismatch');
      },
    );
    await step(
      'renew',
      async () => {
        await rememberBefore('renew', s.names.long);
        const holding = await inspectHolding(ctx, s.names.long);
        assert(holding.record.owner.equals(user), 'Renewal holder mismatch');
        const quote = await getFeeQuote(reader, {
          operation: 'renew',
          duration: year,
          labelLength: holding.label.len,
          snapshot: holding.snapshot,
        });
        assert(
          quote.fee === annual && quote.registrar?.toString() === manifest.registrar,
          'Tiered renewal quote mismatch',
        );
      },
      () => renew(ctx, { name: s.names.long, duration: year, maxFee: annual }, TX_OPTIONS),
      async () => {
        await exactPayment('renew', annual);
        const r = await record(s.names.long),
          b = s.before.renew!;
        assert(
          r.expiresAt === BigInt(b.expiry!) + year &&
            r.generation === b.generation &&
            r.revision === b.revision! + 1,
          'Renewal expiry/generation/revision mismatch',
        );
      },
    );
    await register('short', four);
    const offer = async () => {
      const h = await inspectHolding(ctx, s.names.long);
      return reader.getTransfer(h.node, h.record.generation, h.snapshot);
    };
    await step(
      'offer-transfer',
      async () => {
        assert((await record(s.names.long)).owner.equals(user), 'Transfer sender owner mismatch');
        assert((await offer()).recipient.isZero(), 'Transfer offer already exists without hash');
      },
      () => offerTransfer(ctx, { name: s.names.long, recipient }, TX_OPTIONS),
      async () => {
        assert((await offer()).recipient.equals(recipient), 'Transfer recipient mismatch');
      },
    );
    await step(
      'accept-transfer',
      async () => {
        assert(
          (await record(s.names.long)).owner.equals(user) &&
            (await offer()).recipient.equals(recipient),
          'Transfer precondition mismatch',
        );
      },
      () => acceptTransfer(other, { name: s.names.long }, TX_OPTIONS),
      async () => {
        assert((await record(s.names.long)).owner.equals(recipient), 'Transferred owner mismatch');
      },
    );
    await read(async () => {
      assert(
        (await record(s.names.long)).owner.equals(recipient) &&
          (await record(s.names.short)).owner.equals(user),
        'Final owners mismatch',
      );
    });
    const report = publicReport(s);
    await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
    await savePrivateJson(reportPath, report);
    console.log(JSON.stringify(report));
  } finally {
    try {
      await wallet?.stop();
    } finally {
      if (unlock) {
        unlock();
        process.removeListener('exit', unlock);
      }
      process.umask(previousMask);
    }
  }
}
export async function runSafely(task = main) {
  try {
    await task();
    return true;
  } catch {
    console.error(safeFailure());
    return false;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!(await runSafely())) process.exitCode = 1;
}
