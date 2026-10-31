import type { RegistrationCheck } from './registration.js';

/** Error code for a registration check state that blocks the next step. Internal; not re-exported. */
export function codeFor(state: RegistrationCheck['state']) {
  switch (state) {
    case 'registered':
      // Matches the contract's "commitment already consumed".
      return 'commit_missing' as const;
    case 'policy_changed':
      return 'fee_changed' as const;
    case 'commit_expired':
      return 'commit_expired' as const;
    case 'quote_expired':
      return 'quote_expired' as const;
    case 'generation_changed':
    case 'name_taken':
      return 'name_taken' as const;
    case 'commit_missing':
      return 'commit_missing' as const;
    default:
      return 'commit_not_ready' as const;
  }
}
