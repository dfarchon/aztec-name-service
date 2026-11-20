import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { NameRegistryV5Contract } from '../artifacts/NameRegistryV5.js';
import { FogError } from '../core/errors.js';
import { normalizeName } from '../core/label.js';
import { registryProtocol } from '../core/registry-protocol.js';
import type { FogContext } from '../wallet/context.js';
import { assertHoldingAccess, inspectHolding, type NameRef } from './holding.js';
import { runTx, type TxOptions } from './tx.js';

async function core(ctx: FogContext) {
  if (!ctx.reader.modular) {
    throw new FogError('invalid_argument', 'this registry does not support contract modules');
  }
  return (await ctx.contract()) as {
    methods: Pick<NameRegistryV5Contract['methods'], 'migrate' | 'set_resolver'>;
  };
}

/** Points a single name's resolution module to a verified `NameResolver` bound to this registry. */
export async function setResolver(
  ctx: FogContext,
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

/** Migrates an active or grace-period legacy name into a modular registry for its current holder. */
export async function migrateName(ctx: FogContext, name: NameRef, opts?: TxOptions) {
  const h = await inspectHolding(ctx, name);
  if (h.record.generation !== 0) {
    throw new FogError('conflict', 'name already exists in this registry');
  }
  const old = await ctx.reader.getLegacyName(h.node, h.snapshot);
  if (!old?.owner.equals(ctx.account)) {
    throw new FogError('not_holder', 'this account does not hold the legacy name');
  }
  const label = typeof name === 'string' ? normalizeName(name) : name;
  const contract = await core(ctx);
  return { tx: await runTx(ctx, contract.methods.migrate(label.bytes, label.len), opts) };
}

async function configurationSnapshot(ctx: FogContext) {
  const snapshot = await ctx.reader.snapshot();
  const administrator = await ctx.reader.getAdministrator(snapshot);
  if (!administrator) {
    throw new FogError('unsupported', 'this deployment does not support direct configuration');
  }
  if (!administrator.equals(ctx.account)) {
    throw new FogError('not_administrator', 'this account cannot configure the registry');
  }
  return snapshot;
}

/**
 * Replaces the active Registrar and default Resolver immediately upon confirmation.
 * Both modules must match supported classes and bind immutably to `ctx.reader.registry`.
 */
export async function configureModules(
  ctx: FogContext,
  args: { registrar: AztecAddress; resolver: AztecAddress },
  opts?: TxOptions,
) {
  const snapshot = await configurationSnapshot(ctx);
  const [modules] = await Promise.all([
    ctx.reader.getModules(snapshot),
    ctx.reader.assertModule(args.registrar, 'registrar', snapshot),
    ctx.reader.assertModule(args.resolver, 'resolver', snapshot),
  ]);
  const contract = (await ctx.extendedContract()) as {
    methods: Pick<NameRegistryV5Contract['methods'], 'configure_modules'>;
  };
  return {
    tx: await runTx(
      ctx,
      contract.methods.configure_modules(modules.revision, args.registrar, args.resolver),
      opts,
    ),
  };
}

/** Direct administrator rotation on V5; V6+ requires two-step nomination and acceptance. */
export async function setAdministrator(
  ctx: FogContext,
  administrator: AztecAddress,
  opts?: TxOptions,
) {
  if (administrator.isZero()) {
    throw new FogError('invalid_argument', 'administrator must not be zero');
  }
  await configurationSnapshot(ctx);
  if (registryProtocol(ctx.reader.classId).version >= 6) {
    throw new FogError(
      'unsupported',
      'V6/V7/V8 administration requires nomination and acceptance via the matching bindings',
    );
  }
  const contract = (await ctx.contract()) as {
    methods: Pick<NameRegistryV5Contract['methods'], 'set_administrator'>;
  };
  return { tx: await runTx(ctx, contract.methods.set_administrator(administrator), opts) };
}
