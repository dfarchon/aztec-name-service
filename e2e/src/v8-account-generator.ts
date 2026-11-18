/**
 * Isolated V8 rehearsal account generator.
 * Runs exclusively under the dedicated non-agent `fog-signer` Linux user inside `/var/lib/fog-signer`.
 * Private material is persisted only to `credentials.json` (mode 0600, no hyphen in filename, fsynced).
 * Only public addresses and metadata digests are returned or written to `public-accounts.json`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  SchnorrInitializerlessAccountContractArtifact,
  getSchnorrInitializerlessAccountContractAddress,
} from '@aztec-labs/accounts/schnorr';
import { getContractClassFromArtifact } from '@aztec-labs/aztec.js/contracts';
import { Fq, Fr } from '@aztec-labs/aztec.js/fields';
import { REPO, within } from './deploy-v6-plan.js';

export const SIGNER_USER = 'fog-signer';
export const DEFAULT_SIGNER_ROOT = '/var/lib/fog-signer';
export const V8_CREDENTIALS_SCHEMA = 'fog-v8-rehearsal-credentials/1';
export const V8_PUBLIC_ACCOUNTS_SCHEMA = 'fog-v8-rehearsal-public-accounts/1';

export type V8ActorRole = 'A' | 'B' | 'C';
export type V8PrivateActor = {
  role: V8ActorRole;
  address: string;
  secret: string;
  salt: string;
  signingKey: string;
  bridgeAmountFeeJuice: string;
};
export type V8Credentials = {
  schema: typeof V8_CREDENTIALS_SCHEMA;
  network: 'testnet-v6';
  toolchainVersion: '6.0.0';
  accountClassId: string;
  actors: Record<V8ActorRole, V8PrivateActor>;
  l1Funding: {
    address: Hex;
    privateKey: Hex;
  };
  salts: {
    registry: string;
    resolver: string;
    registrar: string;
    customResolver: string;
  };
};
export type V8PublicAccounts = {
  schema: typeof V8_PUBLIC_ACCOUNTS_SCHEMA;
  network: 'testnet-v6';
  toolchainVersion: '6.0.0';
  l1Library: 'viem@2.57.1';
  signerUser: string;
  accountClassId: string;
  actors: Record<V8ActorRole, { address: string; bridgeAmountFeeJuice: string }>;
  l1FundingAddress: Hex;
  salts: V8Credentials['salts'];
  createdAt: string;
};

export type SignerIdentity = {
  uid: number;
  username: string;
  signerRoot?: string;
};

export function currentSignerIdentity(): SignerIdentity {
  return {
    uid: process.getuid!(),
    username: userInfo().username,
    signerRoot: DEFAULT_SIGNER_ROOT,
  };
}

export async function assertIsolatedSignerDirectory(
  stateDir: string,
  identity: SignerIdentity = currentSignerIdentity(),
  requireExisting = false,
) {
  assert(identity.uid > 0, 'Isolated signer refuses root execution (uid 0)');
  assert.equal(
    identity.username,
    SIGNER_USER,
    `Isolated signer requires dedicated Linux user ${SIGNER_USER}`,
  );
  assert(
    isAbsolute(stateDir) && resolve(stateDir) === stateDir,
    'Canonical absolute state directory required',
  );
  assert(!within(REPO, stateDir), 'State directory must be outside repository');
  assert(!stateDir.startsWith('/home/grokbot/'), 'Shared agent home directory refused');
  const root = resolve(identity.signerRoot ?? DEFAULT_SIGNER_ROOT);
  const rel = relative(root, stateDir);
  assert(
    rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('/'),
    `State directory must be a direct child of ${root}`,
  );
  assert(
    /^testnet-v8-upgrade-rehearsal-\d{8}(?:-[a-z0-9]+)?$/.test(basename(stateDir)),
    'Dated testnet-v8-upgrade-rehearsal-YYYYMMDD directory required',
  );

  let cursor = parse(root).root;
  for (const part of relative(cursor, root).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    const s = await lstat(cursor);
    assert(s.isDirectory() && !s.isSymbolicLink(), 'Symlink ancestor refused');
  }
  assert.equal(await realpath(root), root, 'Symlink signer root refused');
  const rootStat = await lstat(root);
  assert.equal(rootStat.uid, identity.uid, 'Signer root must be owned by fog-signer');
  assert.equal(rootStat.mode & 0o777, 0o700, 'Signer root must be mode 0700');

  if (requireExisting) {
    const dirStat = await lstat(stateDir);
    assert(
      dirStat.isDirectory() &&
        !dirStat.isSymbolicLink() &&
        dirStat.uid === identity.uid &&
        (dirStat.mode & 0o777) === 0o700,
      'Existing rehearsal state directory must be owned regular mode 0700',
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

export async function initV8RehearsalAccounts(
  stateDir: string,
  options: {
    identity?: SignerIdentity;
    now?: () => Date;
  } = {},
) {
  assert(
    !Object.keys(process.env).some((k) => /(?:NODE|RPC|ANVIL).*URL/i.test(k) && process.env[k]),
    'Offline account generator refuses node/RPC URL environment variables',
  );
  const identity = options.identity ?? currentSignerIdentity();
  await assertIsolatedSignerDirectory(stateDir, identity, false);
  await mkdir(stateDir, { mode: 0o700 }); // Fails with EEXIST if directory already exists.

  const accountClassId = (
    await getContractClassFromArtifact(SchnorrInitializerlessAccountContractArtifact)
  ).id.toString();

  const allocations: Record<V8ActorRole, string> = { A: '150', B: '150', C: '50' };
  const actors = {} as Record<V8ActorRole, V8PrivateActor>;
  const seenAddresses = new Set<string>();

  for (const role of ['A', 'B', 'C'] as const) {
    const secret = Fr.random();
    const salt = Fr.random();
    const signingKey = Fq.random();
    const address = (
      await getSchnorrInitializerlessAccountContractAddress(signingKey, salt, secret)
    ).toString();
    assert(!seenAddresses.has(address), 'Duplicate generated Aztec address');
    seenAddresses.add(address);
    actors[role] = {
      role,
      address,
      secret: secret.toString(),
      salt: salt.toString(),
      signingKey: signingKey.toString(),
      bridgeAmountFeeJuice: allocations[role],
    };
  }

  const l1PrivateKey = generatePrivateKey();
  const l1Address = privateKeyToAccount(l1PrivateKey).address;
  const salts = {
    registry: Fr.random().toString(),
    resolver: Fr.random().toString(),
    registrar: Fr.random().toString(),
    customResolver: Fr.random().toString(),
  };

  // Filename deliberately avoids hyphens (`*-key.json`) in addition to UID 0700 DAC isolation.
  const credentials: V8Credentials = {
    schema: V8_CREDENTIALS_SCHEMA,
    network: 'testnet-v6',
    toolchainVersion: '6.0.0',
    accountClassId,
    actors,
    l1Funding: {
      address: l1Address,
      privateKey: l1PrivateKey,
    },
    salts,
  };

  const publicAccounts: V8PublicAccounts = {
    schema: V8_PUBLIC_ACCOUNTS_SCHEMA,
    network: 'testnet-v6',
    toolchainVersion: '6.0.0',
    l1Library: 'viem@2.57.1',
    signerUser: identity.username,
    accountClassId,
    actors: {
      A: { address: actors.A.address, bridgeAmountFeeJuice: actors.A.bridgeAmountFeeJuice },
      B: { address: actors.B.address, bridgeAmountFeeJuice: actors.B.bridgeAmountFeeJuice },
      C: { address: actors.C.address, bridgeAmountFeeJuice: actors.C.bridgeAmountFeeJuice },
    },
    l1FundingAddress: l1Address,
    salts,
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

export async function readV8PublicAccounts(path: string): Promise<V8PublicAccounts> {
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    assert(s.isFile() && s.nlink === 1, 'Regular single-link public metadata file required');
    const parsed = JSON.parse(await handle.readFile('utf8')) as V8PublicAccounts;
    assert.equal(parsed.schema, V8_PUBLIC_ACCOUNTS_SCHEMA);
    assert.equal(parsed.network, 'testnet-v6');
    assert.equal(parsed.toolchainVersion, '6.0.0');
    assert.equal(parsed.signerUser, SIGNER_USER);
    return parsed;
  } finally {
    await handle.close();
  }
}

export async function loadV8Credentials(
  stateDir: string,
  identity: SignerIdentity = currentSignerIdentity(),
): Promise<V8Credentials> {
  await assertIsolatedSignerDirectory(stateDir, identity, true);
  const credPath = join(stateDir, 'credentials.json');
  const handle = await open(credPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    assert(
      s.isFile() && s.nlink === 1 && s.uid === identity.uid && (s.mode & 0o777) === 0o600,
      'Regular mode 0600 credentials.json owned by fog-signer required',
    );
    const parsed = JSON.parse(await handle.readFile('utf8')) as V8Credentials;
    assert.equal(parsed.schema, V8_CREDENTIALS_SCHEMA);
    assert.equal(parsed.network, 'testnet-v6');
    assert.equal(parsed.toolchainVersion, '6.0.0');
    for (const role of ['A', 'B', 'C'] as const) {
      const a = parsed.actors[role];
      const expected = (
        await getSchnorrInitializerlessAccountContractAddress(
          Fq.fromString(a.signingKey),
          Fr.fromString(a.salt),
          Fr.fromString(a.secret),
        )
      ).toString();
      assert.equal(expected, a.address, `Actor ${role} Schnorr address derivation mismatch`);
    }
    assert.equal(
      privateKeyToAccount(parsed.l1Funding.privateKey).address.toLowerCase(),
      parsed.l1Funding.address.toLowerCase(),
      'L1 funding key address mismatch',
    );
    return parsed;
  } finally {
    await handle.close();
  }
}
