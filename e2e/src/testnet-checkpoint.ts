import assert from 'node:assert/strict';

type Checkpoint = { transactions: Record<string, string>; done: string[] };

/** Recheck every saved hash on resume. Completed behavioral assertions may no longer hold after later steps. */
export async function runCheckpointedStep<T>(
  state: Checkpoint, name: string, send: () => Promise<unknown>,
  track: (hash: string) => Promise<T>, verify: () => Promise<void>, save: () => Promise<void>,
): Promise<T> {
  const completed = state.done.includes(name);
  assert(!completed || state.transactions[name], `Completed step ${name} has no transaction checkpoint`);
  if (!state.transactions[name]) await send();
  assert(state.transactions[name], `No broadcast captured for ${name}`);
  const receipt = await track(state.transactions[name]);
  if (!completed) {
    await verify();
    state.done.push(name);
    await save();
  }
  return receipt;
}

/** Preserve cumulative acceptance history without presenting it as freshly executed assertions. */
export function acceptanceChecks(historical: string[]) {
  const current = new Set<string>();
  return {
    check(name: string, value: unknown) {
      assert(value, name);
      current.add(name);
      if (!historical.includes(name)) historical.push(name);
    },
    report: () => ({ checks: [...current], historicalChecks: [...historical] }),
  };
}
