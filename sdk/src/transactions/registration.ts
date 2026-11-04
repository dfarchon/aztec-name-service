import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';

import type { RegistryReader } from '../client/reader.js';
import { getName } from '../client/resolve.js';
import { MAX_COMMIT_AGE, MIN_COMMIT_AGE } from '../core/constants.js';
import { AnsError } from '../core/errors.js';
import { nodeOf, registerCommitment } from '../core/hash.js';
import { assertRegistrableLabel, labelFromCanonical, type NormalizeOptions } from '../core/label.js';
import { assertDuration, assertPolicyDuration, chargeFor, isRegistrable, nameStatus } from '../core/lifecycle.js';
import { parseWithBigInt, stringifyWithBigInt } from '../core/seal.js';
import type { Snapshot } from '../core/types.js';
import type { AnsContext } from '../wallet/context.js';
import {
  assertAcceptedQuote,
  type FeeQuote,
  buildFeeAuthorization,
  getFeeQuote,
  newFeeNonce,
  sameFeeTerms,
} from './fees.js';
import { codeFor } from './registration-codes.js';
import { runTxOutcome, unwrapTxOutcome, type RunTxOptions, type TxOptions, type TxResult } from './tx.js';

/**
 * Everything needed to finish a registration later. Contains the commit secret: persist it only in wallet storage or
 * sealed (see `seal`), never in URLs or logs.
 */
export type RegistrationPlan = {
  v: 2 | 3;
  /** V3 policy address; part of the commitment and exact fee authorization. */
  registrar?: string;
  chainId: bigint;
  registry: string;
  account: string;
  label: string;
  node: bigint;
  expectedGeneration: number;
  duration: bigint;
  feeToken: string;
  treasury: string;
  priceVersion: number;
  fee: bigint;
  maxFee: bigint;
  quoteExpiry: bigint;
  feeNonce: bigint;
  secret: bigint;
  commitment: bigint;
  createdAt: number;
  commitTx?: string;
  registerTx?: string;
  /** Durable marker set immediately before wallet send; a broadcast may have occurred without a saved hash. */
  broadcastUnknown?: 'commitTx' | 'registerTx';
};

export const serializePlan = (p: RegistrationPlan) => stringifyWithBigInt(p);
export const deserializePlan = (s: string) => parseWithBigInt<RegistrationPlan>(s);

/** Re-read live launch policy without persisting it in a registration plan. */
async function assertPublicRegistration(reader: RegistryReader, name: string, duration: bigint, snapshot?: Snapshot) {
  const config = await reader.getConfig(snapshot);
  assertPolicyDuration(config, duration);
  if (!config.launch) return;
  const eligibility = await reader.eligibility(name, snapshot);
  if (eligibility === 'paused') throw new AnsError('registration_paused', 'registration paused');
  if (eligibility === 'too_short') throw new AnsError('name_not_available_yet', 'name not yet available');
  if (eligibility === 'reserved') throw new AnsError('name_reserved', 'name reserved');
}

