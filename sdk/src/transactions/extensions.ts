import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { AnsError } from '../core/errors.js';
import { nodeOf } from '../core/hash.js';
import { normalizeName } from '../core/label.js';
import {
  chainAddressKey,
  encodeRecordKey,
  encodeTextValue,
  validateChainAddress,
} from '../core/records.js';
import type { AnsContext } from '../wallet/context.js';
import { assertHoldingAccess, inspectHolding, type NameRef } from './holding.js';
import { runTx, type TxOptions } from './tx.js';

async function state(ctx: AnsContext, name: NameRef, access: 'owner' | 'editor' = 'owner') {
  await ctx.reader.assertCurrentClass();
  const contract = ctx.extendedContract(),
    h = await inspectHolding(ctx, name);
  assertHoldingAccess(h, access);
  return { contract, ...h };
}
export async function setManager(
  ctx: AnsContext,
  args: { name: NameRef; manager: AztecAddress },
  opts?: TxOptions,
) {
  const h = await state(ctx, args.name);
  return {
    tx: await runTx(
      ctx,
      h.contract.methods.set_manager(h.node, h.record.generation, h.record.revision, args.manager),
      opts,
    ),
  };
}
/** Recipient must accept within seven days. Pass ZERO to cancel. */
export async function offerTransfer(
  ctx: AnsContext,
  args: { name: NameRef; recipient: AztecAddress },
  opts?: TxOptions,
) {
  const h = await state(ctx, args.name);
  if (args.recipient.equals(ctx.account))
    throw new AnsError('invalid_argument', 'recipient already owns this name');
  return {
    tx: await runTx(
      ctx,
      h.contract.methods.offer_transfer(
        h.node,
        h.record.generation,
        h.record.revision,
        args.recipient,
      ),
      opts,
    ),
  };
}
export async function acceptTransfer(ctx: AnsContext, args: { name: NameRef; acceptUnverifiedResolver?: boolean }, opts?: TxOptions) {
  await ctx.reader.assertCurrentClass();
  const contract = ctx.extendedContract(),
    h = await inspectHolding(ctx, args.name);
  const offer = await ctx.reader.getTransfer(h.node, h.record.generation, h.snapshot);
  if (
    h.status !== 'active' ||
    !offer.recipient.equals(ctx.account) ||
    offer.expiresAt <= h.snapshot.timestamp
  )
    throw new AnsError('invalid_argument', 'no active transfer offer for this account');
  const resolverReset = ctx.reader.deployment.protocolVersion >= 7;
  const resolver = resolverReset ? undefined : await ctx.reader.inspectResolver(h.node, h.record.generation, h.snapshot);
  if (resolver && !resolver.verified && args.acceptUnverifiedResolver !== true)
    throw new AnsError('invalid_argument', 'inherited resolver is unverified; explicitly accept the risk and reset to the default resolver after acceptance');
  return {
    resolverReset,
    resolver,
    tx: await runTx(
      ctx,
      contract.methods.accept_transfer(h.node, h.record.generation, h.record.revision),
      opts,
    ),
  };
}
export async function issueSubname(
  ctx: AnsContext,
  args: {
    parent: NameRef;
    label: string;
    owner: AztecAddress;
    expiresAt: bigint;
    replaceExisting?: boolean;
  },
  opts?: TxOptions,
) {
  const h = await state(ctx, args.parent),
    leaf = normalizeName(args.label);
  const label = normalizeName(`${leaf.label}.${h.label.label}`, { allowSubnames: true });
  const node = await nodeOf(label),
    previous = await ctx.reader.getName(node, h.snapshot);
  if (previous.generation && !args.replaceExisting)
    throw new AnsError('invalid_argument', 'subname exists; explicitly allow replacement');
  if (
    args.owner.isZero() ||
    args.expiresAt <= h.snapshot.timestamp ||
    args.expiresAt > h.record.expiresAt
  )
    throw new AnsError(
      'invalid_argument',
      'subname expiry must be in the future and within the parent lease',
    );
  return {
    name: label.label,
    tx: await runTx(
      ctx,
      h.contract.methods.issue_subname(
        h.node,
        h.record.generation,
        h.record.revision,
        leaf.bytes,
        leaf.len,
        previous.generation,
        args.owner,
        args.expiresAt,
      ),
      opts,
    ),
  };
}
export async function revokeSubname(ctx: AnsContext, args: { name: string }, opts?: TxOptions) {
  const label = normalizeName(args.name, { allowSubnames: true });
  if (!label.parent) throw new AnsError('invalid_argument', 'root names cannot be revoked');
  const parent = await state(ctx, label.parent),
    node = await nodeOf(label),
    child = await ctx.reader.getName(node, parent.snapshot);
  return {
    tx: await runTx(
      ctx,
      parent.contract.methods.revoke_subname(
        node,
        child.generation,
        parent.record.generation,
        parent.record.revision,
      ),
      opts,
    ),
  };
}
export async function setTextRecord(
  ctx: AnsContext,
  args: { name: NameRef; key: string; value: string },
  opts?: TxOptions,
) {
  const key = encodeRecordKey(args.key),
    value = encodeTextValue(args.value);
  if (args.key.startsWith('address:')) validateChainAddress(args.key.slice(8), args.value);
  const h = await state(ctx, args.name, 'editor');
  return {
    tx: await runTx(
      ctx,
      h.contract.methods.set_text(
        h.node,
        h.record.generation,
        h.recordRevision,
        key,
        value.bytes,
        value.length,
      ),
      opts,
    ),
  };
}
export async function setChainAddress(
  ctx: AnsContext,
  args: { name: NameRef; chain: string; address: string },
  opts?: TxOptions,
) {
  return setTextRecord(
    ctx,
    {
      name: args.name,
      key: chainAddressKey(args.chain),
      value: validateChainAddress(args.chain, args.address),
    },
    opts,
  );
}
