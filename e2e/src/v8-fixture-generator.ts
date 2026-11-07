/** Deterministic TEST FIXTURES ONLY. No real account generation entry point exists. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import {
  getSchnorrAccountContractAddress,
  SchnorrAccountContractArtifact,
} from '@aztec-labs/accounts/schnorr';
import { getContractClassFromArtifact } from '@aztec-labs/aztec.js/contracts';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';

export const FIXTURE_WARNING =
  'DETERMINISTIC TEST FIXTURE: NEVER FUND; actual account generation BLOCKED by missing owner-approved isolated signer';
export function generateActualAccounts(): never {
  throw new Error('Actual account generation BLOCKED: isolated signer boundary not established');
}
export async function writeDeterministicFixtures(directory: string) {
  assert(
    !Object.keys(process.env).some((k) => /(?:NODE|RPC|ANVIL).*URL/i.test(k) && process.env[k]),
    'Offline fixture generator refuses node/RPC URLs',
  );
  assert(
    isAbsolute(directory) && resolve(directory) === directory,
    'Canonical absolute fresh directory required',
  );
  assert(
    !directory.startsWith(resolve(process.env.HOME ?? '/', '.local/share/ans') + '/'),
    'Historical credential tree refused',
  );
  assert.equal(await realpath(dirname(directory)), dirname(directory), 'Symlink parent refused');
  const parent = await lstat(dirname(directory));
  assert(parent.isDirectory());
  // Fixed small scalars are intentional published fixtures; no entropy source, seed input or network.
  const actors = await Promise.all(
    [1n, 2n, 3n].map(async (i) => {
      const secret = new Fr(i),
        salt = new Fr(i + 10n),
        signingKey = new Fq(i + 20n);
      return {
        role: ['A', 'B', 'C'][Number(i - 1n)],
        secret: secret.toString(),
        salt: salt.toString(),
        signingKey: signingKey.toString(),
        address: (await getSchnorrAccountContractAddress(signingKey, salt, secret)).toString(),
      };
    }),
  );
  const fundingFixture = `0x${'01'.repeat(32)}` as const;
  const metadata = {
    warning: FIXTURE_WARNING,
    toolchain: '6.0.0',
    l1Library: 'viem@2.57.1',
    accountClassId: (
      await getContractClassFromArtifact(SchnorrAccountContractArtifact)
    ).id.toString(),
    actors: actors.map(({ role, address }) => ({ role, address })),
    fundingFixtureAddress: privateKeyToAccount(fundingFixture).address,
  };
  await mkdir(directory, { mode: 0o700 }); // Existing directory is always an error.
  for (const [name, value] of [
    ['TEST-ONLY.json', { warning: FIXTURE_WARNING, actors, fundingFixture }],
    ['public-fixtures.json', metadata],
  ] as const) {
    const file = await open(
      join(directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
  return {
    warning: FIXTURE_WARNING,
    publicMetadataSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
  };
}
