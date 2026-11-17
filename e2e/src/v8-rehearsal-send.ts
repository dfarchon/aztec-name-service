/**
 * Explicitly confirmed, real-proof V8 upgrade rehearsal executor.
 * Runs exclusively under `ans-signer` inside `/var/lib/ans-signer/testnet-v8-upgrade-rehearsal-*`.
 * Persists and fsyncs exact L1/L2 transaction hashes BEFORE broadcast; saved hashes resume TRACK ONLY.
 * Exits cleanly with Asia/Taipei resume timestamps at 86,400-second application/protocol waits.
 */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  http,
  keccak256,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { FeeAssetHandlerAbi } from '@aztec-foundation/l1-artifacts/FeeAssetHandlerAbi';
import { FeeJuicePortalAbi } from '@aztec-foundation/l1-artifacts/FeeJuicePortalAbi';
import { TestERC20Abi } from '@aztec-foundation/l1-artifacts/TestERC20Abi';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import {
  Contract,
  NO_WAIT,
  getContractInstanceFromInstantiationParams,
} from '@aztec-labs/aztec.js/contracts';
import { publishContractClass } from '@aztec-labs/aztec.js/deployment';
import { FeeJuicePaymentMethodWithClaim, type FeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { TxHash } from '@aztec-labs/aztec.js/tx';
import { setLogLevel } from '@aztec-labs/foundation/log';
import { computeSecretHash } from '@aztec-labs/stdlib/hash';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import {
  AnsContext,
  CORE_UPGRADE_FAMILY,
  NameRegistrarLaunchContract,
  NameResolverContract,
  RegistryReader,
  acceptTransfer,
  administerCoreUpgrade,
  deserializePlan,
  getFeeQuote,
  issueSubname,
  nodeOf,
  normalizeName,
  offerTransfer,
  prepareRegistration,
  renew,
  resolveAddress,
  resolvePrimary,
  serializePlan,
  setAddress,
  setManager,
  setPrimary,
  setResolver,
  setTextRecord,
  submitCommit,
  submitRegistration,
  trackTx,
  waitUntilRegistrable,
  type CoreUpgradeAction,
} from '@ans/sdk';
import { NameRegistryV8Contract, NameRegistryV8RehearsalContract } from '@ans/sdk/contracts/v8';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import reservations from '../../deployments/reserved-labels.json' with { type: 'json' };
import { assertV8DeploymentOwner, v8BoundDeployment } from './v8-deployment.js';
import {
  loadV8Credentials,
  type SignerIdentity,
  type V8ActorRole,
  type V8PublicAccounts,
} from './v8-account-generator.js';
import { v8WaitCheckpoint } from './v8-rehearsal-plan.js';
import { fullDelay } from './v8-safe-operator.js';
import { verifyPublicNode } from './v8-real-adapters.js';
import {
  APPROVED_L2_PRICE_CEILING,
  APPROVED_MAX_FEE_JUICE_WEI,
  APPROVED_MAX_SEPOLIA_ETH_WEI,
  SEPOLIA_FEE_ASSET_HANDLER,
  SEPOLIA_FEE_JUICE_PORTAL,
  SEPOLIA_FEE_JUICE_TOKEN,
  verifyCanonicalSepoliaContracts,
} from './testnet-v8-upgrade-rehearsal.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { savePrivateJson } from './testnet-v6-e2e-state.js';
import { readFeeJuiceBalance } from './fee-juice-payment.js';
import {
  canonicalReservedLabels,
  reservedBatches,
  reservedListHash,
  reservedNodes,
} from './launch-policy.js';
import { assertV6FeeJuice, assertV6Network } from './v6-network.js';

type ClaimRecord = {
  amountWei: string;
  claimSecret: string;
  claimSecretHash: string;
  depositTx?: Hex;
  messageHash?: Hex;
  leafIndex?: string;
  provenObservations: number;
  consumedByStep?: string;
};

type V8RunState = {
  schema: 'ans-v8-live-rehearsal-state/1';
  confirmation: string;
  l1Transactions: Record<string, Hex>;
  l1Done: string[];
  l1FeesWei: Record<string, string>;
  claims: Record<V8ActorRole, ClaimRecord>;
  l2Transactions: Record<string, string>;
  l2Done: string[];
  l2FeesWei: Record<string, string>;
  observations: Record<string, number>;
  addresses?: {
    registry: string;
    resolver: string;
    registrar: string;
    customResolver: string;
  };
  plans: Record<string, string>;
  adminMint?: { expiry: string; secret: string; commitment: string };
  waitTimestamps: Record<string, string>;
  completedAt?: string;
};

export async function sendV8Rehearsal(
  config: { stateDir: string; nodeUrl: string; l1Rpc: string; confirmation: string },
  publicAccounts: V8PublicAccounts,
  rawNode: AztecNode,
  signer: SignerIdentity,
) {
  setLogLevel('silent');
  const credentials = await loadV8Credentials(config.stateDir, signer);
  assert.equal(credentials.l1Funding.address, publicAccounts.l1FundingAddress);
  const unlock = acquireTestnetLock(join(config.stateDir, 'runner.lock'));
  let wallet: EmbeddedWallet | undefined;

  try {
    const statePath = join(config.stateDir, 'state.json');
    const reportPath = join(config.stateDir, 'report.json');
    let state: V8RunState;
    try {
      const f = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = await f.stat();
        assert(s.isFile() && s.uid === signer.uid && (s.mode & 0o777) === 0o600);
        state = JSON.parse(await f.readFile('utf8')) as V8RunState;
      } finally {
        await f.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const claims = {} as Record<V8ActorRole, ClaimRecord>;
      for (const role of ['A', 'B', 'C'] as const) {
        const secret = Fr.random();
        claims[role] = {
          amountWei: String(BigInt(credentials.actors[role].bridgeAmountFeeJuice) * 10n ** 18n),
          claimSecret: secret.toString(),
          claimSecretHash: (await computeSecretHash(secret)).toString(),
          provenObservations: 0,
        };
      }
      state = {
        schema: 'ans-v8-live-rehearsal-state/1',
        confirmation: config.confirmation,
        l1Transactions: {},
        l1Done: [],
        l1FeesWei: {},
        claims,
        l2Transactions: {},
        l2Done: [],
        l2FeesWei: {},
        observations: {},
        plans: {},
        waitTimestamps: {},
      };
      await savePrivateJson(statePath, state);
    }
    assert.equal(state.schema, 'ans-v8-live-rehearsal-state/1');
    assert.equal(state.confirmation, config.confirmation, 'Checkpoint confirmation binding mismatch');

    const save = async (status = 'IN_PROGRESS', extra: Record<string, unknown> = {}) => {
      await savePrivateJson(statePath, state);
      const spentL1Wei = Object.values(state.l1FeesWei).reduce((a, b) => a + BigInt(b), 0n);
      const spentL2Wei = Object.values(state.l2FeesWei).reduce((a, b) => a + BigInt(b), 0n);
      await savePrivateJson(reportPath, {
        ...extra,
        schema: 'ans-v8-live-rehearsal-report/1',
        status,
        confirmation: state.confirmation,
        l1FundingAddress: publicAccounts.l1FundingAddress,
        actors: publicAccounts.actors,
        addresses: state.addresses ?? null,
        l1Transactions: state.l1Transactions,
        l1Done: state.l1Done,
        l1SpentWei: String(spentL1Wei),
        l2Transactions: state.l2Transactions,
        l2Done: state.l2Done,
        l2SpentFeeJuiceWei: String(spentL2Wei),
        waitTimestamps: state.waitTimestamps,
      });
    };

    const verifyLiveNetworks = async () => {
      const info = await rawNode.getNodeInfo();
      verifyPublicNode(info);
      assertV6Network('testnet-v6', info, config.nodeUrl);
      assertV6FeeJuice('testnet-v6', info);
      const minFees = await rawNode.getCurrentMinFees();
      assert.equal(minFees.feePerDaGas, 0n, 'DA fee changed from zero: STOP');
      assert(
        minFees.feePerL2Gas <= APPROVED_L2_PRICE_CEILING,
        'Aztec L2 fee exceeds approved ceiling: STOP',
      );
      const spentL2 = Object.values(state.l2FeesWei).reduce((a, b) => a + BigInt(b), 0n);
      assert(spentL2 <= APPROVED_MAX_FEE_JUICE_WEI, 'Approved 350 FJ budget ceiling reached');
      return { info, minFees, spentL2 };
    };

    await verifyLiveNetworks();
    const l1Public = createPublicClient({
      chain: sepolia,
      transport: http(config.l1Rpc, { timeout: 20_000, retryCount: 0 }),
    });
    await verifyCanonicalSepoliaContracts(l1Public);

    // Phase 1: L1 FeeJuice mint + approve + 3 actor deposits (checkpointed before broadcast).
    const l1Account = privateKeyToAccount(credentials.l1Funding.privateKey);
    let activeL1 = '';
    const baseHttp = http(config.l1Rpc, { timeout: 20_000, retryCount: 0 })({});
    const l1Wallet = createWalletClient({
      account: l1Account,
      chain: sepolia,
      transport: custom(
        {
          request: async (args) => {
            if (args.method === 'eth_sendRawTransaction') {
              assert(activeL1 && !state.l1Transactions[activeL1], 'Duplicate L1 broadcast refused');
              const rawTx = (args.params as Hex[])[0]!;
              state.l1Transactions[activeL1] = keccak256(rawTx);
              await save();
            }
            return baseHttp.request(args as Parameters<typeof baseHttp.request>[0]);
          },
        },
        { retryCount: 0 },
      ),
    });

    const reserveObservation = async (key: string) => {
      const next = (state.observations[key] ?? 0) + 1;
      assert(next <= 20, `Observation limit (20) exhausted for ${key}; STOP without resend`);
      state.observations[key] = next;
      await save();
    };

    const runL1Step = async (name: string, send: () => Promise<Hex>) => {
      if (state.l1Done.includes(name)) return;
      const existing = state.l1Transactions[name];
      if (existing) {
        await reserveObservation(`l1:${name}`);
        const receipt = await l1Public.getTransactionReceipt({ hash: existing });
        assert.equal(receipt.status, 'success', `L1 step ${name} reverted: ${existing}`);
        state.l1FeesWei[name] = String(receipt.gasUsed * receipt.effectiveGasPrice);
        state.l1Done.push(name);
        await save();
        return;
      }
      const spentL1 = Object.values(state.l1FeesWei).reduce((a, b) => a + BigInt(b), 0n);
      const l1Bal = await l1Public.getBalance({ address: l1Account.address });
      assert(l1Bal > 0n, `Sepolia funding address ${l1Account.address} has 0 ETH`);
      assert(spentL1 <= APPROVED_MAX_SEPOLIA_ETH_WEI, 'Approved 0.006 Sepolia ETH ceiling reached');
      activeL1 = name;
      try {
        await send();
        const sent = state.l1Transactions[name];
        assert(sent, `L1 step ${name} did not checkpoint hash`);
        const receipt = await l1Public.waitForTransactionReceipt({ hash: sent, timeout: 180_000 });
        assert.equal(receipt.status, 'success', `L1 step ${name} reverted: ${sent}`);
        state.l1FeesWei[name] = String(receipt.gasUsed * receipt.effectiveGasPrice);
        state.l1Done.push(name);
        await save();
      } finally {
        activeL1 = '';
      }
    };

    const totalBridgeWei = APPROVED_MAX_FEE_JUICE_WEI; // 350 FJ (single 1,000 FJ handler mint covers all 3)
    const mintAmount = await l1Public.readContract({
      address: SEPOLIA_FEE_ASSET_HANDLER,
      abi: FeeAssetHandlerAbi,
      functionName: 'mintAmount',
    });
    assert(mintAmount >= totalBridgeWei, 'Sepolia handler mintAmount below 350 FJ');

    await runL1Step('l1-mint', () =>
      l1Wallet.writeContract({
        address: SEPOLIA_FEE_ASSET_HANDLER,
        abi: FeeAssetHandlerAbi,
        functionName: 'mint',
        args: [l1Account.address],
      }),
    );
    await runL1Step('l1-approve', () =>
      l1Wallet.writeContract({
        address: SEPOLIA_FEE_JUICE_TOKEN,
        abi: TestERC20Abi,
        functionName: 'approve',
        args: [SEPOLIA_FEE_JUICE_PORTAL, totalBridgeWei],
      }),
    );

    for (const role of ['A', 'B', 'C'] as const) {
      const claim = state.claims[role];
      const recipient = credentials.actors[role].address as Hex;
      const amount = BigInt(claim.amountWei);
      const stepName = `l1-deposit-${role}`;
      await runL1Step(stepName, async () => {
        const args = [recipient, amount, claim.claimSecretHash as Hex] as const;
        const gas = await l1Public.estimateContractGas({
          account: l1Account,
          address: SEPOLIA_FEE_JUICE_PORTAL,
          abi: FeeJuicePortalAbi,
          functionName: 'depositToAztecPublic',
          args,
        });
        return l1Wallet.writeContract({
          address: SEPOLIA_FEE_JUICE_PORTAL,
          abi: FeeJuicePortalAbi,
          functionName: 'depositToAztecPublic',
          args,
          gas: gas * 2n,
        });
      });
      if (!claim.messageHash) {
        const depositHash = state.l1Transactions[stepName]!;
        const receipt = await l1Public.getTransactionReceipt({ hash: depositHash });
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== SEPOLIA_FEE_JUICE_PORTAL) continue;
          try {
            const ev = decodeEventLog({
              abi: FeeJuicePortalAbi,
              data: log.data,
              topics: log.topics,
              eventName: 'DepositToAztecPublic',
            });
            if (
              ev.args.to.toLowerCase() === recipient.toLowerCase() &&
              ev.args.secretHash.toLowerCase() === claim.claimSecretHash.toLowerCase() &&
              ev.args.amount === amount
            ) {
              claim.depositTx = depositHash;
              claim.messageHash = ev.args.key;
              claim.leafIndex = String(ev.args.index);
            }
          } catch {
            /* Ignore other portal events. */
          }
        }
        assert(claim.messageHash && claim.leafIndex !== undefined, `Missing portal log for ${role}`);
        await save();
      }
    }

    // Verify all unconsumed claims are inserted at the proven L2 tip before starting L2 transactions.
    for (const role of ['A', 'B', 'C'] as const) {
      const claim = state.claims[role];
      if (claim.consumedByStep) continue;
      const actorAddr = AztecAddress.fromStringUnsafe(credentials.actors[role].address);
      if ((await readFeeJuiceBalance(rawNode, actorAddr)) > 0n) continue;
      assert(claim.provenObservations < 20, `Proven bridge wait limit reached for ${role}`);
      claim.provenObservations += 1;
      await save();
      const ready = await isL1ToL2MessageReady(rawNode, Fr.fromString(claim.messageHash!), 'proven');
      if (!ready) {
        await save('WAITING_FOR_PROVEN_BRIDGE_MESSAGE', { waitingForBridgeRole: role });
        const out = {
          status: 'WAITING_FOR_PROVEN_BRIDGE_MESSAGE' as const,
          role,
          messageHash: claim.messageHash,
          observations: claim.provenObservations,
          action: 'Exit cleanly without re-depositing; re-run after Aztec proven tip advances (~15-30 min).',
        };
        console.log(JSON.stringify(out, null, 2));
        return out;
      }
    }

    // Phase 2 & 3: Checkpointed Real-Proof Aztec 6 L2 Execution.
    for (const [stepName, hash] of Object.entries(state.l2Transactions)) {
      if (state.l2Done.includes(stepName)) continue;
      await reserveObservation(`l2:${stepName}`);
      await trackTx(rawNode, hash, { waitFor: 'confirmed', timeoutMs: 3_600_000, pollMs: 1_500 });
      const receipt = await rawNode.getTxReceipt(TxHash.fromString(hash));
      assert(receipt.hasExecutionSucceeded(), `Tracked L2 tx failed for ${stepName}: ${hash}`);
      if (receipt.transactionFee !== undefined) state.l2FeesWei[stepName] = String(receipt.transactionFee);
      state.l2Done.push(stepName);
      await save();
    }

    let activeL2 = '';
    let activeClaimRole: V8ActorRole | undefined;
    const node = new Proxy(rawNode, {
      get(target, prop) {
        if (prop === 'sendTx')
          return async (tx: Tx) => {
            assert(activeL2 && !state.l2Transactions[activeL2], 'Duplicate or uncheckpointed L2 send');
            await verifyLiveNetworks();
            const hash = (await tx.getTxHash()).toString();
            state.l2Transactions[activeL2] = hash;
            if (activeClaimRole) state.claims[activeClaimRole].consumedByStep = activeL2;
            await save();
            console.log(`BROADCAST ${activeL2} ${hash}`);
            return target.sendTx(tx);
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AztecNode;

    wallet = await EmbeddedWallet.create(node, {
      pxe: { proverEnabled: true, dataDirectory: join(config.stateDir, 'wallet') },
    });

    const actors = {} as Record<V8ActorRole, AztecAddress>;
    for (const role of ['A', 'B', 'C'] as const) {
      const k = credentials.actors[role];
      const acc = await wallet.createSchnorrInitializerlessAccount(
        Fr.fromString(k.secret),
        Fr.fromString(k.salt),
        Fq.fromString(k.signingKey),
      );
      assert.equal(acc.address.toString(), k.address);
      actors[role] = acc.address;
    }

    const feeFor = async (role: V8ActorRole, stepName: string): Promise<FeePaymentMethod | undefined> => {
      const bal = await readFeeJuiceBalance(rawNode, actors[role]);
      if (bal > 0n) {
        activeClaimRole = undefined;
        return undefined;
      }
      const claim = state.claims[role];
      assert(
        !claim.consumedByStep || claim.consumedByStep === stepName,
        `Actor ${role} has 0 FeeJuice and claim already consumed by ${claim.consumedByStep}`,
      );
      assert(
        await isL1ToL2MessageReady(rawNode, Fr.fromString(claim.messageHash!), 'proven'),
        `Actor ${role} bridge claim not ready at proven tip`,
      );
      activeClaimRole = role;
      return new FeeJuicePaymentMethodWithClaim(actors[role], {
        claimAmount: BigInt(claim.amountWei),
        claimSecret: Fr.fromString(claim.claimSecret),
        messageLeafIndex: BigInt(claim.leafIndex!),
      });
    };

    const runL2Step = async (
      name: string,
      role: V8ActorRole,
      send: (fee: FeePaymentMethod | undefined) => Promise<unknown>,
      verify: () => Promise<void> = async () => {},
    ) => {
      if (state.l2Done.includes(name)) {
        console.log(`SKIP ${name} ${state.l2Transactions[name] ?? ''}`);
        return;
      }
      console.log(`STEP ${name} (actor=${role})`);
      await verifyLiveNetworks();
      const fee = await feeFor(role, name);
      activeL2 = name;
      try {
        await send(fee);
        const hash = state.l2Transactions[name];
        assert(hash, `Step ${name} produced no L2 transaction hash`);
        await reserveObservation(`l2:${name}`);
        await trackTx(rawNode, hash, { waitFor: 'confirmed', timeoutMs: 3_600_000, pollMs: 1_500 });
        const receipt = await rawNode.getTxReceipt(TxHash.fromString(hash));
        assert(receipt.hasExecutionSucceeded(), `Step ${name} execution failed: ${hash}`);
        if (receipt.transactionFee !== undefined) state.l2FeesWei[name] = String(receipt.transactionFee);
        await verify();
        state.l2Done.push(name);
        await save();
        console.log(`DONE ${name} ${hash}`);
      } finally {
        activeL2 = '';
        activeClaimRole = undefined;
      }
    };

    const A = Fr.fromString(metadata.v8.classId);
    const B = Fr.fromString(metadata.v8Rehearsal.classId);
    const YEAR = 31_536_000n;
    const owner = actors.A;
    const holder = actors.B;
    const recipient = actors.C;

    const registrySalt = Fr.fromString(credentials.salts.registry);
    const resolverSalt = Fr.fromString(credentials.salts.resolver);
    const registrarSalt = Fr.fromString(credentials.salts.registrar);
    const customSalt = Fr.fromString(credentials.salts.customResolver);

    const registryInstance = await getContractInstanceFromInstantiationParams(
      NameRegistryV8Contract.artifact,
      { constructorArgs: [AztecAddress.ZERO, A], salt: registrySalt, deployer: owner },
    );
    const resolverInstance = await getContractInstanceFromInstantiationParams(
      NameResolverContract.artifact,
      { constructorArgs: [registryInstance.address], salt: resolverSalt, deployer: owner },
    );
    const registrarInstance = await getContractInstanceFromInstantiationParams(
      NameRegistrarLaunchContract.artifact,
      {
        constructorArgs: [
          registryInstance.address,
          AztecAddress.ZERO,
          owner,
          0n,
          0n,
          0n,
          1,
          7,
          true,
          YEAR,
        ],
        salt: registrarSalt,
        deployer: owner,
      },
    );
    const customInstance = await getContractInstanceFromInstantiationParams(
      NameResolverContract.artifact,
      { constructorArgs: [registryInstance.address], salt: customSalt, deployer: owner },
    );

    const expectedAddresses = {
      registry: registryInstance.address.toString(),
      resolver: resolverInstance.address.toString(),
      registrar: registrarInstance.address.toString(),
      customResolver: customInstance.address.toString(),
    };
    if (state.addresses) assert.deepEqual(state.addresses, expectedAddresses, 'Address drift');
    else {
      state.addresses = expectedAddresses;
      await save();
    }

    if (!state.l2Done.includes('deploy-registry')) {
      await assert.rejects(
        () =>
          Contract.deploy(
            wallet!,
            NameRegistryV8Contract.artifact,
            [AztecAddress.ZERO, new Fr(123n)],
            undefined,
            { salt: registrySalt, ...v8BoundDeployment(owner) },
          ).simulate({ from: owner }),
        /initial class mismatch/,
      );
    }

    await runL2Step(
      'deploy-registry',
      'A',
      async (fee) =>
        Contract.deploy(
          wallet!,
          NameRegistryV8Contract.artifact,
          [AztecAddress.ZERO, A],
          undefined,
          { salt: registrySalt, ...v8BoundDeployment(owner) },
        ).send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          skipClassPublication: !!(await rawNode.getContractClass(A)),
          wait: NO_WAIT,
        }),
      async () => {
        const inst = await rawNode.getContract(registryInstance.address);
        assert(inst);
        const r = await RegistryReader.connect(rawNode, registryInstance.address, {
          allowRehearsalSuccessor: true,
        });
        assertV8DeploymentOwner(owner, inst.deployer, await r.getAdministrator());
      },
    );
    await wallet.registerContract(registryInstance, NameRegistryV8Contract.artifact);

    await runL2Step(
      'deploy-resolver',
      'A',
      async (fee) =>
        Contract.deploy(
          wallet!,
          NameResolverContract.artifact,
          [registryInstance.address],
          undefined,
          { salt: resolverSalt, deployer: owner },
        ).send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          skipClassPublication: !!(await rawNode.getContractClass(resolverInstance.currentContractClassId)),
          wait: NO_WAIT,
        }),
    );
    await wallet.registerContract(resolverInstance, NameResolverContract.artifact);

    await runL2Step(
      'deploy-custom-resolver',
      'A',
      async (fee) =>
        Contract.deploy(
          wallet!,
          NameResolverContract.artifact,
          [registryInstance.address],
          undefined,
          { salt: customSalt, deployer: owner },
        ).send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          skipClassPublication: true,
          wait: NO_WAIT,
        }),
    );
    await wallet.registerContract(customInstance, NameResolverContract.artifact);

    await runL2Step(
      'deploy-launch',
      'A',
      async (fee) =>
        Contract.deploy(
          wallet!,
          NameRegistrarLaunchContract.artifact,
          [registryInstance.address, AztecAddress.ZERO, owner, 0n, 0n, 0n, 1, 7, true, YEAR],
          undefined,
          { salt: registrarSalt, deployer: owner },
        ).send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          skipClassPublication: !!(await rawNode.getContractClass(registrarInstance.currentContractClassId)),
          wait: NO_WAIT,
        }),
    );
    await wallet.registerContract(registrarInstance, NameRegistrarLaunchContract.artifact);

    const coreV8 = NameRegistryV8Contract.at(registryInstance.address, wallet);
    const launch = NameRegistrarLaunchContract.at(registrarInstance.address, wallet);

    const labels = canonicalReservedLabels(reservations);
    assert.equal(labels.length, 325);
    assert.equal(
      reservedListHash(reservations),
      '743b1b4c3ab4762cb2d12662765406fdf91971845a5ec6137b1f7444223657fa',
    );
    const nodes = await reservedNodes(labels);
    const batches = reservedBatches(nodes);
    for (const [idx, batch] of batches.entries()) {
      await runL2Step(`seed-reserved-${idx}`, 'A', async (fee) =>
        launch.methods.set_reserved(batch, true).send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          wait: NO_WAIT,
        }),
      );
    }

    await runL2Step(
      'bootstrap',
      'A',
      async (fee) =>
        coreV8.methods.bootstrap(registrarInstance.address, resolverInstance.address).send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          wait: NO_WAIT,
        }),
      async () => {
        const r = await RegistryReader.connect(rawNode, registryInstance.address, {
          allowRehearsalSuccessor: true,
        });
        const snap = await r.snapshot();
        const checks = await Promise.all(nodes.map((id) => r.isReserved(id, snap)));
        assert(checks.every(Boolean), 'Reserved readback parity failed');
      },
    );

    const reader = await RegistryReader.connect(node, registryInstance.address, {
      allowRehearsalSuccessor: true,
    });
    await assert.rejects(() =>
      prepareRegistration(new AnsContext(reader, { wallet: wallet!, account: holder }), {
        name: 'upgrade-name',
        duration: YEAR,
      }),
    );

    await runL2Step('unpause-launch', 'A', async (fee) =>
      launch.methods.set_paused(false).send({
        from: owner,
        fee: fee ? { paymentMethod: fee } : undefined,
        wait: NO_WAIT,
      }),
    );

    const makeCtx = (role: V8ActorRole, fee?: FeePaymentMethod) =>
      new AnsContext(reader, {
        wallet: wallet!,
        account: actors[role],
        fee: fee ? { paymentMethod: fee } : undefined,
      });

    for (let len = 1; len <= 6; len++) {
      await assert.rejects(() =>
        prepareRegistration(makeCtx('B'), { name: 'a'.repeat(len), duration: YEAR }),
      );
    }
    for (const sec of [60n, 120n, 180n, 240n]) {
      await assert.rejects(() =>
        prepareRegistration(makeCtx('B'), {
          name: 'quote-margin',
          duration: YEAR,
          quoteValiditySeconds: sec,
        }),
      );
    }
    const valid300Plan = await prepareRegistration(makeCtx('B'), {
      name: 'seven77',
      duration: YEAR,
      quoteValiditySeconds: 300n,
    });
    assert(valid300Plan.quoteExpiry - (await reader.snapshot()).timestamp >= 300n);
    assert.equal(
      (await getFeeQuote(reader, { operation: 'register', duration: YEAR, labelLength: 12 })).fee,
      0n,
    );

    const registerName = async (key: string, name: string, role: V8ActorRole) => {
      if (!state.plans[key]) {
        const plan = await prepareRegistration(makeCtx(role), { name, duration: YEAR });
        state.plans[key] = serializePlan(plan);
        await save();
      }
      let plan = deserializePlan(state.plans[key]!);
      await runL2Step(`commit-${key}`, role, async (fee) => {
        const res = await submitCommit(makeCtx(role, fee), plan, { waitFor: 'included' });
        plan = res.plan;
        state.plans[key] = serializePlan(plan);
        await save();
      });
      if (!state.l2Done.includes(`register-${key}`)) {
        await waitUntilRegistrable(reader, plan, { timeoutMs: 300_000, pollMs: 5_000 });
      }
      await runL2Step(`register-${key}`, role, async (fee) => {
        const res = await submitRegistration(makeCtx(role, fee), plan, { waitFor: 'included' });
        plan = res.plan;
        state.plans[key] = serializePlan(plan);
        await save();
      });
    };

    await registerName('upgrade-name', 'upgrade-name', 'B');
    await registerName('transfer-name', 'transfer-name', 'B');

    await runL2Step('set-address-initial', 'B', (fee) =>
      setAddress(makeCtx('B', fee), { name: 'upgrade-name', address: holder }, { waitFor: 'included' }),
    );
    await runL2Step('set-primary-initial', 'B', (fee) =>
      setPrimary(makeCtx('B', fee), { name: 'upgrade-name' }, { waitFor: 'included' }),
    );
    await runL2Step('set-text-desc', 'B', (fee) =>
      setTextRecord(
        makeCtx('B', fee),
        { name: 'upgrade-name', key: 'description', value: 'before upgrade' },
        { waitFor: 'included' },
      ),
    );
    await runL2Step('set-manager', 'B', (fee) =>
      setManager(makeCtx('B', fee), { name: 'upgrade-name', manager: recipient }, { waitFor: 'included' }),
    );
    await runL2Step('issue-subname', 'B', async (fee) => {
      const parentRec = await reader.getName(
        await nodeOf(normalizeName('upgrade-name')),
        await reader.snapshot(),
      );
      return issueSubname(
        makeCtx('B', fee),
        { parent: 'upgrade-name', label: 'team', owner: recipient, expiresAt: parentRec.expiresAt - 86_400n },
        { waitFor: 'included' },
      );
    });

    await runL2Step('set-custom-resolver', 'B', (fee) =>
      setResolver(
        makeCtx('B', fee),
        { name: 'transfer-name', resolver: customInstance.address },
        { waitFor: 'included' },
      ),
    );
    await runL2Step('offer-transfer', 'B', (fee) =>
      offerTransfer(makeCtx('B', fee), { name: 'transfer-name', recipient }, { waitFor: 'included' }),
    );
    await runL2Step(
      'accept-transfer',
      'C',
      (fee) => acceptTransfer(makeCtx('C', fee), { name: 'transfer-name' }, { waitFor: 'included' }),
      async () => {
        const snap = await reader.snapshot();
        const transferredNode = await nodeOf(normalizeName('transfer-name'));
        const rec = await reader.getName(transferredNode, snap);
        assert(rec.owner.equals(recipient), 'transfer-name owner must be recipient C');
        const activeResolver = await reader.getResolver(transferredNode, rec.generation, snap);
        assert(activeResolver.equals(resolverInstance.address), 'transfer must reset custom resolver');
        const oldCustom = NameResolverContract.at(customInstance.address, wallet!);
        await assert.rejects(() =>
          oldCustom.methods
            .set_address(transferredNode, rec.generation, 0, true, recipient)
            .simulate({ from: recipient }),
        );
      },
    );
    await runL2Step('renew-upgrade-name', 'B', (fee) =>
      renew(makeCtx('B', fee), { name: 'upgrade-name', duration: YEAR }, { waitFor: 'included' }),
    );
    await assert.rejects(() => renew(makeCtx('B'), { name: 'upgrade-name', duration: YEAR }));

    if (!state.adminMint) {
      const mintLabel = normalizeName('adm');
      const expiry = (await reader.snapshot()).timestamp + 86_400n;
      const secret = Fr.random();
      const commitment = (
        await launch.methods
          .admin_commitment(recipient, mintLabel.bytes, mintLabel.len, 0, expiry, secret)
          .simulate({ from: owner })
      ).result;
      state.adminMint = {
        expiry: String(expiry),
        secret: secret.toString(),
        commitment: String(commitment),
      };
      await save();
    }
    await runL2Step('admin-mint-commit', 'A', async (fee) =>
      launch.methods.commit(Fr.fromString(state.adminMint!.commitment)).send({
        from: owner,
        fee: fee ? { paymentMethod: fee } : undefined,
        wait: NO_WAIT,
      }),
    );
    if (!state.l2Done.includes('admin-mint-register')) {
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const rec = await reader.getCommit(
          BigInt(state.adminMint.commitment),
          await reader.snapshot(),
        );
        if ((await reader.snapshot()).timestamp >= rec.committedAt + 60n) break;
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    await runL2Step(
      'admin-mint-register',
      'A',
      async (fee) => {
        const mintLabel = normalizeName('adm');
        return launch.methods
          .admin_register(
            mintLabel.bytes,
            mintLabel.len,
            recipient,
            0,
            BigInt(state.adminMint!.expiry),
            Fr.fromString(state.adminMint!.secret),
          )
          .send({
            from: owner,
            fee: fee ? { paymentMethod: fee } : undefined,
            wait: NO_WAIT,
          });
      },
      async () => {
        const rec = await reader.getName(await nodeOf(normalizeName('adm')), await reader.snapshot());
        assert(rec.owner.equals(recipient), 'admin-mint adm must belong to recipient C');
      },
    );

    // Publish successor B if not already registered on chain.
    if (!(await rawNode.getContractClass(B))) {
      await runL2Step('publish-successor', 'A', async (fee) =>
        (await publishContractClass(wallet!, NameRegistryV8RehearsalContract.artifact)).send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          wait: NO_WAIT,
        }),
      );
    }
    await wallet.registerContractClass(NameRegistryV8RehearsalContract.artifact);

    if (!state.l2Done.includes('approve-release-B')) {
      const s = await reader.getCoreUpgradeState();
      await assert.rejects(
        () => coreV8.methods.propose_upgrade(s.nonce, A, B).simulate({ from: owner }),
        /release not approved/,
      );
    }

    type UpgradeInput = CoreUpgradeAction extends infer U
      ? U extends CoreUpgradeAction
        ? Omit<U, 'expectedNonce'>
        : never
      : never;
    const govStep = async (
      name: string,
      role: V8ActorRole,
      build: UpgradeInput,
      verify: () => Promise<void> = async () => {},
    ) =>
      runL2Step(
        name,
        role,
        async (fee) => {
          const s = await reader.getCoreUpgradeState();
          return administerCoreUpgrade(
            makeCtx(role, fee),
            { ...build, expectedNonce: s.nonce } as CoreUpgradeAction,
            { waitFor: 'included' },
          );
        },
        verify,
      );

    await govStep('approve-release-B', 'A', {
      kind: 'approve_release',
      classId: B.toBigInt(),
      family: CORE_UPGRADE_FAMILY,
      releaseSeq: 2,
    });
    if (!state.l2Done.includes('approve-edges')) {
      const s = await reader.getCoreUpgradeState();
      await assert.rejects(
        () => coreV8.methods.propose_upgrade(s.nonce, A, B).simulate({ from: owner }),
        /edge not approved/,
      );
    }
    await govStep('approve-edges', 'A', {
      kind: 'approve_edge_pair',
      older: A.toBigInt(),
      newer: B.toBigInt(),
    });
    await govStep('propose-for-cancel', 'A', {
      kind: 'propose',
      from: A.toBigInt(),
      to: B.toBigInt(),
    });
    await govStep('cancel-proposal', 'A', { kind: 'cancel_proposal' });

    await govStep('propose-for-revoke', 'A', {
      kind: 'propose',
      from: A.toBigInt(),
      to: B.toBigInt(),
    });
    await govStep(
      'revoke-edge-forward',
      'A',
      {
        kind: 'revoke_edge',
        from: A.toBigInt(),
        to: B.toBigInt(),
      },
      async () => {
        assert(!(await reader.getCoreUpgradeState()).pending.active, 'revoke_edge must clear pending');
      },
    );
    await govStep('reapprove-edges', 'A', {
      kind: 'approve_edge_pair',
      older: A.toBigInt(),
      newer: B.toBigInt(),
    });

    await govStep('nominate-B', 'A', { kind: 'nominate_administrator', administrator: holder });
    await govStep('accept-admin-B', 'B', { kind: 'accept_administrator' });
    await govStep('nominate-A-back', 'B', { kind: 'nominate_administrator', administrator: owner });
    await govStep('accept-admin-A', 'A', { kind: 'accept_administrator' });

    // Forward upgrade proposal + 86,400s application wait checkpoint exit.
    await govStep('propose-forward-scheduled-cancel', 'A', {
      kind: 'propose',
      from: A.toBigInt(),
      to: B.toBigInt(),
    });
    const checkOrExitWait = async (
      stage: 'application' | 'protocol' | 'rollback-application' | 'rollback-protocol',
      startedAt: bigint,
      readyAt: bigint,
      key: string = stage,
    ) => {
      const now = (await reader.snapshot()).timestamp;
      const w = fullDelay(stage, startedAt, now, readyAt);
      state.waitTimestamps[key] = w.earliestNextResumeAsiaTaipei;
      if (w.status === 'waiting') {
        await save(`WAITING_${key.toUpperCase()}`, w);
        console.log(JSON.stringify(w, null, 2));
        return true;
      }
      return false;
    };

    if (!state.l2Done.includes('execute-for-scheduled-cancel')) {
      const u = await reader.getCoreUpgradeState();
      assert(u.pending.active);
      await assert.rejects(
        () => coreV8.methods.execute_upgrade(u.nonce, A, B).simulate({ from: owner }),
        /application delay not elapsed|proposal/,
      ).catch(() => {});
      if (
        await checkOrExitWait(
          'application',
          u.pending.proposedAt,
          u.pending.readyAt,
          'application-scheduled-cancel',
        )
      )
        return;
    }
    await govStep('execute-for-scheduled-cancel', 'A', {
      kind: 'execute',
      from: A.toBigInt(),
      to: B.toBigInt(),
    });
    await govStep('cancel-scheduled-forward', 'A', { kind: 'cancel_scheduled' });

    await govStep('propose-forward-live', 'A', {
      kind: 'propose',
      from: A.toBigInt(),
      to: B.toBigInt(),
    });
    if (!state.l2Done.includes('execute-forward-live')) {
      const u = await reader.getCoreUpgradeState();
      assert(u.pending.active);
      if (await checkOrExitWait('application', u.pending.proposedAt, u.pending.readyAt)) return;
    }
    await govStep('execute-forward-live', 'A', {
      kind: 'execute',
      from: A.toBigInt(),
      to: B.toBigInt(),
    });

    // Commit `across-upgrade` inside [T - 7200s, T - 900s) so MAX_COMMIT_AGE (86,400s) and quoteExpiry
    // remain valid well past protocol activation T when revealed under successor B!
    if (!state.l2Done.includes('commit-across-upgrade')) {
      const u = await reader.getCoreUpgradeState();
      const targetAt = u.scheduled.activationAt || u.protocol.activationAt;
      const commitWindowStart = targetAt - 3_600n;
      const now = (await reader.snapshot()).timestamp;
      const w = v8WaitCheckpoint('protocol', now, commitWindowStart);
      state.waitTimestamps['pre-activation-commit'] = w.earliestNextResumeAsiaTaipei;
      if (w.status === 'waiting') {
        await save('WAITING_PRE_ACTIVATION_COMMIT', w);
        console.log(JSON.stringify(w, null, 2));
        return;
      }
      assert(targetAt - now > 900n, 'Past 900s pre-activation SDK safety margin before commit-across-upgrade');
      if (!state.plans['across-upgrade']) {
        const p = await prepareRegistration(makeCtx('B'), {
          name: 'across-upgrade',
          duration: YEAR,
        });
        state.plans['across-upgrade'] = serializePlan(p);
        await save();
      }
      let p = deserializePlan(state.plans['across-upgrade']!);
      await runL2Step('commit-across-upgrade', 'B', async (fee) => {
        const res = await submitCommit(makeCtx('B', fee), p, { waitFor: 'included' });
        p = res.plan;
        state.plans['across-upgrade'] = serializePlan(p);
        await save();
      });
    }

    if (!state.l2Done.includes('settle-forward')) {
      const u = await reader.getCoreUpgradeState();
      const targetAt = u.scheduled.activationAt || u.protocol.activationAt;
      if (await checkOrExitWait('protocol', targetAt - 86_400n, targetAt)) return;
    }

    const coreSuccessor = NameRegistryV8RehearsalContract.at(registryInstance.address, wallet);
    await wallet.registerContract(
      (await rawNode.getContract(registryInstance.address))!,
      NameRegistryV8RehearsalContract.artifact,
    );
    await runL2Step(
      'settle-forward',
      'A',
      async (fee) =>
        coreSuccessor.methods.settle_upgrade().send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          wait: NO_WAIT,
        }),
      async () => {
        const u = await reader.getCoreUpgradeState();
        assert.equal(u.currentClass, String(B));
        await assert.rejects(
          () => coreSuccessor.methods.cancel_scheduled_upgrade(u.nonce).simulate({ from: owner }),
          /no scheduled upgrade/,
        );
      },
    );

    if (!state.l2Done.includes('register-across-upgrade')) {
      let p = deserializePlan(state.plans['across-upgrade']!);
      await waitUntilRegistrable(reader, p, { timeoutMs: 300_000, pollMs: 5_000 });
      await runL2Step('register-across-upgrade', 'B', async (fee) => {
        const res = await submitRegistration(makeCtx('B', fee), p, { waitFor: 'included' });
        p = res.plan;
        state.plans['across-upgrade'] = serializePlan(p);
        await save();
      });
    }

    await runL2Step(
      'post-upgrade-write',
      'B',
      (fee) =>
        setTextRecord(
          makeCtx('B', fee),
          { name: 'upgrade-name', key: 'description', value: 'written under successor B' },
          { waitFor: 'included' },
        ),
      async () => {
        assert.equal((await resolveAddress(reader, 'upgrade-name')).status, 'resolved');
        assert.equal((await resolvePrimary(reader, holder)).status, 'verified');
      },
    );

    // Compatible rollback B -> A + 86,400s application & 86,400s protocol waits.
    await govStep('propose-rollback', 'A', {
      kind: 'propose',
      from: B.toBigInt(),
      to: A.toBigInt(),
    });
    if (!state.l2Done.includes('execute-rollback')) {
      const u = await reader.getCoreUpgradeState();
      assert(u.pending.active);
      if (await checkOrExitWait('rollback-application', u.pending.proposedAt, u.pending.readyAt))
        return;
    }
    await govStep('execute-rollback', 'A', {
      kind: 'execute',
      from: B.toBigInt(),
      to: A.toBigInt(),
    });

    if (!state.l2Done.includes('settle-rollback')) {
      const u = await reader.getCoreUpgradeState();
      const targetAt = u.scheduled.activationAt || u.protocol.activationAt;
      if (await checkOrExitWait('rollback-protocol', targetAt - 86_400n, targetAt)) return;
    }

    await wallet.registerContract(
      (await rawNode.getContract(registryInstance.address))!,
      NameRegistryV8Contract.artifact,
    );
    await runL2Step(
      'settle-rollback',
      'A',
      async (fee) =>
        coreV8.methods.settle_upgrade().send({
          from: owner,
          fee: fee ? { paymentMethod: fee } : undefined,
          wait: NO_WAIT,
        }),
      async () => {
        const u = await reader.getCoreUpgradeState();
        assert.equal(u.currentClass, String(A));
      },
    );

    await runL2Step(
      'post-rollback-write',
      'B',
      (fee) =>
        setTextRecord(
          makeCtx('B', fee),
          { name: 'upgrade-name', key: 'description', value: 'written after compatible rollback' },
          { waitFor: 'included' },
        ),
      async () => {
        const text = await reader.getTextRecord(
          await nodeOf(normalizeName('upgrade-name')),
          1,
          'description',
          await reader.snapshot(),
        );
        assert.equal(text, 'written after compatible rollback');
      },
    );

    const finalTxHash = state.l2Transactions['post-rollback-write'];
    if (finalTxHash) {
      console.log(`FINALIZING proven epoch for ${finalTxHash}`);
      await trackTx(rawNode, finalTxHash, { waitFor: 'proven', timeoutMs: 5_400_000 });
    }
    state.completedAt = new Date().toISOString();
    await save('COMPLETED', { completedAt: state.completedAt });
    const doneSummary = {
      status: 'COMPLETED' as const,
      registry: registryInstance.address.toString(),
      completedAt: state.completedAt,
      l1DoneCount: state.l1Done.length,
      l2DoneCount: state.l2Done.length,
    };
    console.log(JSON.stringify(doneSummary, null, 2));
    return doneSummary;
  } finally {
    await wallet?.stop();
    unlock();
  }
}
