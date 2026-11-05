/** Signer-independent switch sequence. A failed switch deliberately leaves the old registrar paused. */
import assert from 'node:assert/strict';
export type SwitchPolicy = { minPublicLength: number; paused: boolean; maxRenewAhead: bigint };
export type SwitchState = { policy: SwitchPolicy; entries: { node: bigint; reserved: boolean }[] };
export type SwitchPort = {
  active(): Promise<string>;
  read(address: string): Promise<SwitchState>;
  pause(address: string, paused: boolean): Promise<void>;
  copy(): Promise<unknown>;
  configure(): Promise<void>;
};
export function assertSwitchState(actual: SwitchState, expected: SwitchState, label: string) {
  assert.deepEqual(actual.policy, expected.policy, `${label} policy changed`);
  const sorted = (s: SwitchState) =>
    [...s.entries].sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  assert.deepEqual(sorted(actual), sorted(expected), `${label} reservation parity changed`);
}
export async function executeLaunchSwitch(
  port: SwitchPort,
  from: string,
  to: string,
  pauseOld = true,
) {
  assert.notEqual(from, to, 'Replacement must differ');
  assert.equal(await port.active(), from, 'Active registrar changed before copy');
  const initial = await port.read(from);
  const resumePlan = {
    registrar: from,
    paused: initial.policy.paused,
    instruction:
      'On abort, inspect both policies, reservations and the active module. Resume the old registrar only if it remains active and its policy is approved. On success leave it paused; restore its original pause state only as part of a deliberate rollback.',
  };
  try {
    if (pauseOld && !initial.policy.paused) await port.pause(from, true);
    const expected = {
      ...initial,
      policy: { ...initial.policy, paused: pauseOld || initial.policy.paused },
    };
    assertSwitchState(await port.read(from), expected, 'Old registrar before copy');
    const copy = await port.copy();
    // Copy initially keeps the replacement paused. Restore the intended public policy and read it back.
    await port.pause(to, initial.policy.paused);
    const copied = await port.read(to);
    assertSwitchState(copied, initial, 'Replacement');
    // Re-enumerate complete reservation history here: newly added nodes must also abort the switch.
    assertSwitchState(await port.read(from), expected, 'Old registrar before configure');
    assertSwitchState(await port.read(to), initial, 'Replacement before configure');
    assert.equal(await port.active(), from, 'Active registrar changed during copy');
    await port.configure();
    return { copy, resumePlan };
  } catch (cause) {
    throw new Error(`Registrar switch aborted. Recovery: ${JSON.stringify(resumePlan)}`, { cause });
  }
}