export async function prepareRegistration(
  ctx: AnsContext,
  args: {
    name: string;
    duration: bigint;
    maxFee?: bigint;
    acceptedQuote?: FeeQuote;
    quoteValiditySeconds?: bigint;
    normalize?: NormalizeOptions;
  },
): Promise<RegistrationPlan> {
  const info = await getName(ctx.reader, args.name, args.normalize);
  if (info.label.parent)
    throw new AnsError('invalid_name', 'subnames must be issued by their parent owner');
  assertRegistrableLabel(info.label);
  if (!isRegistrable(info.status)) throw new AnsError('name_taken', `name is ${info.status}`);
  if (ctx.reader.modular && info.record.generation === 0) {
    const old = await ctx.reader.getLegacyName(info.node, info.snapshot);
    if (old && ['active', 'grace'].includes(nameStatus(old, info.snapshot.timestamp)))
      throw new AnsError(
        'migration_required',
        'legacy name is reserved for its holder; migrate it first',
      );
  }
  const quote = await getFeeQuote(ctx.reader, {
    operation: 'register',
    duration: args.duration,
    labelLength: info.label.len,
    maxFee: args.maxFee,
    validForSeconds: args.quoteValiditySeconds ?? MAX_COMMIT_AGE,
    snapshot: info.snapshot,
  });
  assertAcceptedQuote(quote, args.acceptedQuote);
  await assertPublicRegistration(ctx.reader, info.label.label, args.duration, info.snapshot);
  const expectedGeneration = info.nextExpectedGeneration;
  const secret = Fr.random().toBigInt();
  const commitment = await registerCommitment({
    chainId: ctx.reader.deployment.chainId,
    registry: ctx.reader.registry,
    registrar: quote.registrar,
    node: info.node,
    expectedGeneration,
    owner: ctx.account,
    duration: args.duration,
    feeToken: quote.feeToken,
    treasury: quote.treasury,
    priceVersion: quote.priceVersion,
    maxFee: quote.maxFee,
    quoteExpiry: quote.quoteExpiry,
    secret,
  });
  return {
    v: ctx.reader.modular ? 3 : 2,
    ...(quote.registrar ? { registrar: quote.registrar.toString() } : {}),
    chainId: ctx.reader.deployment.chainId,
    registry: ctx.reader.registry.toString(),
    account: ctx.account.toString(),
    label: info.label.label,
    node: info.node,
    expectedGeneration,
    duration: args.duration,
    feeToken: quote.feeToken.toString(),
    treasury: quote.treasury.toString(),
    priceVersion: quote.priceVersion,
    fee: quote.fee,
    maxFee: quote.maxFee,
    quoteExpiry: quote.quoteExpiry,
    feeNonce: newFeeNonce(),
    secret,
    commitment,
    createdAt: Date.now(),
  };
}

function assertPlanDeployment(reader: RegistryReader, plan: RegistrationPlan) {
  if (!plan || ![2, 3].includes(plan.v)) throw new AnsError('corrupt_data', 'unknown plan version');
  if ((plan.v === 3) !== !!reader.modular)
    throw new AnsError('wrong_deployment', 'plan protocol differs from registry');
  if (
    (plan.v === 3 && typeof plan.registrar !== 'string') ||
    (plan.v === 2 && plan.registrar !== undefined)
  )
    throw new AnsError('corrupt_data', 'invalid registrar binding');
  if (plan.registry !== reader.registry.toString() || plan.chainId !== reader.deployment.chainId) {
    throw new AnsError('wrong_deployment', 'plan belongs to another deployment');
  }
}

function assertPlanFor(ctx: AnsContext, plan: RegistrationPlan) {
  assertPlanDeployment(ctx.reader, plan);
  if (plan.account !== ctx.account.toString())
    throw new AnsError('invalid_argument', 'plan belongs to another account');
}

/** Validate persisted data before a commit, status lookup or fee authorization. */
async function validatePlan(reader: RegistryReader, plan: RegistrationPlan) {
  assertPlanDeployment(reader, plan);
  try {
    for (const field of ['node', 'duration', 'feeNonce', 'secret', 'commitment'] as const)
      if (typeof plan[field] !== 'bigint') throw new Error(`invalid ${field}`);
    assertDuration(plan.duration);
    if (
      !Number.isSafeInteger(plan.expectedGeneration) ||
      plan.expectedGeneration < 0 ||
      plan.expectedGeneration >= 0xffffffff ||
      !Number.isSafeInteger(plan.priceVersion) ||
      plan.priceVersion < 0 ||
      plan.priceVersion > 0xffffffff ||
      typeof plan.fee !== 'bigint' ||
      plan.fee < 0n ||
      typeof plan.maxFee !== 'bigint' ||
      plan.maxFee < plan.fee ||
      plan.maxFee >= 1n << 128n ||
      typeof plan.quoteExpiry !== 'bigint' ||
      plan.quoteExpiry < 0n ||
      plan.quoteExpiry >= 1n << 64n
    )
      throw new Error('invalid plan fields');
    new Fr(plan.feeNonce);
    const label = labelFromCanonical(plan.label);
    if ((await nodeOf(label)) !== plan.node) throw new Error('label does not match node');
    const commitment = await registerCommitment({
      ...plan,
      registry: reader.registry,
      registrar: plan.registrar ? AztecAddress.fromStringUnsafe(plan.registrar) : undefined,
      owner: AztecAddress.fromStringUnsafe(plan.account),
      feeToken: AztecAddress.fromStringUnsafe(plan.feeToken),
      treasury: AztecAddress.fromStringUnsafe(plan.treasury),
    });
    if (commitment !== plan.commitment) throw new Error('commitment does not match plan');
  } catch (e) {
    throw new AnsError('corrupt_data', 'invalid registration plan', e);
  }
}

