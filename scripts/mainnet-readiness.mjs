import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
export const MAINNET_ADMIN_DENYLIST = new Set(['0x2419a5bafa9cd88d6a625c21b96f16f79bf6e279253b1993609a3edc169f8c68']);
export const isPlaceholderAdmin = (admin) => typeof admin === 'string' && MAINNET_ADMIN_DENYLIST.has(admin.toLowerCase());
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
  if (
    m.adminPlaceholder === true ||
    isPlaceholderAdmin(m.admin) ||
    isPlaceholderAdmin(m.owner) ||
    isPlaceholderAdmin(m.treasury)
  )
    blockers.push('admin placeholder');
  if (m.protocol !== 8) blockers.push('protocol 8 required');
  if (m.registryVersion !== undefined && m.registryVersion !== 8)
    blockers.push('registryVersion 8 required');
  if (m.allowRehearsalSuccessor === true) blockers.push('allowRehearsalSuccessor forbidden');
  const free =
    m.registrarKind === 'launch' &&
    m.annualPrice === '0' &&
    (m.feeToken === null || /^0x0{64}$/.test(m.feeToken ?? '')) &&
    m.feeTokenSource === 'none';
  if (!free && absent(pricing.settlement?.l2Token)) blockers.push('settlement.l2Token');
  if (!free && pricing.annualPriceStatus !== 'final') blockers.push('annualPriceStatus provisional');
  for (const key of ['admin', ...(!free ? ['treasury'] : []), 'domain', 'nodeUrl'])
    if (absent(m[key])) blockers.push(key === 'admin' ? 'admin/multisig' : key);
  if (!['flat', 'tiered', 'launch'].includes(m.registrarKind)) blockers.push('registrarKind');
  if (m.registrarKind === 'launch') {
    if (read('deployments/reserved-labels.json').minLength !== m.minPublicLength)
      blockers.push('reserved minLength must equal minPublicLength');
    if (!Number.isInteger(m.minPublicLength) || m.minPublicLength < 3 || m.minPublicLength > 31)
      blockers.push('minPublicLength');
    if (!/^[a-f0-9]{64}$/.test(m.reservedListHash ?? '')) blockers.push('reservedListHash');
    if (m.maxRenewAhead !== '31536000') blockers.push('maxRenewAhead');
    if (m.reservedVerified !== true) blockers.push('reservedVerified');
  }
  for (const [name, c] of [
    ['site', site],
    ['monitor', monitor],
  ]) {
    if (absent(c.vars?.SITE_URL)) blockers.push(`${name}.SITE_URL`);
    if (absent(c.vars?.RPC_URL)) blockers.push(`${name}.RPC_URL`);
    else if (!absent(m.nodeUrl) && c.vars.RPC_URL !== m.nodeUrl)
      blockers.push(`${name}.RPC_URL mismatch`);
    if (absent(c.vars?.REGISTRY)) blockers.push(`${name}.REGISTRY`);
    else if (!absent(m.registry) && c.vars.REGISTRY !== m.registry)
      blockers.push(`${name}.REGISTRY mismatch`);
    if ('ALLOW_V8_REHEARSAL_SUCCESSOR' in (c.vars ?? {}))
      blockers.push(`${name}.ALLOW_V8_REHEARSAL_SUCCESSOR forbidden`);
    if (absent(c.name) || /PLACEHOLDER/i.test(c.name)) blockers.push(`${name}.worker name`);
    if (absent(c.d1_databases?.[0]?.database_name)) blockers.push(`${name}.D1 name`);
    if (
      !c.d1_databases?.[0]?.database_id ||
      c.d1_databases[0].database_id === '00000000-0000-0000-0000-000000000000'
    )
      blockers.push(`${name}.D1 id`);
  }
  if (absent(site.services?.[0]?.service)) blockers.push('site.monitor service');
  else if (!absent(monitor.name) && site.services[0].service !== monitor.name)
    blockers.push('site.monitor service mismatch');
  for (const binding of ['RUM_LIMITER', 'RPC_LIMITER'])
    if (absent(site.ratelimits?.find((limiter) => limiter.name === binding)?.namespace_id))
      blockers.push(`site.${binding} namespace_id`);
  if (!existsSync(new URL('deployments/mainnet.json', root)))
    blockers.push('deployments/mainnet.json absent');
  else if (m.template === true) blockers.push('canonical manifest is a template');
  return blockers;
}
export function assertMainnetReady(root = repository) {
  const blockers = mainnetBlockers(root);
  if (blockers.length) throw new Error(`Mainnet blocked: ${blockers.join(', ')}`);
}
