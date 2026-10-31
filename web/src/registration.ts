import { createRegistrationFlow, registrationPlanKey, type AnsContext } from '@ans/sdk';
import { getSession, rememberRegistrationProgress, recordWriter } from './session';

const flows = new WeakMap<AnsContext, ReturnType<typeof createRegistrationFlow>>();

/** One workflow per selected account. The app supplies only its encrypted record store. */
export function registrationFlow(ctx: AnsContext) {
  let flow = flows.get(ctx);
  if (flow) return flow;
  const write = recordWriter(ctx);
  flow = createRegistrationFlow(ctx, {
    load: async (key) => {
      const session = getSession();
      if (session.ctx !== ctx || !session.records)
        throw new Error('Wallet account changed. Try the action again.');
      return session.records.plans.find((plan) => registrationPlanKey(plan) === key);
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
  flows.set(ctx, flow);
  return flow;
}