/** Sends `commit`. Persist the returned plan (it carries the tx hash) before and after calling. */
export async function submitCommit(ctx: AnsContext, plan: RegistrationPlan, opts?: TxOptions) {
  const result = await submitCommitOutcome(ctx, plan, opts);
  return { plan: result.plan, tx: unwrapTxOutcome(result.tx) };
}

/** Internal flow variant; only the receipt interpreter returns a terminal failure. */
export async function submitCommitOutcome(ctx: AnsContext, plan: RegistrationPlan, opts?: RunTxOptions) {
  assertPlanFor(ctx, plan);
  await validatePlan(ctx.reader, plan);
  const snapshot = await ctx.reader.snapshot();
  if (snapshot.timestamp + 60n > plan.quoteExpiry)
    throw new AnsError('quote_expired', 'registration quote has expired');
  const tx = await runTxOutcome(
    ctx,
    async () => {
      await assertPublicRegistration(ctx.reader, plan.label, plan.duration);
      return (await ctx.registrationContract(plan.registrar)).methods.commit(plan.commitment);
    },
    {
      ...opts,
      onUpdate: (u) => {
        if (u.txHash) plan = { ...plan, commitTx: u.txHash };
        opts?.onUpdate?.(u);
      },
    },
  );
  return { plan: { ...plan, commitTx: tx.txHash }, tx };
}

export type RegistrationCheck =
  | {
      state:
        | 'commit_missing'
        | 'commit_expired'
        | 'quote_expired'
        | 'policy_changed'
        | 'generation_changed'
        | 'name_taken';
      snapshot: Snapshot;
    }
  | { state: 'commit_wait'; readyInSeconds: bigint; snapshot: Snapshot }
  | { state: 'ready_to_register'; snapshot: Snapshot }
  | { state: 'registered'; snapshot: Snapshot };

/**
 * Where a plan stands, judged by chain time (not a page timer). `marginSeconds` keeps a register from being sent
 * too close to an expiry it could cross before inclusion.
 */
export async function checkRegistration(
  reader: RegistryReader,
  plan: RegistrationPlan,
  marginSeconds = 60n,
): Promise<RegistrationCheck> {
  await validatePlan(reader, plan);
  const snapshot = await reader.snapshot('checkpointed');
  const [commit, rec] = await Promise.all([
    reader.getCommit(plan.commitment, snapshot),
    reader.getName(plan.node, snapshot),
  ]);
  // Only `register` consumes a commitment, and the commitment binds this plan's holder.
  if (commit.consumed) return { state: 'registered', snapshot };
  if (plan.v === 3 && (await reader.getModules(snapshot)).registrar.toString() !== plan.registrar)
    return { state: 'policy_changed', snapshot };
  const now = snapshot.timestamp;
  if (rec.generation !== plan.expectedGeneration) return { state: 'generation_changed', snapshot };
  if (!isRegistrable(nameStatus(rec, now))) return { state: 'name_taken', snapshot };
  if (now + marginSeconds > plan.quoteExpiry) return { state: 'quote_expired', snapshot };
  if (commit.committedAt === 0n) return { state: 'commit_missing', snapshot };
  const age = now - commit.committedAt;
  if (age + marginSeconds >= MAX_COMMIT_AGE) return { state: 'commit_expired', snapshot };
  if (age < MIN_COMMIT_AGE)
    return {
      state: 'commit_wait',
      readyInSeconds: MIN_COMMIT_AGE - age,
      snapshot,
    };
  return { state: 'ready_to_register', snapshot };
}

