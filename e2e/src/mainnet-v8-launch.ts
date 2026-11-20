/**
 * Isolated production operator for Fog Names V8 Free Launch on Aztec Mainnet.
 * - `--init-accounts --state-dir /var/lib/<signer>/mainnet-v8-launch-YYYYMMDD`
 *   offline-generates fresh isolated credentials, deterministic V8/Resolver/Launch addresses,
 *   and precomputed `operatorBalanceSlot`, writing secrets only to `credentials.json` (0600).
 * - `--bridge ...` optionally bridges L1 $AZTEC via Mainnet FeeJuicePortal without mint handlers.
 * - Default `--dry-run` performs read-only mainnet preflight without opening `credentials.json`.
 * - `--send --confirm <exact>` executes checkpointed, single-shot real-proof V8 deployment,
 *   seeds and verifies all 325 reserved labels, bootstraps modules (`initialPaused: true`),
 *   and writes a validated canonical `fog-deployment-v6/1` (`protocol: 8`) manifest.
 * - `--admin-action unpause|pause|minimum|mint` previews or executes checkpointed post-deploy
 *   Launch Registrar administration under the isolated signer.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  http,
  keccak256,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { FeeJuicePortalAbi } from '@aztec-foundation/l1-artifacts/FeeJuicePortalAbi';
import { TestERC20Abi } from '@aztec-foundation/l1-artifacts/TestERC20Abi';
import {
  SchnorrInitializerlessAccountContractArtifact,
  getSchnorrInitializerlessAccountContractAddress,
} from '@aztec-labs/accounts/schnorr';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import {
  BatchCall,
  Contract,
  NO_WAIT,
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from '@aztec-labs/aztec.js/contracts';
import { FeeJuicePaymentMethodWithClaim, type FeePaymentMethod } from '@aztec-labs/aztec.js/fee';
import { BlockNumber, Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { TxHash } from '@aztec-labs/aztec.js/tx';
import { setLogLevel } from '@aztec-labs/foundation/log';
import { ManaUsageEstimate } from '@aztec-labs/stdlib/gas';
import { computeSecretHash, deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import type { Tx } from '@aztec-labs/stdlib/tx';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import {
  NAME_SUFFIX,
  RegistryReader,
  SECONDS_PER_YEAR,
  assertRegistrableLabel,
  hashWithSeparator,
  nodeOf,
  normalizeName,
  registerCommitment,
  trackTx,
} from 'fog-sdk';
import { NameRegistrarLaunchContract, NameResolverContract } from 'fog-sdk/contracts';
import { NameRegistryV8Contract } from 'fog-sdk/contracts/v8';
import metadata from '../../sdk/src/artifacts/modular-metadata.json' with { type: 'json' };
import reservations from '../../deployments/reserved-labels.json' with { type: 'json' };
import { REPO, ZERO, within } from './deploy-v6-plan.js';
import { readFeeJuiceBalance } from './fee-juice-payment.js';
import {
  canonicalReservedLabels,
  reservedListHash,
  reservedNodes,
} from './launch-policy.js';
import { acquireTestnetLock } from './testnet-lock.js';
import { savePrivateJson } from './testnet-v6-e2e-state.js';
import { createRateLimitedAztecNode } from './testnet-v8-upgrade-rehearsal.js';
import { V6_PROFILES, assertV6FeeJuice, assertV6Network } from './v6-network.js';
import type { SignerIdentity } from './v8-account-generator.js';
import { assertV8DeploymentOwner, v8BoundDeployment } from './v8-deployment.js';
import { V8_RESERVED_HASH } from './v8-rehearsal-plan.js';

const { isPlaceholderAdmin } = createRequire(import.meta.url)(
  '../../scripts/mainnet-readiness.mjs',
) as { isPlaceholderAdmin: (admin: unknown) => boolean };
const { v6ManifestProblems } = createRequire(import.meta.url)(
  '../../scripts/deployment-config.mjs',
) as {
  v6ManifestProblems: (m: unknown, options?: { expectNetwork?: string }) => string[];
};

export const ALLOWED_MAINNET_SIGNER_USERS = new Set(['fog-signer', 'ans-signer']);
export const MAINNET_V8_CREDENTIALS_SCHEMA = 'fog-mainnet-v8-credentials/1';
export const MAINNET_V8_PUBLIC_SCHEMA = 'fog-mainnet-v8-public/1';
export const MAINNET_V8_STATE_SCHEMA = 'fog-mainnet-v8-state/1';
export const MAINNET_V8_BRIDGE_SCHEMA = 'fog-mainnet-v8-bridge/1';
export const MAINNET_V8_ADMIN_STATE_SCHEMA = 'fog-mainnet-v8-admin-state/1';

export const MAINNET_ROLLUP = V6_PROFILES.mainnet.rollup;
export const MAINNET_FEE_JUICE_PORTAL = V6_PROFILES.mainnet.feeJuicePortal as Hex;
export const MAINNET_FEE_JUICE_TOKEN = V6_PROFILES.mainnet.l1FeeJuice as Hex;
export const DEFAULT_MAX_MAINNET_FJ = 150n;
export const DEFAULT_MAX_MAINNET_L2_GAS_PRICE = 15_000_000_000_000n;
export const DEFAULT_MAX_MAINNET_L1_ETH_WEI = 50_000_000_000_000_000n; // 0.05 ETH
export const MAINNET_RENEW_HORIZON = 31_536_000n;
export const ESTIMATED_MAINNET_DEPLOY_L2_GAS = 19_913_000n;

/**
 * Pack reserved-node writes into Batched transactions of up to 60 public storage writes
 * (staying within AVM MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX=63 and APP_MAX_CALLS=5),
 * cutting L2 transaction fixed overhead from 11 txs down to 6 txs for 325 labels.
 */
export function mainnetReservedCallGroups(nodes: bigint[], maxNodesPerTx = 60): bigint[][][] {
  assert(
    Number.isInteger(maxNodesPerTx) && maxNodesPerTx >= 1 && maxNodesPerTx <= 62,
    'maxNodesPerTx must be between 1 and 62',
  );
  const groups: bigint[][][] = [];
  for (let i = 0; i < nodes.length; i += maxNodesPerTx) {
    const chunk = nodes.slice(i, i + maxNodesPerTx);
    const callsCount = Math.ceil(chunk.length / 32);
    assert(callsCount <= 5, 'Too many calls per account entrypoint transaction');
    const perCall = Math.ceil(chunk.length / callsCount);
    const calls: bigint[][] = [];
    for (let j = 0; j < chunk.length; j += perCall) {
      const part = chunk.slice(j, j + perCall);
      calls.push([...part, ...Array<bigint>(32 - part.length).fill(0n)]);
    }
    groups.push(calls);
  }
  return groups;
}

export function stepAdmissionGasLimit(stepName: string): bigint {
  if (stepName.startsWith('seed-reserved-')) return 3_300_000n;
  if (stepName.startsWith('deploy-')) return 2_200_000n;
  return 1_200_000n;
}

export type MainnetV8Credentials = {
  schema: typeof MAINNET_V8_CREDENTIALS_SCHEMA;
  network: 'mainnet';
  toolchainVersion: '6.0.0';
  accountClassId: string;
  admin: {
    address: string;
    secret: string;
    salt: string;
    signingKey: string;
  };
  l1Funding: {
    address: Hex;
    privateKey: Hex;
  };
  salts: {
    registry: string;
    resolver: string;
    registrar: string;
  };
  launchPolicy: {
    priceVersion: number;
    minPublicLength: number;
    maxRenewAhead: string;
  };
};

export type MainnetV8PublicAccounts = {
  schema: typeof MAINNET_V8_PUBLIC_SCHEMA;
  network: 'mainnet';
  toolchainVersion: '6.0.0';
  signerUser: string;
  accountClassId: string;
  admin: string;
  operatorBalanceSlot: string;
  l1FundingAddress: Hex;
  addresses: {
    registry: string;
    resolver: string;
    registrar: string;
  };
  classIds: {
    registry: string;
    resolver: string;
    registrar: string;
    token: string;
  };
  launchPolicy: MainnetV8Credentials['launchPolicy'];
  reservedListHash: string;
  createdAt: string;
};

export type MainnetBridgeState = {
  schema: typeof MAINNET_V8_BRIDGE_SCHEMA;
  confirmation: string;
  recipient: string;
  l1Address: Hex;
  amountWei: string;
  claimSecret: string;
  claimSecretHash: string;
  l1Transactions: Record<string, Hex>;
  l1Done: string[];
  l1FeesWei: Record<string, string>;
  observations: Record<string, number>;
  depositTx?: Hex;
  messageHash?: Hex;
  leafIndex?: string;
  provenObservations: number;
  consumedByStep?: string;
};

export type MainnetV8RunState = {
  schema: typeof MAINNET_V8_STATE_SCHEMA;
  confirmation: string;
  domain: string;
  nodeUrl: string;
  manifestOut: string;
  maxFeeJuiceWei: string;
  maxL2FeePerGas: string;
  addresses: {
    admin: string;
    registry: string;
    resolver: string;
    registrar: string;
  };
  l2Transactions: Record<string, string>;
  l2Done: string[];
  l2FeesWei: Record<string, string>;
  observations: Record<string, number>;
  reservedReadbackVerified?: boolean;
  completedAt?: string;
};

export type AdminCliAction =
  | { kind: 'unpause' }
  | { kind: 'pause' }
  | { kind: 'minimum'; length: number }
  | { kind: 'mint'; label: string; recipient: string };

export function currentMainnetSignerIdentity(): SignerIdentity {
  const username = userInfo().username;
  return {
    uid: process.getuid!(),
    username,
    signerRoot: `/var/lib/${username}`,
  };
}

