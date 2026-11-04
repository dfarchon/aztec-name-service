import type { RegistrationCheck, RegistrationPlan } from '@ans/sdk';

/** Hash parsing stays wallet-free so recovery controls do not load aztec.js. */
export function parseTxHash(input: string): string | undefined {
  const hash = input.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : undefined;
}

/** V6 accepts now <= quote_expiry. Only a later checkpoint proves a pending reveal must fail. */
export function canDiscardUncertain(plan: RegistrationPlan, check?: RegistrationCheck): boolean {
  return !!check && check.snapshot.finality === 'checkpointed' && check.state !== 'registered' &&
    !plan.registerTx && check.snapshot.timestamp > plan.quoteExpiry;
}
