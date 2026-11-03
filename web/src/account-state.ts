import type { SessionState } from './session';

/** Several wallet accounts are authorized and the user has not picked one yet. */
export const choosingAccount = (
  s: Pick<SessionState, 'wallet' | 'ctx' | 'selectingAccount' | 'accounts'>,
) => !!s.wallet && !s.ctx && !s.selectingAccount && s.accounts.length > 1;
