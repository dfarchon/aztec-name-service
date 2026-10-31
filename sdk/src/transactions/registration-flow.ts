import { AnsError } from '../core/errors.js';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { AnsContext } from '../wallet/context.js';
import { ExecutionQueue } from '../wallet/queue.js';
import { getFeeReadiness, getPrivateFeeBalance } from '../wallet/fee-balance.js';
import { getFeeQuote, type FeeQuote } from './fees.js';
import {
  checkRegistration,
  prepareRegistration,
  submitCommitOutcome,
  submitRegistrationOutcome,
  type RegistrationPlan,
} from './registration.js';
import { codeFor } from './registration-codes.js';
import { trackTxOutcome, unwrapTxOutcome, type TxOptions, type TxOutcome } from './tx.js';
import { normalizeName } from '../core/label.js';

/** The host owns encryption and durable storage. load must return undefined only when the key is absent. */
export type RegistrationPlanStore = {
  load: (key: string) => Promise<RegistrationPlan | undefined>;
  save: (key: string, plan: RegistrationPlan) => Promise<void>;
};
export const registrationPlanKey = (plan: RegistrationPlan) =>
  `${plan.chainId}:${plan.registry}:${plan.account}:${plan.commitment}`;
export type RegistrationTxKind = 'commitTx' | 'registerTx';

