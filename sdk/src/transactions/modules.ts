import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { NameRegistryV7Contract } from '../artifacts/NameRegistryV7.js';
import { NameRegistryV6Contract } from '../artifacts/NameRegistryV6.js';
import { registryProtocols } from '../core/registry-protocol.js';
import { NameRegistryV5Contract } from '../artifacts/NameRegistryV5.js';
import { AnsError } from '../core/errors.js';
import { normalizeName } from '../core/label.js';
import { assertHoldingAccess, inspectHolding, type NameRef } from './holding.js';
import type { AnsContext } from '../wallet/context.js';
import { runTx, type TxOptions } from './tx.js';

async function core(ctx: AnsContext) {
  if (!ctx.reader.modular)
    throw new AnsError('invalid_argument', 'this registry does not support contract modules');
  return ctx.contract() as { methods: Pick<NameRegistryV5Contract['methods'], 'migrate' | 'set_resolver'> };
}

export async function setResolver(
  ctx: AnsContext,
  args: { name: NameRef; resolver: AztecAddress },
  opts?: TxOptions,
) {
  const h = await inspectHolding(ctx, args.name);
  assertHoldingAccess(h, 'owner');
  await ctx.reader.assertModule(args.resolver, 'resolver', h.snapshot);
  const contract = await core(ctx);
  return {
    tx: await runTx(
      ctx,
      contract.methods.set_resolver(h.node, h.record.generation, h.record.revision, args.resolver),
      opts,
    ),
  };
}

export async function migrateName(ctx: AnsContext, name: NameRef, opts?: TxOptions) {
  const h = await inspectHolding(ctx, name);
  if (h.record.generation !== 0)
    throw new AnsError('conflict', 'name already exists in this registry');
  const old = await ctx.reader.getLegacyName(h.node, h.snapshot);
  if (!old?.owner.equals(ctx.account))
    throw new AnsError('not_holder', 'this account does not hold the legacy name');
  const label = typeof name === 'string' ? normalizeName(name) : name;
  const contract = await core(ctx);
  return { tx: await runTx(ctx, contract.methods.migrate(label.bytes, label.len), opts) };
}

async function configurationSnapshot(ctx: AnsContext) {
  const snapshot = await ctx.reader.snapshot();
  const administrator = await ctx.reader.getAdministrator(snapshot);
  if (!administrator) throw new AnsError('unsupported', 'this deployment does not support direct configuration');
  if (!administrator.equals(ctx.account)) throw new AnsError('not_administrator', 'this account cannot configure the registry');
  return snapshot;
}

export async function configureModules(ctx: AnsContext, args: {registrar: AztecAddress; resolver: AztecAddress}, opts?: TxOptions) {
  const snapshot = await configurationSnapshot(ctx);
  const [modules] = await Promise.all([ctx.reader.getModules(snapshot), ctx.reader.assertModule(args.registrar, 'registrar', snapshot), ctx.reader.assertModule(args.resolver, 'resolver', snapshot)]);
  const contract=ctx.reader.classId === registryProtocols.v7.classId
    ? NameRegistryV7Contract.at(ctx.reader.registry, ctx.wallet)
    : ctx.reader.classId === registryProtocols.v6.classId
    ? NameRegistryV6Contract.at(ctx.reader.registry, ctx.wallet)
    : NameRegistryV5Contract.at(ctx.reader.registry, ctx.wallet);
  return {tx: await runTx(ctx, contract.methods.configure_modules(modules.revision, args.registrar, args.resolver), opts)};
}

export async function setAdministrator(ctx: AnsContext, administrator: AztecAddress, opts?: TxOptions) {
  if (administrator.isZero()) throw new AnsError('invalid_argument', 'administrator must not be zero');
  await configurationSnapshot(ctx);
  if ([registryProtocols.v6.classId, registryProtocols.v7.classId].includes(ctx.reader.classId))
    throw new AnsError('unsupported', 'V6/V7 administration requires nomination and acceptance via the matching bindings');
  const contract=NameRegistryV5Contract.at(ctx.reader.registry, ctx.wallet);
  return {tx: await runTx(ctx, contract.methods.set_administrator(administrator), opts)};
}
