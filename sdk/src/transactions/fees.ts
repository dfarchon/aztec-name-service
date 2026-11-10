import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { FunctionSelector } from "@aztec-labs/aztec.js/abi";
import {
  type AuthWitness,
  computeInnerAuthWitHash,
  computeInnerAuthWitHashFromAction,
} from "@aztec-labs/aztec.js/authorization";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { computeVarArgsHash } from "@aztec-labs/stdlib/hash";

import type { RegistryReader } from "../client/reader.js";
import {
  MAX_COMMIT_AGE,
  TRANSFER_IN_PRIVATE_SIGNATURE,
} from "../core/constants.js";
import { AnsError } from "../core/errors.js";
import { annualPriceFor, assertDuration, assertPolicyDuration, chargeFor } from "../core/lifecycle.js";
import type { RegistryConfig, Snapshot } from "../core/types.js";
import type { AnsContext } from "../wallet/context.js";

export type FeeQuote = {
  registrar?: AztecAddress;
  operation: "register" | "renew";
  duration: bigint;
  feeToken: AztecAddress;
  treasury: AztecAddress;
  /** Annual price applied to this name (its length tier on a tiered registrar). */
  annualPrice: bigint;
  priceVersion: number;
  /** Label length the price was chosen for; absent when the registrar charges one price. */
  labelLength?: number;
  /** Tiered registrars only: annual prices for 3- and 4-character labels. */
  lengthPrices?: { three: bigint; four: bigint };
  launch?: RegistryConfig["launch"];
  /** Exact amount the contract will transfer. 0 on a free registry. */
  fee: bigint;
  /** Upper bound the user accepted; the contract rejects any higher charge. */
  maxFee: bigint;
  /** Latest block timestamp at which the contract still accepts this quote. */
  quoteExpiry: bigint;
  /** Earliest chain timestamp (seconds) for this renewal; 0 means no horizon restriction.
   * Absent unless a renewal quote includes the current expiresAt. Not a lease/ownership check. */
  renewableAt?: bigint;
  snapshot: Snapshot;
};

export async function getFeeQuote(
  reader: RegistryReader,
  args: {
    operation: "register" | "renew";
    duration: bigint;
    /** Label length of the name; required by tiered registrars. */
    labelLength?: number;
    /** Current name expiry in chain seconds, to include renewableAt in a renewal quote. */
    expiresAt?: bigint;
    maxFee?: bigint;
    validForSeconds?: bigint;
    /** Reuse a snapshot the caller already took, saving a round trip. */
    snapshot?: Snapshot;
  },
): Promise<FeeQuote> {
  assertDuration(args.duration);
  const snapshot = args.snapshot ?? (await reader.snapshot());
  const config = await reader.getConfig(snapshot);
  assertPolicyDuration(config, args.duration);
  const fee = chargeFor(config, args.duration, args.labelLength);
  const maxFee = args.maxFee ?? fee;
  if (maxFee < fee)
    throw new AnsError("fee_changed", `fee ${fee} exceeds max fee ${maxFee}`);
  return {
    operation: args.operation,
    duration: args.duration,
    ...config,
    annualPrice: annualPriceFor(config, args.labelLength),
    ...(config.lengthPrices ? { labelLength: args.labelLength } : {}),
    fee,
    maxFee,
    quoteExpiry: snapshot.timestamp + (args.validForSeconds ?? MAX_COMMIT_AGE),
    ...(args.operation === "renew" && args.expiresAt !== undefined
      ? { renewableAt: config.launch && config.launch.maxRenewAhead > 0n
          ? (args.expiresAt > config.launch.maxRenewAhead ? args.expiresAt - config.launch.maxRenewAhead : 0n)
          : 0n }
      : {}),
    snapshot,
  };
}

export function sameFeeTerms(
  a: RegistryConfig,
  b: Pick<FeeQuote, "feeToken" | "treasury" | "priceVersion" | "registrar">,
) {
  return (
    a.feeToken.equals(b.feeToken) &&
    a.treasury.equals(b.treasury) &&
    a.priceVersion === b.priceVersion &&
    a.registrar?.toString() === b.registrar?.toString()
  );
}

/** A fresh nonce per payment, so two payments of the same amount never share an authwit nullifier. */
export const newFeeNonce = () => Fr.random().toBigInt();

/**
 * Authorizes exactly one `transfer_in_private(payer, treasury, fee, feeNonce)` on the fee token, callable only by
 * the registry. Returns undefined when nothing is charged.
 */
export async function buildFeeAuthorization(
  ctx: AnsContext,
  args: {
    feeToken: AztecAddress;
    treasury: AztecAddress;
    fee: bigint;
    feeNonce: bigint;
    registrar?: AztecAddress;
  },
): Promise<AuthWitness | undefined> {
  if (args.fee === 0n) return undefined;
  const selector = await FunctionSelector.fromSignature(
    TRANSFER_IN_PRIVATE_SIGNATURE,
  );
  const argsHash = await computeVarArgsHash([
    ctx.account.toField(),
    args.treasury.toField(),
    new Fr(args.fee),
    new Fr(args.feeNonce),
  ]);
  const caller = args.registrar ?? ctx.reader.registry;
  const innerHash = await computeInnerAuthWitHash([
    caller.toField(),
    selector.toField(),
    argsHash,
  ]);
  return ctx.queue.run(async () => {
    await ctx.registerFeeToken(args.feeToken);
    // A call intent lets the wallet show the transfer it authorizes instead of an opaque hash.
    const { TokenContract } = await import("@aztec-labs/noir-contracts.js/Token");
    const call = await TokenContract.at(args.feeToken, ctx.wallet)
      .methods.transfer_in_private(ctx.account, args.treasury, args.fee, args.feeNonce)
      .getFunctionCall();
    if (!(await computeInnerAuthWitHashFromAction(caller, call)).equals(innerHash))
      throw new AnsError("unsupported", "fee token call does not match the exact payment authorization");
    return ctx.wallet.createAuthWit(ctx.account, { caller, call });
  });
}

/** Bind a user-visible quote before creating any payment authorization. */
export function assertAcceptedQuote(current: FeeQuote, accepted?: FeeQuote) {
  if (accepted && (!sameFeeTerms(current, accepted) || current.operation !== accepted.operation || current.duration !== accepted.duration || current.labelLength !== accepted.labelLength || current.fee !== accepted.fee || current.maxFee !== accepted.maxFee))
    throw new AnsError("fee_changed", "fee policy changed; review a fresh quote");
}