/** Resumable writes. Explicitly accepted quotes and durable secrets are required before the first broadcast. */
export function createRegistrationFlow(ctx: AnsContext, store: RegistrationPlanStore) {
  const actions = new ExecutionQueue();
  // Only unsaved progress overrides storage. Once durable, another instance may advance the plan.
  const known = new Map<string, RegistrationPlan>();

  async function current(input: RegistrationPlan): Promise<RegistrationPlan> {
    if (
      input.account !== ctx.account.toString() ||
      input.registry !== ctx.reader.registry.toString() ||
      input.chainId !== ctx.reader.deployment.chainId
    )
      throw new AnsError('wrong_deployment', 'plan belongs to another account or deployment');
    const key = registrationPlanKey(input);
    const stored = await store.load(key);
    if (stored && registrationPlanKey(stored) !== key)
      throw new AnsError('corrupt_data', 'stored registration key does not match its plan');
    const latest = known.get(key) ?? stored ?? input;
    // Preserve hashes even if persistence failed or a caller retained an older copy of the plan.
    return {
      ...(stored ?? input),
      commitTx: latest.commitTx,
      registerTx: latest.registerTx,
      broadcastUnknown: latest.broadcastUnknown,
    };
  }

  async function persist(plan: RegistrationPlan) {
    const key = registrationPlanKey(plan);
    await store.save(key, { ...plan });
    if (known.get(key) === plan) known.delete(key);
  }

  async function save(plan: RegistrationPlan) {
    const updated = { ...plan };
    known.set(registrationPlanKey(updated), updated);
    await persist(updated);
  }

  async function clearTerminalHash(plan: RegistrationPlan, kind: RegistrationTxKind, hash: string) {
    // A delayed h1 receipt must not replace h2 or erase newer progress in the other step.
    // Stores shared by concurrent writers still require the host's storage lease.
    const latest = await current(plan);
    if (latest[kind] !== hash) return latest;
    const cleared = { ...latest, [kind]: undefined };
    await save(cleared);
    return cleared;
  }

  async function recover(plan: RegistrationPlan, kind: RegistrationTxKind, options: TxOptions) {
    const hash = plan[kind];
    if (!hash)
      throw new AnsError(
        'unknown_tx_state',
        'no transaction hash; inspect wallet activity before retrying',
      );
    // Repair a previously failed hash write before recovery can be lost on another reload.
    try {
      await save(plan);
    } catch (error) {
      throw new AnsError(
        'unknown_tx_state',
        'cannot persist the known hash; track it before retrying',
        error,
        hash,
      );
    }
    const outcome = await trackTxOutcome(ctx.reader.node, hash, options);
    if (outcome.status === 'terminal_failure') await clearTerminalHash(plan, kind, outcome.txHash);
    unwrapTxOutcome(outcome);
    return current(plan);
  }

  async function send(input: RegistrationPlan, kind: RegistrationTxKind, options: TxOptions) {
    let plan = await current(input);
    if (plan[kind]) return recover(plan, kind, options);
    if (plan.broadcastUnknown === kind)
      throw new AnsError(
        'unknown_tx_state',
        'wallet returned no transaction hash; inspect its activity before clearing the recovery flag',
      );
    // A restored or externally constructed plan must also be durable before any wallet call.
    const check = await checkRegistration(ctx.reader, plan);
    // A commit is only useful while none exists and the name, policy and quote still match the plan.
    if (kind === 'commitTx' && check.state !== 'commit_missing')
      throw new AnsError(
        check.state === 'commit_wait' || check.state === 'ready_to_register' ? 'conflict' : codeFor(check.state),
        `cannot commit: ${check.state}`,
      );
    await save(plan);
    if (
      plan.fee > 0n &&
      (await getPrivateFeeBalance(ctx, AztecAddress.fromStringUnsafe(plan.feeToken))) < plan.fee
    )
      throw new AnsError(
        'invalid_argument',
        `insufficient private fee balance in ${plan.feeToken}`,
      );
    let persistence = Promise.resolve();
    let failure: { error: unknown } | undefined;
    let terminal: Extract<TxOutcome, { status: 'terminal_failure' }> | undefined;
    try {
      const submit = kind === 'commitTx' ? submitCommitOutcome : submitRegistrationOutcome;
      const result = await submit(ctx, plan, {
        ...options,
        onUpdate(update) {
          if (
            (update.txHash && update.txHash !== plan[kind]) ||
            (update.state === 'unknown' && !update.txHash)
          ) {
            plan = update.txHash
              ? { ...plan, [kind]: update.txHash, broadcastUnknown: undefined }
              : { ...plan, broadcastUnknown: kind };
            const updated = plan;
            known.set(registrationPlanKey(updated), updated);
            persistence = persistence.then(() => persist(updated));
            void persistence.catch(() => {});
          }
          options.onUpdate?.(update);
        },
      });
      plan = result.plan;
      if (result.tx.status === 'terminal_failure') terminal = result.tx;
    } catch (error) {
      // Callback and wallet exceptions are not receipt outcomes, regardless of their code/hash.
      failure = { error };
    }
    try {
      await persistence;
      plan = terminal ? await clearTerminalHash(plan, kind, terminal.txHash) : await current(plan);
    } catch (error) {
      if (plan[kind])
        throw new AnsError(
          'unknown_tx_state',
          'transaction submitted; saving progress failed; track this hash before retrying',
          error,
          plan[kind],
        );
      throw error;
    }
    if (terminal) unwrapTxOutcome(terminal);
    if (failure) throw failure.error;
    return plan;
  }

  return {
    /** `name` selects the length tier; tiered registrars require it. */
    quote: (duration: bigint, name?: string) =>
      getFeeQuote(ctx.reader, {
        operation: 'register',
        duration,
        labelLength: name === undefined ? undefined : normalizeName(name).len,
      }),
    readiness: (quote: FeeQuote) => getFeeReadiness(ctx, quote),
    prepare: (args: { name: string; acceptedQuote: FeeQuote }) =>
      actions.run(async () => {
        if (args.acceptedQuote.operation !== 'register')
          throw new AnsError('invalid_argument', 'accept a registration quote');
        const plan = await prepareRegistration(ctx, {
          name: args.name,
          duration: args.acceptedQuote.duration,
          maxFee: args.acceptedQuote.maxFee,
          acceptedQuote: args.acceptedQuote,
        });
        await save(plan);
        return plan;
      }),
    commit: (plan: RegistrationPlan, options: TxOptions = {}) =>
      actions.run(() => send(plan, 'commitTx', options)),
    check: async (plan: RegistrationPlan) => checkRegistration(ctx.reader, await current(plan)),
    finish: (plan: RegistrationPlan, options: TxOptions = {}) =>
      actions.run(() => send(plan, 'registerTx', options)),
    /** Receipt recovery only. Clear a hash only after the node proves a terminal failure; never broadcast here. */
    recover: (plan: RegistrationPlan, kind: RegistrationTxKind, options: TxOptions = {}) =>
      actions.run(async () => recover(await current(plan), kind, options)),
  };
}
