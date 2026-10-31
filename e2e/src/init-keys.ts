/** Offline key generation. Never serialize errors or private key material to output. */
import { promises as fs, constants, type Stats } from 'node:fs';
import { getSchnorrInitializerlessAccountContractAddress } from '@aztec-labs/accounts/schnorr';
import { Fr, Fq } from '@aztec-labs/aztec.js/fields';
import { randomKeys } from './common.js';

export const KEYS_SCHEMA = 'ans-v6-keys/1';
export type KeyNetwork = 'local' | 'testnet-v6';
type Account = { address: string; secret: string; salt: string; signingKey: string };
export type KeysFile = { schema: typeof KEYS_SCHEMA; toolchainVersion: '6.0.0'; network: KeyNetwork; createdAt: string; owner: Account; treasury: Account; salts: Record<'token' | 'registry' | 'resolver' | 'registrar', string> };
export type PublicKeys = { owner: string; treasury: string; salts: KeysFile['salts'] };
export type InitConfig = { network: KeyNetwork; stateDir: string; assertPath: (path: string) => void };
const saltNames = ['token', 'registry', 'resolver', 'registrar'] as const;
const refuse = () => new Error('Keys file or deployment state already exists; refusing to overwrite');
const invalid = () => new Error('Keys file validation failed');
function shape(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw invalid();
}
function field(value: unknown, signing = false): asserts value is string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw invalid();
  try { if ((signing ? Fq.fromString(value) : Fr.fromString(value)).toBigInt() !== BigInt(value)) throw invalid(); } catch { throw invalid(); }
}
export async function validateKeys(value: unknown, network: KeyNetwork): Promise<KeysFile> {
  shape(value, ['schema', 'toolchainVersion', 'network', 'createdAt', 'owner', 'treasury', 'salts']);
  if (value.schema !== KEYS_SCHEMA || value.toolchainVersion !== '6.0.0' || value.network !== network || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) throw invalid();
  for (const name of ['owner', 'treasury']) {
    const a = value[name]; shape(a, ['address', 'secret', 'salt', 'signingKey']);
    for (const key of ['address', 'secret', 'salt', 'signingKey']) field(a[key], key === 'signingKey');
    const address = await getSchnorrInitializerlessAccountContractAddress(Fq.fromString(a.signingKey as string), Fr.fromString(a.salt as string), Fr.fromString(a.secret as string));
    if (address.toString() !== (a.address as string).toLowerCase()) throw invalid();
  }
  shape(value.salts, [...saltNames]);
  const salts = saltNames.map(k => { const v = value.salts as Record<string, unknown>; field(v[k]); return BigInt(v[k]); });
  if (salts.some(v => v === 0n) || new Set(salts).size !== 4 || (value.owner as Account).address.toLowerCase() === (value.treasury as Account).address.toLowerCase()) throw invalid();
  return value as unknown as KeysFile;
}
function privateStat(s: Stats, directory = false) {
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== process.getuid!() || (s.mode & 0o077) !== 0) throw new Error('Keys file permissions must be private and owned by current user');
}
export async function readKeys(path: string, network: KeyNetwork): Promise<KeysFile> {
  privateStat(await fs.lstat(path));
  // O_NOFOLLOW also closes the lstat/open symlink replacement window.
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    privateStat(await file.stat());
    let value: unknown;
    try { value = JSON.parse(await file.readFile('utf8')); } catch { throw invalid(); }
    return await validateKeys(value, network);
  } finally { await file.close(); }
}
export async function readPublicKeys(path: string, network: KeyNetwork): Promise<PublicKeys> {
  const k = await readKeys(path, network);
  return { owner: k.owner.address, treasury: k.treasury.address, salts: { ...k.salts } };
}
/** Resolve missing leaves without importing any deployment or network module. */
async function physical(path: string): Promise<string> {
  try { return await fs.realpath(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const i = path.lastIndexOf('/');
    return `${(await physical(path.slice(0, i) || '/')).replace(/\/$/, '')}/${path.slice(i + 1)}`;
  }
}
export async function initKeys(c: InitConfig, deps = { randomKeys, randomSalt: () => Fr.random(), now: () => new Date() }) {
  c.assertPath(c.stateDir);
  const dir = await physical(c.stateDir); c.assertPath(dir);
  try { privateStat(await fs.lstat(dir), true); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    try { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700); }
    catch (error) { throw error; }
    privateStat(await fs.lstat(dir), true);
  }
  for (const name of ['keys.json', 'state.json', 'runner.lock', 'keys.json.tmp']) {
    try { await fs.lstat(`${dir}/${name}`); throw refuse(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  const account = async () => {
    const k = deps.randomKeys();
    const address = await getSchnorrInitializerlessAccountContractAddress(k.signingKey, k.salt, k.secret);
    return { address: address.toString(), secret: k.secret.toString(), salt: k.salt.toString(), signingKey: k.signingKey.toString() };
  };
  let keys: KeysFile | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const owner = await account(), treasury = await account();
    const salts = Object.fromEntries(saltNames.map(k => [k, deps.randomSalt().toString()])) as KeysFile['salts'];
    if (owner.address !== treasury.address && !Object.values(salts).some(v => BigInt(v) === 0n) && new Set(Object.values(salts)).size === 4) {
      keys = { schema: KEYS_SCHEMA, toolchainVersion: '6.0.0', network: c.network, createdAt: deps.now().toISOString(), owner, treasury, salts }; break;
    }
  }
  if (!keys) throw new Error('Keys generation collision after retry');
  const tmp = `${dir}/keys.json.tmp`, path = `${dir}/keys.json`;
  let ownTmp = false;
  try {
    const file = await fs.open(tmp, 'wx', 0o600); ownTmp = true;
    try { await file.chmod(0o600); await file.writeFile(JSON.stringify(keys, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await fs.link(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw refuse();
    throw new Error('Keys file write failed');
  } finally { if (ownTmp) await fs.unlink(tmp); }
  const checked = await readPublicKeys(path, c.network);
  console.log(`INIT-KEYS network=${c.network} keys=${path} owner=${checked.owner} treasury=${checked.treasury}`);
  console.log('INIT-KEYS keys file is private (0600); back it up offline; it is never printed');
  return checked;
}
