/** Only locally assigned codes and fixed class labels may reach stderr. */
import { AssertionError } from 'node:assert';
import type { RegisterStep } from './testnet-v6-nofpc-state.js';

const REASONS = {
  CLAIM_NOT_READY: 'User bridge claim is not ready at proven tip',
  BALANCE_EMPTY: 'Fee Juice balance is empty',
  CONFIRM_MISMATCH: 'Exact --confirm from --dry-run is required',
  IDENTITY_MISMATCH: 'Network identity mismatch',
  RPC_ERROR: 'RPC request failed',
  UNKNOWN: 'Registration failed',
} as const;
export type RegistrationReason = keyof typeof REASONS;
export class RegistrationFailure extends Error {
  constructor(readonly reason: RegistrationReason, options?: ErrorOptions) {
    super(REASONS[reason], options);
  }
}
export function logRegistrationFailure(error: unknown, step?: RegisterStep) {
  const kind = error instanceof AssertionError ? 'AssertionError' :
    error instanceof SyntaxError ? 'SyntaxError' : error instanceof TypeError ? 'TypeError' :
    error instanceof RangeError ? 'RangeError' : 'Error';
  const reason = error instanceof RegistrationFailure && Object.hasOwn(REASONS, error.reason)
    ? error.reason : 'UNKNOWN';
  // Do not inspect message, name, code, cause, stack or arbitrary thrown values.
  console.error(`${step ? `STEP-REASON ${step}` : 'REASON'} ${kind} ${reason}`);
}
