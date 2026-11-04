import { AztecAddress } from '@aztec-labs/aztec.js/addresses';

import { AnsError } from '../core/errors.js';
import type { AnsContext } from '../wallet/context.js';
import {
  assertAcceptedQuote,
  type FeeQuote,
  buildFeeAuthorization,
  getFeeQuote,
  newFeeNonce,
} from './fees.js';
import { runTx, type TxOptions } from './tx.js';
import { assertHoldingAccess, inspectHolding, type NameRef } from './holding.js';
export { inspectHolding, type Holding, type NameRef } from './holding.js';

/** Sets the single public Aztec address for the current registration. */
export async function setAddress(
  ctx: AnsContext,
  args: { name: NameRef; address: AztecAddress },
  opts?: TxOptions,
) {
  if (args.address.isZero())
    throw new AnsError('invalid_argument', 'use clearAddress to remove a record');
  return writeAddress(ctx, args.name, args.address, opts);
}

export async function clearAddress(ctx: AnsContext, args: { name: NameRef }, opts?: TxOptions) {
  return writeAddress(ctx, args.name, AztecAddress.ZERO, opts);
}

async function writeAddress(
  ctx: AnsContext,
  name: NameRef,
  address: AztecAddress,
  opts?: TxOptions,
) {
  const h = await inspectHolding(ctx, name);
  assertHoldingAccess(h, 'editor');
  const { generation } = h.record;
  return {
    tx: await runTx(
      ctx,
      async () =>
        (await ctx.addressContract(h.node, generation, h.snapshot)).methods.set_address(
          h.node,
          generation,
          h.recordRevision,
          !address.isZero(),
          address,
        ),
      opts,
    ),
  };
}

/** Extends the lease (allowed while active or in grace) and pays the exact pro-rata fee. */
export async function renew(
  ctx: AnsContext,
  args: {
    name: NameRef;
    duration: bigint;
    maxFee?: bigint;
    acceptedQuote?: FeeQuote;
    quoteValiditySeconds?: bigint;
  },
  opts?: TxOptions,
) {
  const h = await inspectHolding(ctx, args.name);
  assertHoldingAccess(h, 'owner', true);
  if (h.label.parent)
    throw new AnsError('invalid_argument', 'subname leases are controlled by their parent owner');
  const quote = await getFeeQuote(ctx.reader, {
    operation: 'renew',
    expiresAt: h.record.expiresAt,
    duration: args.duration,
    labelLength: h.label.len,
    maxFee: args.maxFee,
    validForSeconds: args.quoteValiditySeconds ?? 3600n,
    snapshot: h.snapshot,
  });
  if (quote.renewableAt !== undefined && h.snapshot.timestamp < quote.renewableAt)
    throw new AnsError('renewal_too_early', `renewable from chain timestamp ${quote.renewableAt}`);
  assertAcceptedQuote(quote, args.acceptedQuote);
  const feeNonce = newFeeNonce();
  const authWitness = await buildFeeAuthorization(ctx, { ...quote, feeNonce });
  const { generation, revision } = h.record;
  const call = async () => {
    const target = await ctx.registrationTarget(quote.registrar?.toString());
    // Tiered registrars derive the node, and so the price tier, from the label.
    return (target.kind === 'registrarTiered' || target.kind === 'registrarLaunch')
      ? target.contract.methods.renew(h.label.bytes, h.label.len, generation, revision, args.duration, quote.maxFee, quote.quoteExpiry, feeNonce)
      : target.contract.methods.renew(h.node, generation, revision, args.duration, quote.maxFee, quote.quoteExpiry, feeNonce);
  };
  const tx = await runTx(ctx, call, {
    ...opts,
    authWitnesses: authWitness ? [authWitness] : undefined,
  });
  return { tx, quote };
}
