import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
const repository = new URL('../', import.meta.url);
/** Local files only; must run before node construction, git, builds or deployment tools. */
export function mainnetBlockers(root = repository) {
  const read = (path) => {
    try {
      return parse(readFileSync(new URL(path, root), 'utf8'));
    } catch {
      return {};
    }
  };
  const pricing = read('deployments/aztec-pricing.json');
  const m = read('deployments/mainnet.json');
  const site = read('ops/wrangler-mainnet.jsonc');
  const monitor = read('ops/wrangler-monitor-mainnet.jsonc');
  const absent = (v) => !v || v === 'UNDECIDED';
  const blockers = [];
  const free=m.registrarKind==='launch' && m.annualPrice==='0' && (m.feeToken===null||/^0x0{64}$/.test(m.feeToken??'')) && m.feeTokenSource==='none';
  if (!free && absent(pricing.settlement?.l2Token)) blockers.push('settlement.l2Token');
  if (!free && pricing.annualPriceStatus !== 'final') blockers.push('annualPriceStatus provisional');
  for (const key of ['admin', ...(!free?['treasury']:[]), 'domain', 'nodeUrl'])
    if (absent(m[key])) blockers.push(key === 'admin' ? 'admin/multisig' : key);
  if(!['flat','tiered','launch'].includes(m.registrarKind))blockers.push('registrarKind');
  if(m.registrarKind==='launch') {
    if(!Number.isInteger(m.minPublicLength)||m.minPublicLength<3||m.minPublicLength>31)blockers.push('minPublicLength');
    if(!/^[a-f0-9]{64}$/.test(m.reservedListHash??''))blockers.push('reservedListHash');
    if(typeof m.maxRenewAhead!=='string'||!/^(0|[1-9][0-9]*)$/.test(m.maxRenewAhead)||BigInt(m.maxRenewAhead)>=(1n<<64n))blockers.push('maxRenewAhead');
    if(m.reservedVerified!==true)blockers.push('reservedVerified');
  }
  for (const [name, c] of [
    ['site', site],
    ['monitor', monitor],
  ]) {
    if (absent(c.vars?.SITE_URL)) blockers.push(`${name}.SITE_URL`);
    if (absent(c.vars?.RPC_URL)) blockers.push(`${name}.RPC_URL`);
    if (absent(c.name) || /PLACEHOLDER/i.test(c.name)) blockers.push(`${name}.worker name`);
    if (
      !c.d1_databases?.[0]?.database_id ||
      c.d1_databases[0].database_id === '00000000-0000-0000-0000-000000000000'
    )
      blockers.push(`${name}.D1 id`);
  }
  if (!existsSync(new URL('deployments/mainnet.json', root)))
    blockers.push('deployments/mainnet.json absent');
  else if (m.template === true) blockers.push('canonical manifest is a template');
  return blockers;
}
export function assertMainnetReady(root = repository) {
  const blockers = mainnetBlockers(root);
  if (blockers.length) throw new Error(`Mainnet blocked: ${blockers.join(', ')}`);
}
