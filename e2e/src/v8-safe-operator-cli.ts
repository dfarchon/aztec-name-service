/** This entry point deliberately has no wallet, signer, RPC or checkpoint-file inputs. */
import { safeArguments, PUBLIC_PAUSE } from './v8-safe-operator.js';
import reservations from '../../deployments/reserved-labels.json' with { type: 'json' };
import { prepareV8Rehearsal } from './v8-rehearsal-plan.js';
try {
  const mode = safeArguments(process.argv.slice(2));
  const plan = prepareV8Rehearsal(
    reservations,
    '/private/testnet-v8-upgrade-rehearsal-preview',
    '/private',
  );
  console.log(
    JSON.stringify(
      {
        ...mode,
        pause: PUBLIC_PAUSE,
        plan,
        liveReady: false,
        fullPublicCost: null,
        canonicalL1Provenance: 'UNVERIFIED_TOKEN_PARTIAL_MATCH',
      },
      null,
      2,
    ),
  );
} catch {
  console.error(PUBLIC_PAUSE);
  process.exitCode = 1;
}
