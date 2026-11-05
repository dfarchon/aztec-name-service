/** Fully offline placeholder only. Run manually outside the executor sandbox; never deploys an account. */
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSchnorrAccountContractAddress } from '@aztec-labs/accounts/schnorr';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';

type Options = { baseDir: string; dirName?: string };
export function placeholderOptions(argv: string[], env = process.env): Options {
  if (argv.some(arg => arg.includes('://')) || (argv.length !== 0 && (argv.length !== 2 || argv[0] !== '--dir-name')))
    throw new Error('Only --dir-name with a local directory name is supported');
  const dirName = argv[1];
  if (dirName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,80}$/.test(dirName)) throw new Error('Invalid placeholder directory name');
  return { baseDir: resolve(env.ANS_DATA_DIR ?? join(env.HOME ?? homedir(), '.local/share/ans')), dirName };
}
const defaultDeps = {
  now: () => new Date(),
  randomKeys: () => ({ secret: Fr.random(), salt: Fr.random(), signingKey: Fq.random() }),
  randomSalt: () => Fr.random(),
  write: (fd: number, bytes: string) => { writeFileSync(fd, bytes); },
};
/** Tests inject an isolated writable base and capture the exact bytes passed to write, without reading a key file. */
export async function generatePlaceholderAdmin(options: Options, deps = defaultDeps): Promise<{ address: string; dir: string }> {
  process.umask(0o077);
  const now = deps.now();
  const dirName = options.dirName ?? `mainnet-placeholder-admin-${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,80}$/.test(dirName)) throw new Error('Invalid placeholder directory name');
  mkdirSync(options.baseDir, { recursive: true, mode: 0o700 });
  const dir = join(options.baseDir, dirName);
  mkdirSync(dir, { mode: 0o700 }); // Intentionally nonrecursive and exclusive; an existing directory must fail.
  const keys = deps.randomKeys();
  // 6.0.0 takes signing key, salt, privacy secret in this order. No node, PXE or transaction is involved.
  const address = (await getSchnorrAccountContractAddress(keys.signingKey, keys.salt, keys.secret)).toString();
  const account = { address, secret: keys.secret.toString(), salt: keys.salt.toString(), signingKey: keys.signingKey.toString() };
  // Preserve the existing keys-file field names and owner/treasury/salts shape. This mainnet placeholder is
  // deliberately not accepted by the local/testnet initializerless deployment runner or readiness checks.
  const value = { schema: 'ans-v6-keys/1', toolchainVersion: '6.0.0', network: 'mainnet', createdAt: now.toISOString(),
    owner: account, treasury: { ...account }, salts: Object.fromEntries(['token', 'registry', 'resolver', 'registrar'].map(key => [key, deps.randomSalt().toString()])) };
  const fd = openSync(join(dir, 'keys.json'), 'wx', 0o600);
  try {
    deps.write(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd);
    const file = fstatSync(fd);
    if (!file.isFile() || (file.mode & 0o777) !== 0o600) throw new Error('Placeholder file must have mode 0600');
  } finally { closeSync(fd); }
  const directory = lstatSync(dir), file = lstatSync(join(dir, 'keys.json'));
  if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700 || !file.isFile() || (file.mode & 0o777) !== 0o600)
    throw new Error('Placeholder permissions check failed');
  return { address, dir };
}
export async function placeholderMain(argv = process.argv.slice(2), output: (text: string) => void = text => process.stdout.write(text)) {
  const result = await generatePlaceholderAdmin(placeholderOptions(argv));
  output(JSON.stringify(result) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  placeholderMain().catch(error => {
    process.stderr.write((error?.code === 'EEXIST' ? 'Placeholder directory or file already exists (EEXIST)' : 'Offline placeholder generation failed') + '\n');
    process.exitCode = 1;
  });
}