function cleanHttpsUrl(raw: string | undefined, label: string): string {
  assert(raw, `${label} is required`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  assert(
    u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash,
    `${label} must be clean HTTPS without credentials, query or fragment`,
  );
  return raw;
}

function normalizeDomainUrl(raw: string | undefined): string {
  assert(raw, '--domain is required for mainnet launch');
  const candidate = raw.startsWith('https://') ? raw : `https://${raw}`;
  const u = new URL(cleanHttpsUrl(candidate, '--domain'));
  assert(
    u.pathname === '/' && u.hostname.includes('.') && !/^(localhost|127\.)/i.test(u.hostname),
    '--domain must be a public root HTTPS origin',
  );
  return u.origin;
}

export async function assertMainnetSignerDirectory(
  stateDir: string,
  identity: SignerIdentity = currentMainnetSignerIdentity(),
  requireExisting = false,
) {
  assert(identity.uid > 0, 'Mainnet signer refuses root execution (uid 0)');
  assert(
    ALLOWED_MAINNET_SIGNER_USERS.has(identity.username),
    `Mainnet signer requires dedicated Linux user (${[...ALLOWED_MAINNET_SIGNER_USERS].join(' or ')})`,
  );
  assert(
    isAbsolute(stateDir) && resolve(stateDir) === stateDir,
    'Canonical absolute state directory required',
  );
  assert(!within(REPO, stateDir), 'State directory must remain outside repository');
  assert(!stateDir.startsWith('/home/grokbot/'), 'Shared agent home directory refused');
  const root = resolve(identity.signerRoot ?? `/var/lib/${identity.username}`);
  const rel = relative(root, stateDir);
  assert(
    rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/'),
    `State directory must be a direct child of ${root}`,
  );
  assert(
    /^mainnet-v8-launch-\d{8}(?:-[a-z0-9]+)?$/.test(basename(stateDir)),
    'Dated mainnet-v8-launch-YYYYMMDD directory required',
  );

  let cursor = parse(root).root;
  for (const part of relative(cursor, root).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    const s = await lstat(cursor);
    assert(s.isDirectory() && !s.isSymbolicLink(), 'Symlink ancestor refused');
  }
  assert.equal(await realpath(root), root, 'Symlink signer root refused');
  const rootStat = await lstat(root);
  assert.equal(rootStat.uid, identity.uid, 'Signer root must be owned by isolated signer');
  assert.equal(rootStat.mode & 0o777, 0o700, 'Signer root must be mode 0700');

  if (requireExisting) {
    const dirStat = await lstat(stateDir);
    assert(
      dirStat.isDirectory() &&
        !dirStat.isSymbolicLink() &&
        dirStat.uid === identity.uid &&
        (dirStat.mode & 0o777) === 0o700,
      'Existing mainnet launch directory must be owned regular mode 0700',
    );
  }
}

async function writeExclusiveSynced(path: string, content: string, mode: number) {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.chmod(mode);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function deriveMainnetSuiteInstances(
  admin: AztecAddress,
  salts: MainnetV8Credentials['salts'],
  policy: { priceVersion: number; minPublicLength: number },
) {
  assert(!admin.isZero() && !isPlaceholderAdmin(admin.toString()), 'Valid non-placeholder admin required');
  const v8ClassId = Fr.fromString(metadata.v8.classId);
  const registry = await getContractInstanceFromInstantiationParams(
    NameRegistryV8Contract.artifact,
    {
      constructorArgs: [AztecAddress.ZERO, v8ClassId],
      salt: Fr.fromString(salts.registry),
      ...v8BoundDeployment(admin),
    },
  );
  const resolver = await getContractInstanceFromInstantiationParams(NameResolverContract.artifact, {
    constructorArgs: [registry.address],
    salt: Fr.fromString(salts.resolver),
    deployer: admin,
  });
  const registrar = await getContractInstanceFromInstantiationParams(
    NameRegistrarLaunchContract.artifact,
    {
      constructorArgs: [
        registry.address,
        AztecAddress.ZERO,
        AztecAddress.ZERO,
        0n,
        0n,
        0n,
        policy.priceVersion,
        policy.minPublicLength,
        true,
        MAINNET_RENEW_HORIZON,
      ],
      salt: Fr.fromString(salts.registrar),
      deployer: admin,
    },
  );
  assert.equal(registry.currentContractClassId.toString(), metadata.v8.classId);
  assert.equal(resolver.currentContractClassId.toString(), metadata.resolver.classId);
  assert.equal(registrar.currentContractClassId.toString(), metadata.registrarLaunch.classId);
  return { registry, resolver, registrar };
}

export async function initMainnetV8Accounts(
  stateDir: string,
  options: {
    identity?: SignerIdentity;
    priceVersion?: number;
    minPublicLength?: number;
    now?: () => Date;
  } = {},
) {
  assert(
    !Object.keys(process.env).some((k) => /(?:NODE|RPC|ANVIL).*URL/i.test(k) && process.env[k]),
    'Offline account generator refuses node/RPC URL environment variables',
  );
  const priceVersion = options.priceVersion ?? 1;
  const minPublicLength = options.minPublicLength ?? 7;
  assert(
    Number.isSafeInteger(priceVersion) && priceVersion > 0 && priceVersion <= 4294967295,
    'priceVersion must be a positive u32 integer',
  );
  assert.equal(
    minPublicLength,
    reservations.minLength,
    'minPublicLength must match deployments/reserved-labels.json minLength',
  );
  const labels = canonicalReservedLabels(reservations);
  assert.equal(labels.length, 325);
  assert.equal(reservedListHash(labels), V8_RESERVED_HASH);

  const identity = options.identity ?? currentMainnetSignerIdentity();
  await assertMainnetSignerDirectory(stateDir, identity, false);
  await mkdir(stateDir, { mode: 0o700 });

  const accountClassId = (
    await getContractClassFromArtifact(SchnorrInitializerlessAccountContractArtifact)
  ).id.toString();
  const secret = Fr.random();
  const salt = Fr.random();
  const signingKey = Fq.random();
  const adminAddr = await getSchnorrInitializerlessAccountContractAddress(signingKey, salt, secret);
  assert(!adminAddr.isZero() && !isPlaceholderAdmin(adminAddr.toString()));

  const operatorBalanceSlot = (await deriveStorageSlotInMap(new Fr(1), adminAddr)).toString();
  const l1PrivateKey = generatePrivateKey();
  const l1Address = privateKeyToAccount(l1PrivateKey).address;
  const salts = {
    registry: Fr.random().toString(),
    resolver: Fr.random().toString(),
    registrar: Fr.random().toString(),
  };
  const instances = await deriveMainnetSuiteInstances(adminAddr, salts, {
    priceVersion,
    minPublicLength,
  });
  const launchPolicy = {
    priceVersion,
    minPublicLength,
    maxRenewAhead: String(MAINNET_RENEW_HORIZON),
  };

  const credentials: MainnetV8Credentials = {
    schema: MAINNET_V8_CREDENTIALS_SCHEMA,
    network: 'mainnet',
    toolchainVersion: '6.0.0',
    accountClassId,
    admin: {
      address: adminAddr.toString(),
      secret: secret.toString(),
      salt: salt.toString(),
      signingKey: signingKey.toString(),
    },
    l1Funding: {
      address: l1Address,
      privateKey: l1PrivateKey,
    },
    salts,
    launchPolicy,
  };

  const publicAccounts: MainnetV8PublicAccounts = {
    schema: MAINNET_V8_PUBLIC_SCHEMA,
    network: 'mainnet',
    toolchainVersion: '6.0.0',
    signerUser: identity.username,
    accountClassId,
    admin: adminAddr.toString(),
    operatorBalanceSlot,
    l1FundingAddress: l1Address,
    addresses: {
      registry: instances.registry.address.toString(),
      resolver: instances.resolver.address.toString(),
      registrar: instances.registrar.address.toString(),
    },
    classIds: {
      registry: metadata.v8.classId,
      resolver: metadata.resolver.classId,
      registrar: metadata.registrarLaunch.classId,
      token: ZERO,
    },
    launchPolicy,
    reservedListHash: V8_RESERVED_HASH,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };

  await writeExclusiveSynced(
    join(stateDir, 'credentials.json'),
    JSON.stringify(credentials, null, 2) + '\n',
    0o600,
  );
  const publicJson = JSON.stringify(publicAccounts, null, 2) + '\n';
  await writeExclusiveSynced(join(stateDir, 'public.json'), publicJson, 0o600);

  const dirHandle = await open(stateDir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }

  return {
    publicAccounts,
    publicSha256: createHash('sha256').update(publicJson).digest('hex'),
  };
}

export async function readMainnetV8PublicAccounts(path: string): Promise<MainnetV8PublicAccounts> {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    assert(s.isFile() && s.nlink === 1, 'Regular single-link public metadata file required');
    const parsed = JSON.parse(await handle.readFile('utf8')) as MainnetV8PublicAccounts;
    assert.equal(parsed.schema, MAINNET_V8_PUBLIC_SCHEMA);
    assert.equal(parsed.network, 'mainnet');
    assert.equal(parsed.toolchainVersion, '6.0.0');
    assert(ALLOWED_MAINNET_SIGNER_USERS.has(parsed.signerUser), 'Unexpected signerUser in public.json');
    assert(!isPlaceholderAdmin(parsed.admin), 'Placeholder admin refused');
    assert.equal(parsed.classIds.registry, metadata.v8.classId);
    assert.equal(parsed.classIds.resolver, metadata.resolver.classId);
    assert.equal(parsed.classIds.registrar, metadata.registrarLaunch.classId);
    assert.equal(parsed.reservedListHash, V8_RESERVED_HASH);
    assert.equal(parsed.launchPolicy.maxRenewAhead, String(MAINNET_RENEW_HORIZON));
    return parsed;
  } finally {
    await handle.close();
  }
}

export async function loadMainnetV8Credentials(
  stateDir: string,
  publicAccounts: MainnetV8PublicAccounts,
  identity: SignerIdentity = currentMainnetSignerIdentity(),
): Promise<MainnetV8Credentials> {
  await assertMainnetSignerDirectory(stateDir, identity, true);
  const handle = await open(
    join(stateDir, 'credentials.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const s = await handle.stat();
    assert(
      s.isFile() && s.nlink === 1 && s.uid === identity.uid && (s.mode & 0o777) === 0o600,
      'Regular mode 0600 credentials.json owned by isolated signer required',
    );
    const parsed = JSON.parse(await handle.readFile('utf8')) as MainnetV8Credentials;
    assert.equal(parsed.schema, MAINNET_V8_CREDENTIALS_SCHEMA);
    assert.equal(parsed.network, 'mainnet');
    assert.equal(parsed.toolchainVersion, '6.0.0');
    const derivedAdmin = await getSchnorrInitializerlessAccountContractAddress(
      Fq.fromString(parsed.admin.signingKey),
      Fr.fromString(parsed.admin.salt),
      Fr.fromString(parsed.admin.secret),
    );
    assert.equal(derivedAdmin.toString(), parsed.admin.address, 'Admin Schnorr derivation mismatch');
    assert.equal(parsed.admin.address, publicAccounts.admin, 'Public/private admin mismatch');
    assert.equal(
      privateKeyToAccount(parsed.l1Funding.privateKey).address.toLowerCase(),
      parsed.l1Funding.address.toLowerCase(),
      'L1 funding key derivation mismatch',
    );
    assert.equal(
      parsed.l1Funding.address.toLowerCase(),
      publicAccounts.l1FundingAddress.toLowerCase(),
      'Public/private L1 funding address mismatch',
    );
    assert.deepEqual(parsed.launchPolicy, publicAccounts.launchPolicy, 'Launch policy mismatch');
    const instances = await deriveMainnetSuiteInstances(derivedAdmin, parsed.salts, parsed.launchPolicy);
    assert.deepEqual(
      {
        registry: instances.registry.address.toString(),
        resolver: instances.resolver.address.toString(),
        registrar: instances.registrar.address.toString(),
      },
      publicAccounts.addresses,
      'Derived contract addresses differ from public.json',
    );
    return parsed;
  } finally {
    await handle.close();
  }
}

export function mainnetV8LaunchConfirmation(
  accounts: MainnetV8PublicAccounts,
  options: { domain: string; maxFeeJuiceWei: bigint },
) {
  return [
    `mainnet-v8-launch:6.0.0:1:2070860440:${MAINNET_ROLLUP}`,
    `v8=${metadata.v8.classId}`,
    `resolver=${metadata.resolver.classId}`,
    `launch=${metadata.registrarLaunch.classId}`,
    `admin=${accounts.admin}`,
    `registry=${accounts.addresses.registry}`,
    `resolverAddr=${accounts.addresses.resolver}`,
    `registrar=${accounts.addresses.registrar}`,
    `pv=${accounts.launchPolicy.priceVersion}`,
    `min=${accounts.launchPolicy.minPublicLength}`,
    `maxRenewAhead=${accounts.launchPolicy.maxRenewAhead}`,
    `reserved=${V8_RESERVED_HASH}`,
    `domain=${options.domain}`,
    `maxFJWei=${options.maxFeeJuiceWei}`,
  ].join(':');
}

export function mainnetV8BridgeConfirmation(
  accounts: MainnetV8PublicAccounts,
  amountWei: bigint,
) {
  return [
    'mainnet-v8-bridge:1',
    `portal=${MAINNET_FEE_JUICE_PORTAL}`,
    `token=${MAINNET_FEE_JUICE_TOKEN}`,
    `recipient=${accounts.admin}`,
    `l1=${accounts.l1FundingAddress.toLowerCase()}`,
    `amountWei=${amountWei}`,
  ].join(':');
}

export function mainnetV8AdminConfirmation(
  accounts: MainnetV8PublicAccounts,
  action: AdminCliAction,
) {
  const detail =
    action.kind === 'minimum'
      ? `minimum:${action.length}`
      : action.kind === 'mint'
        ? `mint:${normalizeName(action.label, { suffix: NAME_SUFFIX }).label}:${action.recipient.toLowerCase()}`
        : action.kind;
  return [
    `mainnet-v8-admin:6.0.0:1:2070860440:${MAINNET_ROLLUP}`,
    `registry=${accounts.addresses.registry}`,
    `registrar=${accounts.addresses.registrar}`,
    `admin=${accounts.admin}`,
    detail,
  ].join(':');
}

export function parseMainnetV8Args(argv: string[]) {
  const flags = new Set(['--init-accounts', '--bridge', '--dry-run', '--send']);
  const valued = new Set([
    '--state-dir',
    '--public-accounts',
    '--node-url',
    '--l1-rpc-url',
    '--domain',
    '--manifest-out',
    '--confirm',
    '--price-version',
    '--min-public-length',
    '--amount-fj',
    '--amount-wei',
    '--max-fee-juice',
    '--max-l2-fee-per-gas',
    '--admin-action',
    '--length',
    '--label',
    '--recipient',
  ]);
  const v = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    assert(
      (flags.has(key) || valued.has(key)) && !v.has(key),
      `Unknown or duplicate mainnet V8 argument: ${key}`,
    );
    if (flags.has(key)) v.set(key, 'true');
    else {
      assert(argv[i + 1] && !argv[i + 1]!.startsWith('--'), `Missing value for ${key}`);
      v.set(key, argv[++i]!);
    }
  }
  assert(!(v.has('--dry-run') && v.has('--send')), 'Cannot combine --dry-run and --send');
  const primaryModes = [
    v.has('--init-accounts'),
    v.has('--bridge'),
    v.has('--admin-action'),
  ].filter(Boolean).length;
  assert(primaryModes <= 1, 'Choose at most one of --init-accounts, --bridge or --admin-action');

  const stateDirRaw = v.get('--state-dir');
  assert(stateDirRaw, '--state-dir is required');
  const stateDir = resolve(stateDirRaw);
  const publicAccountsPath = resolve(v.get('--public-accounts') ?? join(stateDir, 'public.json'));

  if (v.has('--init-accounts')) {
    for (const forbidden of [
      '--send',
      '--dry-run',
      '--node-url',
      '--l1-rpc-url',
      '--domain',
      '--manifest-out',
      '--confirm',
      '--public-accounts',
    ])
      assert(!v.has(forbidden), `--init-accounts refuses ${forbidden}`);
    const priceVersion = v.has('--price-version') ? Number(v.get('--price-version')) : 1;
    const minPublicLength = v.has('--min-public-length') ? Number(v.get('--min-public-length')) : 7;
    assert(
      Number.isSafeInteger(priceVersion) && priceVersion > 0 && priceVersion <= 4294967295,
      '--price-version must be a positive u32 integer',
    );
    assert(
      Number.isInteger(minPublicLength) && minPublicLength >= 3 && minPublicLength <= 31,
      '--min-public-length must be 3..31',
    );
    return { mode: 'init-accounts' as const, stateDir, priceVersion, minPublicLength };
  }

  const nodeUrl = cleanHttpsUrl(v.get('--node-url'), '--node-url');
  const maxFjRaw = v.get('--max-fee-juice') ?? String(DEFAULT_MAX_MAINNET_FJ);
  assert(/^[1-9][0-9]*$/.test(maxFjRaw), '--max-fee-juice must be a positive integer in FJ');
  const maxFeeJuiceWei = BigInt(maxFjRaw) * 10n ** 18n;
  const maxGasRaw = v.get('--max-l2-fee-per-gas') ?? String(DEFAULT_MAX_MAINNET_L2_GAS_PRICE);
  assert(/^[1-9][0-9]*$/.test(maxGasRaw), '--max-l2-fee-per-gas must be a positive integer');
  const maxL2FeePerGas = BigInt(maxGasRaw);
  const send = v.has('--send');
  const confirm = v.get('--confirm');
  if (send) assert(confirm, '--send requires --confirm <exact>');

  if (v.has('--bridge')) {
    for (const forbidden of [
      '--domain',
      '--manifest-out',
      '--price-version',
      '--min-public-length',
      '--length',
      '--label',
      '--recipient',
    ])
      assert(!v.has(forbidden), `--bridge refuses ${forbidden}`);
    const l1Rpc = cleanHttpsUrl(v.get('--l1-rpc-url'), '--l1-rpc-url');
    assert(
      v.has('--amount-fj') !== v.has('--amount-wei'),
      '--bridge requires exactly one of --amount-fj or --amount-wei',
    );
    const amountWei = v.has('--amount-wei')
      ? (() => {
          const w = v.get('--amount-wei')!;
          assert(/^[1-9][0-9]*$/.test(w), '--amount-wei must be positive');
          return BigInt(w);
        })()
      : (() => {
          const fj = v.get('--amount-fj')!;
          assert(/^[1-9][0-9]*$/.test(fj), '--amount-fj must be a positive integer');
          return BigInt(fj) * 10n ** 18n;
        })();
    return {
      mode: 'bridge' as const,
      stateDir,
      publicAccountsPath,
      nodeUrl,
      l1Rpc,
      amountWei,
      send,
      dryRun: !send,
      confirm,
    };
  }

  if (v.has('--admin-action')) {
    for (const forbidden of [
      '--l1-rpc-url',
      '--amount-fj',
      '--amount-wei',
      '--domain',
      '--manifest-out',
      '--price-version',
      '--min-public-length',
    ])
      assert(!v.has(forbidden), `--admin-action refuses ${forbidden}`);
    const kind = v.get('--admin-action')!;
    if (kind !== 'minimum') assert(!v.has('--length'), `--admin-action ${kind} refuses --length`);
    if (kind !== 'mint') {
      assert(!v.has('--label'), `--admin-action ${kind} refuses --label`);
      assert(!v.has('--recipient'), `--admin-action ${kind} refuses --recipient`);
    }
    let action: AdminCliAction;
    if (kind === 'unpause' || kind === 'pause') {
      action = { kind };
    } else if (kind === 'minimum') {
      const length = Number(v.get('--length'));
      assert(
        Number.isInteger(length) && length >= 3 && length <= 31,
        '--admin-action minimum requires --length 3..31',
      );
      action = { kind: 'minimum', length };
    } else if (kind === 'mint') {
      const label = v.get('--label') ?? '';
      const recipient = v.get('--recipient') ?? '';
      const normalized = normalizeName(label, { suffix: NAME_SUFFIX });
      assertRegistrableLabel(normalized);
      assert(
        /^0x[0-9a-fA-F]{64}$/.test(recipient) &&
          BigInt(recipient) > 0n &&
          BigInt(recipient) < Fr.MODULUS,
        '--admin-action mint requires a valid nonzero --recipient AztecAddress',
      );
      action = { kind: 'mint', label: normalized.label, recipient: recipient.toLowerCase() };
    } else {
      throw new Error('Unknown --admin-action; expected unpause|pause|minimum|mint');
    }
    return {
      mode: 'admin' as const,
      stateDir,
      publicAccountsPath,
      nodeUrl,
      action,
      maxFeeJuiceWei,
      maxL2FeePerGas,
      send,
      dryRun: !send,
      confirm,
    };
  }

  for (const forbidden of [
    '--l1-rpc-url',
    '--amount-fj',
    '--amount-wei',
    '--price-version',
    '--min-public-length',
    '--length',
    '--label',
    '--recipient',
  ])
    assert(!v.has(forbidden), `deploy mode refuses ${forbidden}`);
  const domain = normalizeDomainUrl(v.get('--domain'));
  const manifestOutRaw = v.get('--manifest-out');
  assert(manifestOutRaw, '--manifest-out is required for mainnet deployment');
  const manifestOut = resolve(manifestOutRaw);
  assert(
    !within(join(REPO, 'deployments'), manifestOut),
    '--manifest-out must write outside deployments/ so review precedes committing mainnet.json',
  );
  assert(
    ![
      join(stateDir, 'credentials.json'),
      join(stateDir, 'public.json'),
      join(stateDir, 'state.json'),
      join(stateDir, 'bridge-state.json'),
      join(stateDir, 'admin-actions.json'),
      join(stateDir, 'runner.lock'),
    ].includes(manifestOut),
    '--manifest-out must not overwrite private state or lock files',
  );

  return {
    mode: 'deploy' as const,
    stateDir,
    publicAccountsPath,
    nodeUrl,
    domain,
    manifestOut,
    maxFeeJuiceWei,
    maxL2FeePerGas,
    send,
    dryRun: !send,
    confirm,
  };
}

export function buildMainnetV8Manifest(input: {
  accounts: MainnetV8PublicAccounts;
  nodeUrl: string;
  domain: string;
  transactions: Record<string, string>;
  deployedAt: string;
}) {
  const { accounts, nodeUrl, domain, transactions, deployedAt } = input;
  const manifest = {
    schema: 'fog-deployment-v6/1',
    network: 'mainnet' as const,
    aztecVersion: '6.0.0',
    protocol: 8,
    registryVersion: 8,
    allowRehearsalSuccessor: false,
    nodeUrl,
    domain,
    chainId: V6_PROFILES.mainnet.chainId,
    rollupVersion: V6_PROFILES.mainnet.rollupVersion,
    rollup: MAINNET_ROLLUP,
    realProofs: true,
    feePayment: 'fee-juice' as const,
    sponsoredFpc: null,
    admin: accounts.admin,
    owner: accounts.admin,
    treasury: null,
    registry: accounts.addresses.registry,
    resolver: accounts.addresses.resolver,
    registrar: accounts.addresses.registrar,
    registrarKind: 'launch' as const,
    legacy: ZERO,
    feeToken: ZERO,
    feeTokenSource: 'none' as const,
    feeTokenClassId: ZERO,
    feeSymbol: 'FREE',
    feeDecimals: 18,
    annualPrice: '0',
    lengthPrices: { '3': '0', '4': '0' },
    priceVersion: accounts.launchPolicy.priceVersion,
    minPublicLength: accounts.launchPolicy.minPublicLength,
    initialPaused: true,
    maxRenewAhead: accounts.launchPolicy.maxRenewAhead,
    reservedListHash: accounts.reservedListHash,
    reservedVerified: true,
    classIds: accounts.classIds,
    transactions,
    generator: 'e2e/src/mainnet-v8-launch.ts',
    deployedAt,
  };
  const problems = v6ManifestProblems(manifest, { expectNetwork: 'mainnet' });
  assert.equal(problems.length, 0, `Generated mainnet manifest invalid: ${problems.join(', ')}`);
  return manifest;
}

async function verifyMainnetAztecNode(
  rawNode: AztecNode,
  nodeUrl: string,
  maxL2FeePerGas: bigint,
) {
  const info = await rawNode.getNodeInfo();
  const identity = assertV6Network('mainnet', info, nodeUrl);
  assertV6FeeJuice('mainnet', info);
  const minFees = await rawNode.getCurrentMinFees();
  assert.equal(minFees.feePerDaGas, 0n, 'Mainnet DA fee changed from zero: STOP');
  assert(
    minFees.feePerL2Gas <= maxL2FeePerGas,
    `Mainnet feePerL2Gas ${minFees.feePerL2Gas} exceeds ceiling ${maxL2FeePerGas}: STOP`,
  );
  return { info, identity, minFees };
}

async function readOptionalBridgeState(stateDir: string, signerUid: number) {
  const path = join(stateDir, 'bridge-state.json');
  try {
    const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await f.stat();
      assert(s.isFile() && s.uid === signerUid && (s.mode & 0o777) === 0o600);
      const parsed = JSON.parse(await f.readFile('utf8')) as MainnetBridgeState;
      assert.equal(parsed.schema, MAINNET_V8_BRIDGE_SCHEMA);
      return { path, state: parsed };
    } finally {
      await f.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

async function writePublicManifestAtomic(targetPath: string, content: string) {
  try {
    const existing = await lstat(targetPath);
    assert(
      !existing.isSymbolicLink() && existing.isFile(),
      'Manifest output target must be a regular file, not a symlink',
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  const handle = await open(
    tmpPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.chmod(0o644);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (e) {
    await handle.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
  await handle.close();
  try {
    await rename(tmpPath, targetPath);
    const dirHandle = await open(dirname(targetPath), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (e) {
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
}

export async function runMainnetBridge(
  config: Extract<ReturnType<typeof parseMainnetV8Args>, { mode: 'bridge' }>,
  deps: MainnetV8Deps = mainnetV8CliDeps,
) {
  const publicAccounts = await readMainnetV8PublicAccounts(config.publicAccountsPath);
  const rawNode = deps.createNode(config.nodeUrl);
  const info = await rawNode.getNodeInfo();
  assertV6Network('mainnet', info, config.nodeUrl);
  assertV6FeeJuice('mainnet', info);

  const l1Public = deps.createL1(config.l1Rpc);
  assert.equal(await l1Public.getChainId(), 1, 'Ethereum Mainnet chain ID 1 required');
  const [tokenCode, portalCode, ethBalance, tokenBalance, l2Balance] = await Promise.all([
    l1Public.getCode({ address: MAINNET_FEE_JUICE_TOKEN }),
    l1Public.getCode({ address: MAINNET_FEE_JUICE_PORTAL }),
    l1Public.getBalance({ address: publicAccounts.l1FundingAddress }),
    l1Public.readContract({
      address: MAINNET_FEE_JUICE_TOKEN,
      abi: TestERC20Abi,
      functionName: 'balanceOf',
      args: [publicAccounts.l1FundingAddress],
    }),
    readFeeJuiceBalance(rawNode, AztecAddress.fromStringUnsafe(publicAccounts.admin)),
  ]);
  assert(
    tokenCode && tokenCode !== '0x' && portalCode && portalCode !== '0x',
    'Canonical Ethereum Mainnet $AZTEC or FeeJuicePortal bytecode missing',
  );
  const expectedConfirm = mainnetV8BridgeConfirmation(publicAccounts, config.amountWei);

  if (config.dryRun) {
    const preview = {
      dryRun: true,
      mode: 'bridge',
      network: 'mainnet',
      recipient: publicAccounts.admin,
      l1FundingAddress: publicAccounts.l1FundingAddress,
      amountWei: String(config.amountWei),
      l1EthBalanceWei: String(ethBalance),
      l1AztecTokenBalanceWei: String(tokenBalance),
      currentL2FeeJuiceWei: String(l2Balance),
      sufficientL1Eth: ethBalance > 0n,
      sufficientL1Aztec: tokenBalance >= config.amountWei,
      confirm: expectedConfirm,
    };
    console.log(JSON.stringify(preview, null, 2));
    return preview;
  }

  assert.equal(config.confirm, expectedConfirm, 'Exact --confirm required for mainnet bridge');
  const signer = deps.signerIdentity();
  const credentials = await loadMainnetV8Credentials(config.stateDir, publicAccounts, signer);
  const unlock = acquireTestnetLock(join(config.stateDir, 'runner.lock'));
  try {
    const bridgePath = join(config.stateDir, 'bridge-state.json');
    const existingBridge = await readOptionalBridgeState(config.stateDir, signer.uid);
    let state: MainnetBridgeState;
    if (existingBridge) {
      state = existingBridge.state;
      assert.equal(state.confirmation, expectedConfirm, 'Bridge checkpoint confirmation mismatch');
    } else {
      const secret = Fr.random();
      state = {
        schema: MAINNET_V8_BRIDGE_SCHEMA,
        confirmation: expectedConfirm,
        recipient: publicAccounts.admin,
        l1Address: publicAccounts.l1FundingAddress,
        amountWei: String(config.amountWei),
        claimSecret: secret.toString(),
        claimSecretHash: (await computeSecretHash(secret)).toString(),
        l1Transactions: {},
        l1Done: [],
        l1FeesWei: {},
        observations: {},
        provenObservations: 0,
      };
      await savePrivateJson(bridgePath, state);
    }

    const save = () => savePrivateJson(bridgePath, state);
    const l1Account = privateKeyToAccount(credentials.l1Funding.privateKey);
    let activeL1 = '';
    const baseHttp = http(config.l1Rpc, { timeout: 20_000, retryCount: 0 })({});
    const l1Wallet = createWalletClient({
      account: l1Account,
      chain: mainnet,
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

    const runL1 = async (name: string, send: () => Promise<Hex>) => {
      if (state.l1Done.includes(name)) return;
      const saved = state.l1Transactions[name];
      if (saved) {
        const next = (state.observations[name] ?? 0) + 1;
        assert(next <= 20, `L1 observation limit (20) exhausted for ${name}; STOP without resend`);
        state.observations[name] = next;
        await save();
        const receipt = await l1Public.getTransactionReceipt({ hash: saved });
        assert.equal(receipt.status, 'success', `L1 step ${name} reverted: ${saved}`);
        state.l1FeesWei[name] = String(receipt.gasUsed * receipt.effectiveGasPrice);
        state.l1Done.push(name);
        await save();
        return;
      }
      const spentEth = Object.values(state.l1FeesWei).reduce((a, b) => a + BigInt(b), 0n);
      assert(spentEth <= DEFAULT_MAX_MAINNET_L1_ETH_WEI, 'Mainnet L1 ETH safety ceiling reached');
      assert(ethBalance > 0n, `L1 funding account ${l1Account.address} has 0 ETH`);
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

    if (!state.l1Done.includes('l1-deposit')) {
      if (!state.l1Done.includes('l1-approve')) {
        if (state.l1Transactions['l1-approve']) {
          await runL1('l1-approve', () => assert.fail('Unreachable'));
        } else if (!state.l1Transactions['l1-deposit']) {
          const allowance = await l1Public.readContract({
            address: MAINNET_FEE_JUICE_TOKEN,
            abi: TestERC20Abi,
            functionName: 'allowance',
            args: [l1Account.address, MAINNET_FEE_JUICE_PORTAL],
          });
          if (allowance < config.amountWei) {
            await runL1('l1-approve', () =>
              l1Wallet.writeContract({
                address: MAINNET_FEE_JUICE_TOKEN,
                abi: TestERC20Abi,
                functionName: 'approve',
                args: [MAINNET_FEE_JUICE_PORTAL, config.amountWei],
              }),
            );
          }
        }
      }
      if (!state.l1Transactions['l1-deposit']) {
        assert(
          tokenBalance >= config.amountWei,
          `Insufficient L1 $AZTEC balance on ${l1Account.address}: have ${tokenBalance}, need ${config.amountWei}`,
        );
      }
      await runL1('l1-deposit', async () => {
        const args = [
          publicAccounts.admin as Hex,
          config.amountWei,
          state.claimSecretHash as Hex,
        ] as const;
        const gas = await l1Public.estimateContractGas({
          account: l1Account,
          address: MAINNET_FEE_JUICE_PORTAL,
          abi: FeeJuicePortalAbi,
          functionName: 'depositToAztecPublic',
          args,
        });
        return l1Wallet.writeContract({
          address: MAINNET_FEE_JUICE_PORTAL,
          abi: FeeJuicePortalAbi,
          functionName: 'depositToAztecPublic',
          args,
          gas: (gas * 13n) / 10n,
        });
      });
    }

    if (!state.messageHash) {
      const depositHash = state.l1Transactions['l1-deposit']!;
      const receipt = await l1Public.getTransactionReceipt({ hash: depositHash });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== MAINNET_FEE_JUICE_PORTAL.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({
            abi: FeeJuicePortalAbi,
            data: log.data,
            topics: log.topics,
            eventName: 'DepositToAztecPublic',
          });
          if (
            ev.args.to.toLowerCase() === publicAccounts.admin.toLowerCase() &&
            ev.args.secretHash.toLowerCase() === state.claimSecretHash.toLowerCase() &&
            ev.args.amount === config.amountWei
          ) {
            state.depositTx = depositHash;
            state.messageHash = ev.args.key;
            state.leafIndex = String(ev.args.index);
          }
        } catch {
          /* Ignore unrelated portal events. */
        }
      }
      assert(state.messageHash && state.leafIndex !== undefined, 'Missing DepositToAztecPublic log');
      await save();
    }

    const result = {
      dryRun: false,
      mode: 'bridge',
      recipient: state.recipient,
      amountWei: state.amountWei,
      depositTx: state.depositTx,
      messageHash: state.messageHash,
      leafIndex: state.leafIndex,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    unlock();
  }
}

export async function runMainnetV8Deploy(
  config: Extract<ReturnType<typeof parseMainnetV8Args>, { mode: 'deploy' }>,
  deps: MainnetV8Deps = mainnetV8CliDeps,
) {
  const publicAccounts = await readMainnetV8PublicAccounts(config.publicAccountsPath);
  const labels = canonicalReservedLabels(reservations);
  assert.equal(labels.length, 325);
  assert.equal(reservedListHash(labels), V8_RESERVED_HASH);
  assert.equal(publicAccounts.launchPolicy.minPublicLength, reservations.minLength);

  const rawNode = deps.createNode(config.nodeUrl);
  const { info, minFees } = await verifyMainnetAztecNode(
    rawNode,
    config.nodeUrl,
    config.maxL2FeePerGas,
  );
  const adminAddr = AztecAddress.fromStringUnsafe(publicAccounts.admin);
  const [v8Class, resolverClass, launchClass, adminFeeJuiceWei] = await Promise.all([
    rawNode.getContractClass(Fr.fromString(metadata.v8.classId)),
    rawNode.getContractClass(Fr.fromString(metadata.resolver.classId)),
    rawNode.getContractClass(Fr.fromString(metadata.registrarLaunch.classId)),
    readFeeJuiceBalance(rawNode, adminAddr),
  ]);

  const expectedConfirm = mainnetV8LaunchConfirmation(publicAccounts, {
    domain: config.domain,
    maxFeeJuiceWei: config.maxFeeJuiceWei,
  });

  if (config.dryRun) {
    const dryRunGroups = mainnetReservedCallGroups(labels.map((_, i) => BigInt(i + 1)));
    const estimatedDeployFeeJuiceWei = ESTIMATED_MAINNET_DEPLOY_L2_GAS * minFees.feePerL2Gas;
    const recommendedMinFundingFJ =
      ((ESTIMATED_MAINNET_DEPLOY_L2_GAS + 4_950_000n) * minFees.feePerL2Gas + 10n ** 18n - 1n) /
        10n ** 18n +
      15n;
    const preview = {
      dryRun: true,
      mode: 'deploy',
      network: 'mainnet',
      nodeVersion: info.nodeVersion,
      chainId: String(info.l1ChainId),
      rollupVersion: String(info.rollupVersion),
      rollup: info.l1ContractAddresses.rollupAddress.toString(),
      realProofs: info.realProofs,
      minFees: {
        feePerDaGas: String(minFees.feePerDaGas),
        feePerL2Gas: String(minFees.feePerL2Gas),
      },
      publishedClasses: {
        v8: !!v8Class,
        resolver: !!resolverClass,
        registrarLaunch: !!launchClass,
      },
      admin: publicAccounts.admin,
      operatorBalanceSlot: publicAccounts.operatorBalanceSlot,
      addresses: publicAccounts.addresses,
      adminFeeJuiceWei: String(adminFeeJuiceWei),
      maxFeeJuiceWei: String(config.maxFeeJuiceWei),
      reservedLabels: {
        count: labels.length,
        batches: dryRunGroups.length,
        calls: dryRunGroups.reduce((n, g) => n + g.length, 0),
        hash: V8_RESERVED_HASH,
      },
      estimatedCost: {
        estimatedDeployL2Gas: String(ESTIMATED_MAINNET_DEPLOY_L2_GAS),
        estimatedDeployFeeJuiceWei: String(estimatedDeployFeeJuiceWei),
        recommendedMinFundingFJ: String(recommendedMinFundingFJ),
      },
      domain: config.domain,
      manifestOut: config.manifestOut,
      confirm: expectedConfirm,
    };
    console.log(JSON.stringify(preview, null, 2));
    return preview;
  }

  assert.equal(config.confirm, expectedConfirm, 'Exact --confirm required for mainnet V8 launch');
  setLogLevel('silent');
  const signer = deps.signerIdentity();
  const credentials = await loadMainnetV8Credentials(config.stateDir, publicAccounts, signer);
  const unlock = acquireTestnetLock(join(config.stateDir, 'runner.lock'));
  let wallet: EmbeddedWallet | undefined;

  try {
    const statePath = join(config.stateDir, 'state.json');
    const reportPath = join(config.stateDir, 'report.json');
    let state: MainnetV8RunState;
    try {
      const f = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = await f.stat();
        assert(s.isFile() && s.uid === signer.uid && (s.mode & 0o777) === 0o600);
        state = JSON.parse(await f.readFile('utf8')) as MainnetV8RunState;
      } finally {
        await f.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      state = {
        schema: MAINNET_V8_STATE_SCHEMA,
        confirmation: expectedConfirm,
        domain: config.domain,
        nodeUrl: config.nodeUrl,
        manifestOut: config.manifestOut,
        maxFeeJuiceWei: String(config.maxFeeJuiceWei),
        maxL2FeePerGas: String(config.maxL2FeePerGas),
        addresses: {
          admin: publicAccounts.admin,
          ...publicAccounts.addresses,
        },
        l2Transactions: {},
        l2Done: [],
        l2FeesWei: {},
        observations: {},
      };
      await savePrivateJson(statePath, state);
    }

    assert.equal(state.schema, MAINNET_V8_STATE_SCHEMA);
    assert.equal(state.confirmation, expectedConfirm, 'Checkpoint confirmation mismatch');
    assert.equal(state.manifestOut, config.manifestOut, 'Checkpoint manifestOut mismatch');

    const bridge = await readOptionalBridgeState(config.stateDir, signer.uid);
    const save = async (status = 'IN_PROGRESS', extra: Record<string, unknown> = {}) => {
      await savePrivateJson(statePath, state);
      if (bridge) await savePrivateJson(bridge.path, bridge.state);
      const spentL2Wei = Object.values(state.l2FeesWei).reduce((a, b) => a + BigInt(b), 0n);
      await savePrivateJson(reportPath, {
        ...extra,
        schema: 'fog-mainnet-v8-report/1',
        status,
        confirmation: state.confirmation,
        admin: publicAccounts.admin,
        operatorBalanceSlot: publicAccounts.operatorBalanceSlot,
        addresses: publicAccounts.addresses,
        l2Transactions: state.l2Transactions,
        l2Done: state.l2Done,
        l2SpentFeeJuiceWei: String(spentL2Wei),
      });
    };

    const guardLive = async () => {
      const checked = await verifyMainnetAztecNode(rawNode, config.nodeUrl, config.maxL2FeePerGas);
      const spent = Object.values(state.l2FeesWei).reduce((a, b) => a + BigInt(b), 0n);
      assert(
        spent <= config.maxFeeJuiceWei,
        `Spent L2 Fee Juice ${spent} exceeds approved ceiling ${config.maxFeeJuiceWei}`,
      );
      return checked.minFees;
    };

    const reserveObservation = async (key: string) => {
      const next = (state.observations[key] ?? 0) + 1;
      assert(next <= 20, `Observation limit (20) exhausted for ${key}; STOP without resend`);
      state.observations[key] = next;
      await save();
    };

    // Resume any saved pending L2 transactions in strict TRACK ONLY mode before creating new txs.
    for (const [stepName, hash] of Object.entries(state.l2Transactions)) {
      if (state.l2Done.includes(stepName)) continue;
      await guardLive();
      await reserveObservation(`l2:${stepName}`);
      await trackTx(rawNode, hash, { waitFor: 'confirmed', timeoutMs: 3_600_000, pollMs: 1_500 });
      const receipt = await rawNode.getTxReceipt(TxHash.fromString(hash));
      assert(receipt.hasExecutionSucceeded(), `Tracked L2 tx failed for ${stepName}: ${hash}`);
      if (receipt.transactionFee !== undefined)
        state.l2FeesWei[stepName] = String(receipt.transactionFee);
      state.l2Done.push(stepName);
      await save();
    }

    const currentBalance = await readFeeJuiceBalance(rawNode, adminAddr);
    if (currentBalance === 0n && (!bridge || bridge.state.consumedByStep)) {
      throw new Error(
        `Admin ${publicAccounts.admin} has 0 L2 Fee Juice and no unconsumed bridge claim; fund L2 Fee Juice first`,
      );
    }
    if (currentBalance === 0n && bridge && !bridge.state.consumedByStep) {
      assert(
        bridge.state.messageHash && bridge.state.leafIndex !== undefined,
        'Bridge state incomplete; finish --bridge first',
      );
      assert(bridge.state.provenObservations < 20, 'Proven bridge wait limit (20) reached');
      bridge.state.provenObservations += 1;
      await save();
      const ready = await isL1ToL2MessageReady(
        rawNode,
        Fr.fromString(bridge.state.messageHash),
        'proven',
      );
      if (!ready) {
        await save('WAITING_FOR_PROVEN_BRIDGE_MESSAGE');
        const out = {
          status: 'WAITING_FOR_PROVEN_BRIDGE_MESSAGE' as const,
          admin: publicAccounts.admin,
          messageHash: bridge.state.messageHash,
          observations: bridge.state.provenObservations,
          action:
            'Exit cleanly without re-depositing; re-run after Aztec mainnet proven tip advances.',
        };
        console.log(JSON.stringify(out, null, 2));
        return out;
      }
    }

    let activeL2 = '';
    let consumingBridge = false;
    const node = new Proxy(rawNode, {
      get(target, prop) {
        if (prop === 'sendTx')
          return async (tx: Tx) => {
            assert(activeL2 && !state.l2Transactions[activeL2], 'Duplicate or uncheckpointed L2 send');
            await guardLive();
            const hash = (await tx.getTxHash()).toString();
            state.l2Transactions[activeL2] = hash;
            if (consumingBridge && bridge) bridge.state.consumedByStep = activeL2;
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
    const adminAccount = await wallet.createSchnorrInitializerlessAccount(
      Fr.fromString(credentials.admin.secret),
      Fr.fromString(credentials.admin.salt),
      Fq.fromString(credentials.admin.signingKey),
    );
    assert.equal(adminAccount.address.toString(), publicAccounts.admin);

    const instances = await deriveMainnetSuiteInstances(
      adminAccount.address,
      credentials.salts,
      credentials.launchPolicy,
    );

    const feeForStep = async (
      stepName: string,
      liveFeePerL2Gas: bigint,
    ): Promise<FeePaymentMethod | undefined> => {
      const bal = await readFeeJuiceBalance(rawNode, adminAccount.address);
      const requiredAdmissionWei = (stepAdmissionGasLimit(stepName) * liveFeePerL2Gas * 3n) / 2n;
      if (bal > 0n) {
        assert(
          bal >= requiredAdmissionWei,
          `Insufficient Fee Juice for ${stepName} mempool admission: have ${bal} wei, need at least ${requiredAdmissionWei} wei`,
        );
        consumingBridge = false;
        return undefined;
      }
      assert(
        bridge && (!bridge.state.consumedByStep || bridge.state.consumedByStep === stepName),
        `Admin has 0 L2 Fee Juice at ${stepName} and no unconsumed bridge claim`,
      );
      const claimWei = BigInt(bridge.state.amountWei);
      assert(
        claimWei >= requiredAdmissionWei,
        `Insufficient bridged Fee Juice for ${stepName} mempool admission: claim ${claimWei} wei, need at least ${requiredAdmissionWei} wei`,
      );
      assert(
        await isL1ToL2MessageReady(rawNode, Fr.fromString(bridge.state.messageHash!), 'proven'),
        'Bridge claim message not ready at proven tip',
      );
      consumingBridge = true;
      return new FeeJuicePaymentMethodWithClaim(adminAccount.address, {
        claimAmount: claimWei,
        claimSecret: Fr.fromString(bridge.state.claimSecret),
        messageLeafIndex: BigInt(bridge.state.leafIndex!),
      });
    };

    const txFeeOptions = (paymentMethod?: FeePaymentMethod) => ({
      ...(paymentMethod ? { paymentMethod } : {}),
      congestionEstimate: ManaUsageEstimate.Target,
    });

    const runL2Step = async (
      name: string,
      send: (fee: FeePaymentMethod | undefined) => Promise<unknown>,
      verify: () => Promise<void> = async () => {},
    ) => {
      if (state.l2Done.includes(name)) {
        await verify();
        console.log(`SKIP ${name} ${state.l2Transactions[name] ?? ''}`);
        return;
      }
      console.log(`STEP ${name}`);
      const liveFees = await guardLive();
      const fee = await feeForStep(name, liveFees.feePerL2Gas);
      activeL2 = name;
      try {
        await send(fee);
        const hash = state.l2Transactions[name];
        assert(hash, `Step ${name} produced no L2 transaction hash`);
        await reserveObservation(`l2:${name}`);
        await trackTx(rawNode, hash, { waitFor: 'confirmed', timeoutMs: 3_600_000, pollMs: 1_500 });
        const receipt = await rawNode.getTxReceipt(TxHash.fromString(hash));
        assert(receipt.hasExecutionSucceeded(), `Step ${name} execution failed: ${hash}`);
        if (receipt.transactionFee !== undefined)
          state.l2FeesWei[name] = String(receipt.transactionFee);
        await verify();
        state.l2Done.push(name);
        await save();
        console.log(`DONE ${name} ${hash}`);
      } finally {
        activeL2 = '';
        consumingBridge = false;
      }
    };

    const v8ClassId = Fr.fromString(metadata.v8.classId);
    const registrySalt = Fr.fromString(credentials.salts.registry);
    const resolverSalt = Fr.fromString(credentials.salts.resolver);
    const registrarSalt = Fr.fromString(credentials.salts.registrar);

    await runL2Step(
      'deploy-registry',
      async (fee) =>
        Contract.deploy(
          wallet!,
          NameRegistryV8Contract.artifact,
          [AztecAddress.ZERO, v8ClassId],
          undefined,
          { salt: registrySalt, ...v8BoundDeployment(adminAccount.address) },
        ).send({
          from: adminAccount.address,
          fee: txFeeOptions(fee),
          skipClassPublication: !!(await rawNode.getContractClass(v8ClassId)),
          wait: NO_WAIT,
        }),
      async () => {
        const inst = await rawNode.getContract(instances.registry.address);
        assert(inst, 'Deployed V8 registry instance missing');
        const r = await RegistryReader.connect(rawNode, instances.registry.address, {
          allowRehearsalSuccessor: false,
        });
        assertV8DeploymentOwner(adminAccount.address, inst.deployer, await r.getAdministrator());
      },
    );
    await wallet.registerContract(instances.registry, NameRegistryV8Contract.artifact);

    await runL2Step(
      'deploy-resolver',
      async (fee) =>
        Contract.deploy(
          wallet!,
          NameResolverContract.artifact,
          [instances.registry.address],
          undefined,
          { salt: resolverSalt, deployer: adminAccount.address },
        ).send({
          from: adminAccount.address,
          fee: txFeeOptions(fee),
          skipClassPublication: !!(await rawNode.getContractClass(
            instances.resolver.currentContractClassId,
          )),
          wait: NO_WAIT,
        }),
      async () => {
        const inst = await rawNode.getContract(instances.resolver.address);
        assert(
          inst?.currentContractClassId.toString() === metadata.resolver.classId,
          'Deployed resolver class mismatch',
        );
      },
    );
    await wallet.registerContract(instances.resolver, NameResolverContract.artifact);

    await runL2Step(
      'deploy-registrar',
      async (fee) =>
        Contract.deploy(
          wallet!,
          NameRegistrarLaunchContract.artifact,
          [
            instances.registry.address,
            AztecAddress.ZERO,
            AztecAddress.ZERO,
            0n,
            0n,
            0n,
            credentials.launchPolicy.priceVersion,
            credentials.launchPolicy.minPublicLength,
            true,
            MAINNET_RENEW_HORIZON,
          ],
          undefined,
          { salt: registrarSalt, deployer: adminAccount.address },
        ).send({
          from: adminAccount.address,
          fee: txFeeOptions(fee),
          skipClassPublication: !!(await rawNode.getContractClass(
            instances.registrar.currentContractClassId,
          )),
          wait: NO_WAIT,
        }),
      async () => {
        const inst = await rawNode.getContract(instances.registrar.address);
        assert(
          inst?.currentContractClassId.toString() === metadata.registrarLaunch.classId,
          'Deployed launch registrar class mismatch',
        );
      },
    );
    await wallet.registerContract(instances.registrar, NameRegistrarLaunchContract.artifact);

    const coreV8 = NameRegistryV8Contract.at(instances.registry.address, wallet);
    const launch = NameRegistrarLaunchContract.at(instances.registrar.address, wallet);
    const nodes = await reservedNodes(labels);
    const callGroups = mainnetReservedCallGroups(nodes);

    for (const [idx, group] of callGroups.entries()) {
      await runL2Step(`seed-reserved-${idx}`, async (fee) => {
        const sendOptions = {
          from: adminAccount.address,
          fee: txFeeOptions(fee),
          wait: NO_WAIT,
        };
        if (group.length === 1) {
          return launch.methods.set_reserved(group[0]!, true).send(sendOptions);
        }
        return new BatchCall(
          wallet!,
          group.map((batch) => launch.methods.set_reserved(batch, true)),
        ).send(sendOptions);
      });
    }

    const verifyReservedAtBlock = async (block: BlockNumber) => {
      for (let i = 0; i < nodes.length; i += 3) {
        const slice = nodes.slice(i, i + 3);
        const vals = await Promise.all(
          slice.map(async (id) => {
            const slot = await deriveStorageSlotInMap(
              NameRegistrarLaunchContract.storage.reserved.slot,
              new Fr(id),
            );
            return (await rawNode.getPublicStorageAt(block, instances.registrar.address, slot)).toBigInt();
          }),
        );
        assert(vals.every((v) => v === 1n), `Reserved readback parity failed at offset ${i}`);
      }
    };

    if (!state.reservedReadbackVerified) {
      const latestBlock = BlockNumber(await rawNode.getBlockNumber());
      await verifyReservedAtBlock(latestBlock);
      state.reservedReadbackVerified = true;
      await save();
      console.log('VERIFIED all 325 reserved labels prior to bootstrap');
    }

    await runL2Step(
      'bootstrap',
      async (fee) =>
        coreV8.methods.bootstrap(instances.registrar.address, instances.resolver.address).send({
          from: adminAccount.address,
          fee: txFeeOptions(fee),
          wait: NO_WAIT,
        }),
      async () => {
        const r = await RegistryReader.connect(rawNode, instances.registry.address, {
          allowRehearsalSuccessor: false,
        });
        const snap = await r.snapshot();
        const mods = await r.getModules(snap);
        const cfg = await r.getConfig(snap);
        assert(mods.registrar.equals(instances.registrar.address), 'Registrar module binding mismatch');
        assert(mods.resolver.equals(instances.resolver.address), 'Resolver module binding mismatch');
        assert(cfg.feeToken.isZero() && cfg.annualPrice === 0n, 'Expected free launch config');
        assert.equal(cfg.launch?.paused, true, 'Launch registrar must remain paused after bootstrap');
        assert.equal(
          cfg.launch?.minPublicLength,
          credentials.launchPolicy.minPublicLength,
          'Launch minPublicLength mismatch',
        );
        assert.equal(
          cfg.launch?.maxRenewAhead,
          MAINNET_RENEW_HORIZON,
          'Launch maxRenewAhead mismatch',
        );
        await verifyReservedAtBlock(BlockNumber(snap.blockNumber));
        assert(await r.isCanonical(snap), 'Bootstrap verification snapshot reorged');
      },
    );

    const deployedAt = state.completedAt ?? new Date().toISOString();
    state.completedAt = deployedAt;
    await save('COMPLETED');

    const manifest = buildMainnetV8Manifest({
      accounts: publicAccounts,
      nodeUrl: config.nodeUrl,
      domain: config.domain,
      transactions: state.l2Transactions,
      deployedAt,
    });
    await mkdir(dirname(config.manifestOut), { recursive: true });
    await writePublicManifestAtomic(config.manifestOut, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`WROTE validated mainnet V8 manifest to ${config.manifestOut}`);
    return manifest;
  } finally {
    await wallet?.stop().catch(() => {});
    unlock();
  }
}

export type ActiveAdminEntry = {
  confirmation: string;
  action: AdminCliAction;
  txHashes: Record<string, string>;
  done: string[];
  l2FeesWei: Record<string, string>;
  observations: Record<string, number>;
  mint?: {
    expectedGeneration: number;
    expiry: string;
    secret: string;
    commitment: string;
  };
};

export type AdminHistory = {
  schema: typeof MAINNET_V8_ADMIN_STATE_SCHEMA;
  active: ActiveAdminEntry | null;
  completed: Array<ActiveAdminEntry & { completedAt: string }>;
};

export async function runMainnetV8AdminAction(
  config: Extract<ReturnType<typeof parseMainnetV8Args>, { mode: 'admin' }>,
  deps: MainnetV8Deps = mainnetV8CliDeps,
) {
  const publicAccounts = await readMainnetV8PublicAccounts(config.publicAccountsPath);
  const rawNode = deps.createNode(config.nodeUrl);
  const { minFees } = await verifyMainnetAztecNode(rawNode, config.nodeUrl, config.maxL2FeePerGas);

  const registryAddress = AztecAddress.fromStringUnsafe(publicAccounts.addresses.registry);
  const reader = await (deps.connectReader ?? RegistryReader.connect)(rawNode, registryAddress, {
    allowRehearsalSuccessor: false,
  });
  const snap = await reader.snapshot();
  const liveAdmin = await reader.getAdministrator(snap);
  const liveConfig = await reader.getConfig(snap);
  assert(
    liveAdmin?.toString() === publicAccounts.admin,
    `Registry administrator ${liveAdmin?.toString()} differs from ${publicAccounts.admin}`,
  );
  assert(
    liveConfig.launch && liveConfig.registrar?.toString() === publicAccounts.addresses.registrar,
    'Active registrar differs from public.json launch registrar',
  );
  const adminBalance = await readFeeJuiceBalance(
    rawNode,
    AztecAddress.fromStringUnsafe(publicAccounts.admin),
  );
  const expectedConfirm = mainnetV8AdminConfirmation(publicAccounts, config.action);

  if (config.dryRun) {
    const preview = {
      dryRun: true,
      mode: 'admin',
      registry: publicAccounts.addresses.registry,
      registrar: publicAccounts.addresses.registrar,
      admin: publicAccounts.admin,
      adminFeeJuiceWei: String(adminBalance),
      currentPolicy: {
        paused: liveConfig.launch.paused,
        minPublicLength: liveConfig.launch.minPublicLength,
        maxRenewAhead: String(liveConfig.launch.maxRenewAhead),
      },
      minFees: {
        feePerDaGas: String(minFees.feePerDaGas),
        feePerL2Gas: String(minFees.feePerL2Gas),
      },
      action: config.action,
      confirm: expectedConfirm,
    };
    console.log(JSON.stringify(preview, null, 2));
    return preview;
  }

  assert.equal(config.confirm, expectedConfirm, 'Exact --confirm required for mainnet admin action');
  setLogLevel('silent');
  const signer = deps.signerIdentity();
  const credentials = await loadMainnetV8Credentials(config.stateDir, publicAccounts, signer);
  const unlock = acquireTestnetLock(join(config.stateDir, 'runner.lock'));
  let wallet: { stop?: () => Promise<void> } | undefined;

  try {
    const actionStatePath = join(config.stateDir, 'admin-actions.json');
    let history: AdminHistory = {
      schema: MAINNET_V8_ADMIN_STATE_SCHEMA,
      active: null,
      completed: [],
    };
    try {
      const f = await open(actionStatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = await f.stat();
        assert(s.isFile() && s.uid === signer.uid && (s.mode & 0o777) === 0o600);
        history = JSON.parse(await f.readFile('utf8')) as AdminHistory;
      } finally {
        await f.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    assert.equal(history.schema, MAINNET_V8_ADMIN_STATE_SCHEMA);
    assert(
      history.active === null || typeof history.active === 'object',
      'Corrupt admin-actions.json active entry',
    );
    assert(Array.isArray(history.completed), 'Corrupt admin-actions.json completed list');
    if (history.active && history.active.confirmation !== expectedConfirm) {
      throw new Error(
        'Unfinished admin action in progress; resume and complete it before starting another action',
      );
    }
    const entry: ActiveAdminEntry =
      history.active ??
      (history.active = {
        confirmation: expectedConfirm,
        action: config.action,
        txHashes: {},
        done: [],
        l2FeesWei: {},
        observations: {},
      });
    const hasPendingHash = Object.keys(entry.txHashes).some((k) => !entry.done.includes(k));
    if (!hasPendingHash) {
      assert(adminBalance > 0n, `Admin ${publicAccounts.admin} has 0 L2 Fee Juice`);
      const minRequiredWei =
        (stepAdmissionGasLimit(config.action.kind) * minFees.feePerL2Gas * 3n) / 2n;
      assert(
        adminBalance >= minRequiredWei,
        `Insufficient Fee Juice for admin action ${config.action.kind} mempool admission: have ${adminBalance} wei, need at least ${minRequiredWei} wei`,
      );
    }
    const save = () => savePrivateJson(actionStatePath, history);
    await save();

    const guardAdminSend = async () => {
      const checked = await verifyMainnetAztecNode(rawNode, config.nodeUrl, config.maxL2FeePerGas);
      const spentWei = Object.values(entry.l2FeesWei).reduce((a, b) => a + BigInt(b), 0n);
      assert(
        spentWei <= config.maxFeeJuiceWei,
        `Admin action spent L2 Fee Juice ${spentWei} exceeds ceiling ${config.maxFeeJuiceWei}`,
      );
      return checked.minFees;
    };

    const reserveObservation = async (stepName: string) => {
      const next = (entry.observations[stepName] ?? 0) + 1;
      assert(
        next <= 20,
        `Admin observation limit (20) exhausted for ${stepName}; STOP without resend`,
      );
      entry.observations[stepName] = next;
      await save();
    };

    const completeEntry = async () => {
      history.completed.push({ ...entry, completedAt: new Date().toISOString() });
      history.active = null;
      await save();
    };

    let activeStep = '';
    const node = new Proxy(rawNode, {
      get(target, prop) {
        if (prop === 'sendTx')
          return async (tx: Tx) => {
            assert(activeStep && !entry.txHashes[activeStep], 'Duplicate admin broadcast refused');
            await guardAdminSend();
            const hash = (await tx.getTxHash()).toString();
            entry.txHashes[activeStep] = hash;
            await save();
            console.log(`BROADCAST ${activeStep} ${hash}`);
            return target.sendTx(tx);
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AztecNode;

    const createWalletFn =
      deps.createWallet ??
      (async (n: AztecNode, opts: { pxe: { proverEnabled: boolean; dataDirectory: string } }) =>
        EmbeddedWallet.create(n, opts));
    const createdWallet = await createWalletFn(node, {
      pxe: { proverEnabled: true, dataDirectory: join(config.stateDir, 'wallet') },
    });
    wallet = createdWallet;
    const adminAccount = await createdWallet.createSchnorrInitializerlessAccount(
      Fr.fromString(credentials.admin.secret),
      Fr.fromString(credentials.admin.salt),
      Fq.fromString(credentials.admin.signingKey),
    );
    const instances = await deriveMainnetSuiteInstances(
      adminAccount.address,
      credentials.salts,
      credentials.launchPolicy,
    );
    await createdWallet.registerContract(instances.registry, NameRegistryV8Contract.artifact);
    await createdWallet.registerContract(instances.registrar, NameRegistrarLaunchContract.artifact);
    const launch = (deps.launchContractAt ?? NameRegistrarLaunchContract.at)(
      instances.registrar.address,
      createdWallet as unknown as EmbeddedWallet,
    );
    const trackTxFn = deps.trackTx ?? trackTx;

    const runStep = async (stepName: string, send: () => Promise<unknown>) => {
      if (entry.done.includes(stepName)) return entry.txHashes[stepName]!;
      if (!entry.txHashes[stepName]) {
        const liveFees = await guardAdminSend();
        const bal = await readFeeJuiceBalance(rawNode, adminAccount.address);
        const minRequiredWei = (stepAdmissionGasLimit(stepName) * liveFees.feePerL2Gas * 3n) / 2n;
        assert(
          bal >= minRequiredWei,
          `Insufficient Fee Juice for admin action ${stepName} mempool admission: have ${bal} wei, need at least ${minRequiredWei} wei`,
        );
        activeStep = stepName;
        try {
          await send();
        } finally {
          activeStep = '';
        }
      }
      const hash = entry.txHashes[stepName];
      assert(hash, `Admin step ${stepName} produced no tx hash`);
      await reserveObservation(stepName);
      await trackTxFn(rawNode, hash, { waitFor: 'confirmed', timeoutMs: 3_600_000, pollMs: 1_500 });
      const receipt = await rawNode.getTxReceipt(TxHash.fromString(hash));
      assert(receipt.hasExecutionSucceeded(), `Admin step ${stepName} failed: ${hash}`);
      if (receipt.transactionFee !== undefined) {
        entry.l2FeesWei[stepName] = String(receipt.transactionFee);
      }
      entry.done.push(stepName);
      await save();
      return hash;
    };

    const adminSendOptions = {
      from: adminAccount.address,
      fee: { congestionEstimate: ManaUsageEstimate.Target },
      wait: NO_WAIT,
    };
    const action = config.action;
    if (action.kind === 'unpause' || action.kind === 'pause') {
      const paused = action.kind === 'pause';
      const txHash = await runStep(action.kind, () =>
        launch.methods.set_paused(paused).send(adminSendOptions),
      );
      const updated = await reader.getConfig(await reader.snapshot());
      assert.equal(updated.launch?.paused, paused, 'Pause state readback mismatch');
      await completeEntry();
      const out = { dryRun: false, action: action.kind, paused, txHash };
      console.log(JSON.stringify(out, null, 2));
      return out;
    }

    if (action.kind === 'minimum') {
      const txHash = await runStep(`minimum-${action.length}`, () =>
        launch.methods.set_min_public_length(action.length).send(adminSendOptions),
      );
      const updated = await reader.getConfig(await reader.snapshot());
      assert.equal(updated.launch?.minPublicLength, action.length, 'Minimum length readback mismatch');
      await completeEntry();
      const out = { dryRun: false, action: 'minimum', minPublicLength: action.length, txHash };
      console.log(JSON.stringify(out, null, 2));
      return out;
    }

    const normalized = normalizeName(action.label, { suffix: NAME_SUFFIX });
    const labelNode = await nodeOf(normalized);
    if (!entry.mint) {
      const freshSnap = await reader.snapshot();
      const freshCfg = await reader.getConfig(freshSnap);
      const record = await reader.getName(labelNode, freshSnap);
      const expiry = freshSnap.timestamp + 86_400n;
      const secret = Fr.random().toBigInt();
      const base = await registerCommitment({
        chainId: reader.deployment.chainId,
        registry: reader.registry,
        node: labelNode,
        expectedGeneration: record.generation,
        owner: AztecAddress.fromStringUnsafe(action.recipient),
        duration: SECONDS_PER_YEAR,
        feeToken: freshCfg.feeToken,
        treasury: freshCfg.treasury,
        priceVersion: freshCfg.priceVersion,
        maxFee: 0n,
        quoteExpiry: expiry,
        secret,
      });
      const commitment = await hashWithSeparator(
        [instances.registrar.address.toBigInt(), base],
        0x414e535f41444d494e5f4d494e545f5631n,
      );
      entry.mint = {
        expectedGeneration: record.generation,
        expiry: String(expiry),
        secret: String(secret),
        commitment: String(commitment),
      };
      await save();
    }

    const commitHash = await runStep('mint-commit', () =>
      launch.methods.commit(new Fr(BigInt(entry.mint!.commitment))).send(adminSendOptions),
    );
    if (!entry.txHashes['mint-register']) {
      const deadline = Date.now() + 30 * 60_000;
      for (;;) {
        const s = await reader.snapshot();
        const c = await reader.getCommit(BigInt(entry.mint.commitment), s);
        if (c.committedAt !== 0n) {
          assert(
            s.timestamp + 60n < BigInt(entry.mint.expiry) && s.timestamp <= c.committedAt + 86_400n,
            'Admin mint commitment or quote window expired; inspect admin-actions.json',
          );
          if (s.timestamp >= c.committedAt + 60n) break;
        } else {
          assert(
            s.timestamp + 60n < BigInt(entry.mint.expiry),
            'Admin mint commitment or quote window expired; inspect admin-actions.json',
          );
        }
        assert(Date.now() < deadline, 'Admin mint commit maturation timed out; re-run same command');
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    const registerHash = await runStep('mint-register', () =>
      launch.methods
        .admin_register(
          normalized.bytes,
          normalized.len,
          AztecAddress.fromStringUnsafe(action.recipient),
          entry.mint!.expectedGeneration,
          BigInt(entry.mint!.expiry),
          new Fr(BigInt(entry.mint!.secret)),
        )
        .send(adminSendOptions),
    );
    const finalRecord = await reader.getName(labelNode, await reader.snapshot());
    assert.equal(
      finalRecord.owner.toString().toLowerCase(),
      action.recipient.toLowerCase(),
      'Admin mint owner readback mismatch',
    );
    await completeEntry();
    const out = {
      dryRun: false,
      action: 'mint',
      label: normalized.label,
      recipient: action.recipient,
      commitHash,
      registerHash,
    };
    console.log(JSON.stringify(out, null, 2));
    return out;
  } finally {
    await wallet?.stop?.().catch(() => {});
    unlock();
  }
}

export type MainnetV8Deps = {
  signerIdentity: () => SignerIdentity;
  createNode: (url: string) => AztecNode;
  createL1: (url: string) => ReturnType<typeof createPublicClient>;
  connectReader?: typeof RegistryReader.connect;
  createWallet?: (
    node: AztecNode,
    opts: { pxe: { proverEnabled: boolean; dataDirectory: string } },
  ) => Promise<{
    createSchnorrInitializerlessAccount: EmbeddedWallet['createSchnorrInitializerlessAccount'];
    registerContract: EmbeddedWallet['registerContract'];
    stop?: () => Promise<void>;
  }>;
  launchContractAt?: typeof NameRegistrarLaunchContract.at;
  trackTx?: typeof trackTx;
};

export const mainnetV8CliDeps: MainnetV8Deps = {
  signerIdentity: currentMainnetSignerIdentity,
  createNode: (url: string) => createRateLimitedAztecNode(url),
  createL1: (url: string) =>
    createPublicClient({
      chain: mainnet,
      transport: http(url, { timeout: 15_000, retryCount: 0 }),
    }),
};

export async function runMainnetV8Cli(
  argv = process.argv.slice(2),
  deps: MainnetV8Deps = mainnetV8CliDeps,
) {
  const parsed = parseMainnetV8Args(argv);
  if (parsed.mode === 'init-accounts') {
    const result = await initMainnetV8Accounts(parsed.stateDir, {
      identity: deps.signerIdentity(),
      priceVersion: parsed.priceVersion,
      minPublicLength: parsed.minPublicLength,
    });
    const out = {
      status: 'ACCOUNTS_INITIALIZED' as const,
      stateDir: parsed.stateDir,
      publicAccountsPath: join(parsed.stateDir, 'public.json'),
      publicSha256: result.publicSha256,
      admin: result.publicAccounts.admin,
      operatorBalanceSlot: result.publicAccounts.operatorBalanceSlot,
      l1FundingAddress: result.publicAccounts.l1FundingAddress,
      addresses: result.publicAccounts.addresses,
    };
    console.log(JSON.stringify(out, null, 2));
    return out;
  }
  if (parsed.mode === 'bridge') return runMainnetBridge(parsed, deps);
  if (parsed.mode === 'admin') return runMainnetV8AdminAction(parsed, deps);
  return runMainnetV8Deploy(parsed, deps);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMainnetV8Cli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
