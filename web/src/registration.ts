import { createRegistrationFlow, registrationPlanKey, type AnsContext } from '@ans/sdk';
import { rememberRegistrationProgress, recordReader, recordWriter, withPendingTx } from './session';

const flows = new WeakMap<AnsContext, ReturnType<typeof createRegistrationFlow>>();

/** One workflow per selected account. The app supplies only its encrypted record store. */
export function registrationFlow(ctx: AnsContext) {
  let flow = flows.get(ctx);
  if (flow) return flow;
  const write = recordWriter(ctx);
  const read = recordReader(ctx);
  const base = createRegistrationFlow(ctx, {
    load: async (key) => {
      return (await read()).plans.find((plan) => registrationPlanKey(plan) === key);
    },
    save: async (key, plan) => {
      rememberRegistrationProgress(ctx, plan);
      await write((records) => ({
        ...records,
        plans: records.plans.some((p) => registrationPlanKey(p) === key)
          ? records.plans.map((p) => (registrationPlanKey(p) === key ? plan : p))
          : [...records.plans, plan],
      }));
    },
  });
  flow = {
    ...base,
    commit: (...args) => withPendingTx(() => base.commit(...args)),
    finish: (...args) => withPendingTx(() => base.finish(...args)),
    recover: (...args) => withPendingTx(() => base.recover(...args)),
  };
  flows.set(ctx, flow);
  return flow;
}