/** Polls chain time until the commitment is old enough, or throws the state that makes waiting pointless. */
export async function waitUntilRegistrable(
  reader: RegistryReader,
  plan: RegistrationPlan,
  opts: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new AnsError('invalid_argument', 'aborted');
    const check = await checkRegistration(reader, plan);
    if (check.state === 'ready_to_register' || check.state === 'registered') return check;
    if (check.state !== 'commit_wait' && check.state !== 'commit_missing')
      throw new AnsError(codeFor(check.state), check.state);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
  }
  throw new AnsError('commit_not_ready', 'timed out waiting for the commitment to mature');
}

/**
 * Reveals the plan and pays the exact fee with a fresh authwit. The contract re-checks everything; a failed public
 * check reverts the fee together with the registration.
 */
export async function submitRegistration(
  ctx: AnsContext,
  plan: RegistrationPlan,
  opts?: TxOptions,
): Promise<{ plan: RegistrationPlan; tx: TxResult }> {
  const result = await submitRegistrationOutcome(ctx, plan, opts);
  return { plan: result.plan, tx: unwrapTxOutcome(result.tx) };
}

/** Internal flow variant; exceptions from wallets or observers remain exceptions. */
export async function submitRegistrationOutcome(ctx: AnsContext, plan: RegistrationPlan, opts?: RunTxOptions) {
  assertPlanFor(ctx, plan);
  if (plan.registerTx)
    throw new AnsError(
      'unknown_tx_state',
      'check the existing registration transaction before retrying',
      undefined,
      plan.registerTx,
    );
  const check = await checkRegistration(ctx.reader, plan);
  if (check.state !== 'ready_to_register') throw new AnsError(codeFor(check.state), check.state);

  const config = await ctx.reader.getConfig();
  const terms = {
    feeToken: AztecAddress.fromStringUnsafe(plan.feeToken),
    treasury: AztecAddress.fromStringUnsafe(plan.treasury),
    priceVersion: plan.priceVersion,
    registrar: plan.registrar ? AztecAddress.fromStringUnsafe(plan.registrar) : undefined,
  };
  if (!sameFeeTerms(config, terms))
    throw new AnsError('fee_changed', 'registry fee terms differ from the plan');
  const label = labelFromCanonical(plan.label);
  if (plan.fee !== chargeFor(config, plan.duration, label.len))
    throw new AnsError('corrupt_data', 'plan fee does not match registry fee');

  await assertPublicRegistration(ctx.reader, plan.label, plan.duration, check.snapshot);
  const authWitness = await buildFeeAuthorization(ctx, {
    ...terms,
    fee: plan.fee,
    feeNonce: plan.feeNonce,
  });
  const call = async () => {
    await assertPublicRegistration(ctx.reader, plan.label, plan.duration);
    return (await ctx.registrationContract(plan.registrar)).methods.register(
      label.bytes,
      label.len,
      plan.expectedGeneration,
      plan.duration,
      plan.maxFee,
      plan.quoteExpiry,
      plan.feeNonce,
      plan.secret,
    );
  };
  const tx = await runTxOutcome(ctx, call, {
    ...opts,
    preflight: opts?.preflight ?? !!config.launch,
    authWitnesses: authWitness ? [authWitness] : undefined,
  });
  return { plan: { ...plan, registerTx: tx.txHash }, tx };
}
