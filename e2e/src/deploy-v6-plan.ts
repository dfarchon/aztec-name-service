/** Pure deployment planning: no node, wallet, state or other I/O. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reservedListHash } from './launch-policy.js';
import { V6_PROFILES, assertV6Url, type V6Network } from './v6-network.js';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const ZERO = `0x${'0'.repeat(64)}`;
export const DEPLOY_STEPS = ['deploy-token', 'deploy-registry', 'deploy-resolver', 'deploy-registrar', 'bootstrap'] as const;
export type LaunchOptions = { registryVersion?: 6 | 7; minPublicLength?: number; initialPaused?: boolean; maxRenewAhead?: string; reservedLabels?: string[]; reservedList?: string };
export type Config = LaunchOptions & { network: V6Network; registryVersion: 6 | 7; feePayment: 'sponsored' | 'fee-juice'; minFeeJuice?: bigint; nodeUrl: string; registrar: 'flat' | 'tiered' | 'launch'; priceVersion: number; token: 'official' | 'repo' | 'none'; treasury?: string; pricing: string; tokenName: string; tokenSymbol: string; stateDir: string; manifestOut: string; dryRun: boolean; confirm?: string; rebroadcast?: string };
export type Policy = LaunchOptions & { reservedListHash?: string; registrar: Config['registrar']; priceVersion: number; token: Config['token']; treasury: string; annualPrice: string; lengthPrices: { '3': string; '4': string } | null; tokenName: string; tokenSymbol: string; decimals: number };
export type Manifest = LaunchOptions & { reservedListHash?: string; reservedVerified?: boolean; schema: string; network: V6Network; aztecVersion: string; protocol: number; nodeUrl: string; chainId: string; rollupVersion: string; rollup: string; realProofs: boolean; sponsoredFpc: string | null; feePayment?: 'fee-juice'; registry: string; resolver: string; registrar: string; registrarKind: Config['registrar']; legacy: string; feeToken: string; feeTokenSource: Config['token']; feeTokenClassId: string; feeSymbol: string; feeDecimals: number; treasury: string; annualPrice: string; lengthPrices: Policy['lengthPrices']; priceVersion: number; classIds: Record<string, string>; owner: string; transactions: Record<string, string>; generator: string; deployedAt: string; sample?: boolean };
export function within(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
}
export function assertPrivateDir(path: string, network: V6Network, home = homedir(), repo = REPO, feePayment: Config['feePayment'] = V6_PROFILES[network].feePayment) {
  if (within(repo, path)) throw new Error('State must remain outside the repository');
  const base = join(home, '.local/share/ans');
  for (const other of ['local', 'testnet', 'mainnet']) {
    const own = network === 'testnet-v6' ? 'testnet' : network;
    if (other !== own && within(join(base, `${other}-aztec6-6.0.0`), path)) throw new Error('Local, testnet and mainnet state directories must differ');
  }
  if (network === 'testnet-v6' && feePayment === 'fee-juice' && !/^testnet-aztec6-6\.0\.0-nofpc-rehearsal-\d{8}$/.test(basename(path))) throw new Error('Fee Juice rehearsal requires a dated nofpc-rehearsal state directory');
  if (within(join(base, network === 'local' ? 'testnet-aztec6-6.0.0' : 'local-aztec6-6.0.0'), path)) throw new Error('Local and testnet state directories must differ');
  const top = relative(base, resolve(path)).split('/')[0];
  if (within(base, path) && /(^|[-_])v?[2-5](\.\d+){0,2}([-_]|$)/.test(top)) throw new Error('Legacy state directories are forbidden');
  for (const legacy of ['testnet-v5.2.1', 'testnet-v4-5.2.1', 'testnet-v5-5.2.1', 'testnet-tiered-5.2.1', 'testnet-5.2.1'])
    if (within(join(base, legacy), path)) throw new Error('Legacy state directories are forbidden');
}
export function confirmation(c: LaunchOptions & Pick<Config, 'registrar' | 'priceVersion' | 'token' | 'treasury'> & Partial<Pick<Config, 'network' | 'feePayment'>>) {
  const network = c.network === 'mainnet' ? 'mainnet' : 'testnet-v6';
  const p = V6_PROFILES[network];
  return `${network}:${p.nodeVersion}:${p.chainId}:${p.rollupVersion}:${p.rollup}:registryVersion=${c.registryVersion ?? 6}:registrar=${c.registrar}:priceVersion=${c.priceVersion}:token=${c.token}:treasury=${c.treasury}${c.feePayment === 'fee-juice' ? ':fee=fee-juice' : ''}${c.registrar==='launch'?`:min=${c.minPublicLength}:paused=${c.initialPaused}:maxRenewAhead=${c.maxRenewAhead}:reserved=${reservedListHash(c.reservedLabels??[])}`:''}`;
}
export function parseOptions(argv: string[], env: { home?: string; repo?: string } = {}): Config {
  const values = new Map<string, string>();
  const flags = new Set(['dry-run']);
  const allowed = new Set(['network', 'registry-version', 'node-url', 'registrar', 'price-version', 'token', 'treasury', 'pricing', 'token-name', 'token-symbol', 'state-dir', 'manifest-out', 'confirm', 'rebroadcast', 'fee-payment', 'min-fee-juice', 'min-public-length', 'initial-paused', 'max-renew-ahead', 'reserved-list', ...flags]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.has(key) || values.has(key)) throw new Error('Unknown or duplicate deployment option');
    if (flags.has(key)) values.set(key, 'true');
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Deployment option requires a value'); values.set(key, argv[++i]); }
  }
  const network = values.get('network');
  if (network !== 'local' && network !== 'testnet-v6' && network !== 'mainnet') throw new Error('--network local|testnet-v6|mainnet is required');
  const registryFlag = values.get('registry-version') ?? (network === 'mainnet' ? '7' : '6');
  if (!['6', '7'].includes(registryFlag)) throw new Error('--registry-version must be 6|7');
  const registryVersion = Number(registryFlag) as 6 | 7;
  if (network === 'mainnet' && registryVersion !== 7) throw new Error('Mainnet requires registry version 7');
  if (network === 'testnet-v6' && registryVersion !== 6) throw new Error('Testnet requires registry version 6');
  const feePayment = values.get('fee-payment') ?? V6_PROFILES[network].feePayment;
  if (feePayment !== 'sponsored' && feePayment !== 'fee-juice') throw new Error('Fee payment must be sponsored|fee-juice');
  if (network === 'mainnet' && feePayment !== 'fee-juice') throw new Error('Mainnet blocked: fee payment must be fee-juice');
  const min = values.get('min-fee-juice');
  if (min !== undefined && !/^[1-9][0-9]*$/.test(min)) throw new Error('--min-fee-juice requires positive wei');
  if (feePayment === 'fee-juice' && network !== 'local' && !min) throw new Error('--min-fee-juice must be explicit on public networks');
  const registrar = values.get('registrar');
  if (registrar !== 'flat' && registrar !== 'tiered' && registrar !== 'launch') throw new Error('--registrar flat|tiered|launch is required');
  const pv = values.get('price-version') ?? '';
  const priceVersion = Number(pv);
  if (!/^[1-9][0-9]*$/.test(pv) || !Number.isSafeInteger(priceVersion) || priceVersion > 4294967295) throw new Error('--price-version must be an explicit positive u32 integer');
  const token = values.get('token') ?? 'official';
  if (token !== 'official' && token !== 'repo' && token !== 'none') throw new Error('--token must be official|repo|none');
  if (token === 'none' && registrar !== 'launch') throw new Error('token none requires launch registrar');
  const minPublicLength=Number(values.get('min-public-length')??7);
  const maxRenewAhead=values.get('max-renew-ahead')??(network==='mainnet'?'31536000':'0');
  const paused=values.get('initial-paused')??'true';
  if (!Number.isInteger(minPublicLength) || minPublicLength<3 || minPublicLength>31) throw new Error('min-public-length must be 3–31');
  if (!/^(0|[1-9][0-9]*)$/.test(maxRenewAhead) || BigInt(maxRenewAhead)>10n*31536000n) throw new Error('max-renew-ahead must be 0 to 315360000 seconds (10 years; 0 disables cap)');
  if (!['true','false'].includes(paused)) throw new Error('initial-paused must be true|false');
  if (network === 'mainnet' && registrar === 'launch' && maxRenewAhead !== '31536000') throw new Error('Mainnet launch max-renew-ahead must be 31536000');
  const treasury = values.get('treasury')?.toLowerCase();
  if (treasury && (!/^0x[0-9a-f]{64}$/.test(treasury) || (token !== 'none' && BigInt(treasury) === 0n) || BigInt(treasury) >= 21888242871839275222246405745257275088548364400416034343698204186575808495617n)) throw new Error('A valid nonzero --treasury AztecAddress is required');
  const home = env.home ?? homedir(), repo = env.repo ?? REPO;
  const stateDir = resolve(values.get('state-dir') ?? join(home, `.local/share/ans/${network === 'testnet-v6' ? 'testnet' : network}-aztec6-6.0.0`));
  assertPrivateDir(stateDir, network, home, repo, feePayment);
  if ((network === 'mainnet' || (network === 'testnet-v6' && feePayment === 'fee-juice')) && !values.has('manifest-out')) throw new Error('Manifest output must be explicit outside deployments');
  const manifestOut = resolve(values.get('manifest-out') ?? (network === 'local' ? join(stateDir, 'deployment-v6.json') : join(repo, 'deployments/testnet-v6.json')));
  if ((network !== 'testnet-v6' || feePayment === 'fee-juice') && within(join(repo, 'deployments'), manifestOut)) throw new Error('Local manifest must not be written under deployments');
  if ([join(stateDir, 'state.json'), join(stateDir, 'runner.lock'), join(stateDir, 'keys.json'), join(stateDir, 'keys.json.tmp'), join(stateDir, 'bridge.json'), join(stateDir, 'l1-key.json')].includes(manifestOut)) throw new Error('Manifest cannot overwrite private state or lock');
  const c: Config = { ...(registrar === 'launch' ? {minPublicLength,initialPaused:paused==='true',maxRenewAhead,reservedList:resolve(values.get('reserved-list')??join(repo,'deployments/reserved-labels.json'))} : {}), network, registryVersion, feePayment, minFeeJuice: min ? BigInt(min) : network === 'local' ? 1n : undefined, registrar, priceVersion, token, treasury, stateDir, manifestOut, nodeUrl: values.get('node-url') ?? V6_PROFILES[network].nodeUrl ?? '', pricing: resolve(values.get('pricing') ?? join(repo, 'deployments/aztec-pricing.json')), tokenName: values.get('token-name') ?? 'mAZTEC', tokenSymbol: values.get('token-symbol') ?? 'mAZTEC', dryRun: values.has('dry-run'), confirm: values.get('confirm'), rebroadcast: values.get('rebroadcast') };
  if (!c.nodeUrl) throw new Error('--node-url is required for mainnet');
  assertV6Url(network, c.nodeUrl);
  if (![c.tokenName, c.tokenSymbol].every(s => /^[\x20-\x7e]{1,31}$/.test(s))) throw new Error('Token name and symbol must be printable ASCII of 1–31 bytes');
  if (c.rebroadcast && !(DEPLOY_STEPS as readonly string[]).includes(c.rebroadcast) && !(c.registrar==='launch' && /^seed-reserved-[0-9]+$/.test(c.rebroadcast))) throw new Error('Unknown rebroadcast step');
  return c;
}
export function finalizeConfig(c: Config, keysTreasury?: string): Config {
  if (c.treasury && keysTreasury && c.treasury.toLowerCase() !== keysTreasury.toLowerCase()) throw new Error('Treasury does not match keys file');
  c = { ...c, treasury: c.treasury ?? keysTreasury ?? (c.token==='none'?ZERO:undefined) };
  if (c.network !== 'local' && !c.treasury) throw new Error('A valid nonzero --treasury AztecAddress is required');
  if (c.network !== 'local' && !c.dryRun && c.confirm !== confirmation(c)) throw new Error('Exact --confirm is required before any network I/O');
  return c;
}
export function parseArgs(argv: string[], env: { home?: string; repo?: string } = {}): Config {
  return finalizeConfig(parseOptions(argv, env));
}
export function parseInitKeysArgs(argv: string[], env: { home?: string; repo?: string } = {}) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (values.has(key)) throw new Error('Unknown or duplicate deployment option');
    if (!['--init-keys', '--network', '--state-dir'].includes(key)) throw new Error('--init-keys accepts only --network and --state-dir');
    if (key === '--init-keys') values.set(key, 'true');
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--init-keys option requires a value');
      values.set(key, argv[++i]);
    }
  }
  const network = values.get('--network');
  if (!values.has('--init-keys') || (network !== 'local' && network !== 'testnet-v6')) throw new Error('--network local|testnet-v6 is required');
  const home = env.home ?? homedir(), repo = env.repo ?? REPO;
  const stateDir = resolve(values.get('--state-dir') ?? join(home, `.local/share/ans/${network === 'local' ? 'local' : 'testnet'}-aztec6-6.0.0`));
  const assertPath = (path: string) => {
    assertPrivateDir(path, network, home, repo);
    if (within(path, repo)) throw new Error('State must not contain repository');
  };
  assertPath(stateDir);
  return { network: network as 'local' | 'testnet-v6', stateDir, assertPath };
}
export function makePolicy(c: Config, pricing: { decimals: number; annualPrice: string; lengthPrices?: { '3': string; '4': string } }, treasury: string): Policy {
  if(c.token==='none') return {...(c.registryVersion===7?{registryVersion:7 as const}:{}),registrar:c.registrar,priceVersion:c.priceVersion,token:c.token,treasury,annualPrice:'0',lengthPrices:{'3':'0','4':'0'},tokenName:c.tokenName,tokenSymbol:'FREE',decimals:18,minPublicLength:c.minPublicLength??7,initialPaused:c.initialPaused??true,maxRenewAhead:c.maxRenewAhead??'0',reservedLabels:c.reservedLabels??[],reservedListHash:reservedListHash(c.reservedLabels??[])};
  const positive = (x: unknown) => typeof x === 'string' && /^[1-9][0-9]*$/.test(x) && BigInt(x) < (1n << 128n);
  if (pricing.decimals !== 18 || !positive(pricing.annualPrice) || (c.registrar !== 'flat' && (!positive(pricing.lengthPrices?.['3']) || !positive(pricing.lengthPrices?.['4'])))) throw new Error('Invalid 18-decimal pricing policy');
  return { ...(c.registryVersion===7?{registryVersion:7 as const}:{}), ...(c.registrar==='launch'?{minPublicLength:c.minPublicLength??7,initialPaused:c.initialPaused??true,maxRenewAhead:c.maxRenewAhead??'0',reservedLabels:c.reservedLabels??[],reservedListHash:reservedListHash(c.reservedLabels??[])}:{}), registrar: c.registrar, priceVersion: c.priceVersion, token: c.token, treasury, annualPrice: pricing.annualPrice, lengthPrices: c.registrar !== 'flat' ? { '3': pricing.lengthPrices!['3'], '4': pricing.lengthPrices!['4'] } : null, tokenName: c.tokenName, tokenSymbol: c.tokenSymbol, decimals: pricing.decimals };
}
export function configHash(policy: Policy): string {
  const canonical = (value: unknown): string => value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value);
  return createHash('sha256').update(canonical(policy)).digest('hex');
}
/** Whitelist projection: keys, salts and wallet data cannot enter public output. */
export function buildManifest(c: Config, p: Policy, identity: { chainId: string; rollupVersion: string; rollup: string }, a: Record<string, string>, classIds: Record<string, string>, transactions: Record<string, string>, deployedAt: string): Manifest {
  return { ...(p.registrar==='launch'?{minPublicLength:p.minPublicLength,initialPaused:p.initialPaused,maxRenewAhead:p.maxRenewAhead,reservedListHash:p.reservedListHash,reservedVerified:true}:{}), schema: 'ans-deployment-v6/1', network: c.network, aztecVersion: '6.0.0', protocol: c.registryVersion, ...(c.registryVersion===7?{registryVersion:7}:{}), nodeUrl: c.nodeUrl, ...identity, realProofs: V6_PROFILES[c.network].realProofs, ...(c.feePayment === 'fee-juice' ? { feePayment: 'fee-juice' as const, sponsoredFpc: null } : { sponsoredFpc: a.sponsoredFpc }), registry: a.registry, resolver: a.resolver, registrar: a.registrar, registrarKind: p.registrar, legacy: ZERO, feeToken: a.token, feeTokenSource: p.token, feeTokenClassId: classIds.token, feeSymbol: p.tokenSymbol, feeDecimals: p.decimals, treasury: p.treasury, annualPrice: p.annualPrice, lengthPrices: p.lengthPrices, priceVersion: p.priceVersion, classIds: { registry: classIds.registry, resolver: classIds.resolver, registrar: classIds.registrar, token: classIds.token }, owner: a.owner, transactions: Object.fromEntries(Object.entries(transactions).filter(([step])=>deploymentSteps(c).includes(step)||(c.registrar==='launch'&&/^seed-reserved-[0-9]+$/.test(step)))), generator: 'e2e/src/deploy-v6.ts', deployedAt };
}
export function deploymentPlan(c: Config, p: Policy, identity: { chainId: string; rollupVersion: string; rollup: string }, addresses: Record<string, string>, classIds: Record<string, string>, addressNotice = 'No keys generated; owner/deployer and contract addresses are pending formal local key generation') {
  return { dryRun: true, network: c.network, registryVersion: c.registryVersion, nodeUrl: c.nodeUrl, identity, policy: p, confirm: c.network !== 'local' ? confirmation(c) : null, addressNotice, addresses: Object.fromEntries(['owner', 'treasury', 'token', 'registry', 'resolver', 'registrar', 'sponsoredFpc'].map(k => [k, addresses[k]])), classIds: Object.fromEntries(['registry', 'resolver', 'registrar', 'token'].map(k => [k, classIds[k]])), steps: ['preflight', ...deploymentSteps(c), 'readback', 'manifest'] };
}

export function deploymentSteps(c: Pick<Config,'registrar'|'token'>): string[] { return [...(c.token==='none'?[]:['deploy-token']), 'deploy-registry','deploy-resolver','deploy-registrar', ...(c.registrar==='launch'?['seed-reserved','verify-reserved']:[]), 'bootstrap']; }

/** Actual broadcast checkpoints exclude read-only verification and expand reservation batches. */
export function deploymentTransactionSteps(c: Pick<Config,'registrar'|'token'|'reservedLabels'>): string[] {
  return deploymentSteps(c).flatMap(step => step === 'verify-reserved' ? [] : step === 'seed-reserved'
    ? Array.from({length: Math.ceil((c.reservedLabels?.length ?? 0) / 32)}, (_, i) => `seed-reserved-${i}`)
    : [step]);
}
