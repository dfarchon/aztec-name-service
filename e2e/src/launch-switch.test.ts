import assert from 'node:assert/strict';
import test from 'node:test';
import { executeLaunchSwitch, type SwitchPort, type SwitchState } from './launch-switch.js';
function fixture() {
  const states: Record<string, SwitchState> = {
    old: {
      policy: { minPublicLength: 7, paused: false, maxRenewAhead: 31536000n },
      entries: [
        { node: 1n, reserved: true },
        { node: 2n, reserved: false },
      ],
    },
    next: { policy: { minPublicLength: 3, paused: true, maxRenewAhead: 31536000n }, entries: [] },
  };
  let active = 'old',
    configured = false;
  const pauses: string[] = [];
  const port: SwitchPort = {
    active: async () => active,
    read: async (a) => structuredClone(states[a]),
    pause: async (a, p) => {
      pauses.push(`${a}:${p}`);
      states[a].policy.paused = p;
    },
    copy: async () => {
      states.next = structuredClone(states.old);
    },
    configure: async () => {
      configured = true;
      active = 'next';
    },
  };
  return {
    port,
    states,
    pauses,
    get configured() {
      return configured;
    },
    setActive: (a: string) => {
      active = a;
    },
  };
}
test('switch pauses old, reads back replacement and preserves public policy with recovery plan', async () => {
  const f = fixture(),
    result = await executeLaunchSwitch(f.port, 'old', 'next');
  assert(f.configured);
  assert.equal(f.states.old.policy.paused, true);
  assert.equal(f.states.next.policy.paused, false);
  assert.deepEqual(f.pauses, ['old:true', 'next:false']);
  assert.equal(result.resumePlan.paused, false);
});
test('optional pause flag and originally paused policies preserve intent', async () => {
  const f = fixture();
  await executeLaunchSwitch(f.port, 'old', 'next', false);
  assert(!f.pauses.includes('old:true'));
  const g = fixture();
  g.states.old.policy.paused = true;
  await executeLaunchSwitch(g.port, 'old', 'next');
  assert.equal(g.states.next.policy.paused, true);
});
for (const field of [
  'minPublicLength',
  'paused',
  'maxRenewAhead',
  'reserved-value',
  'new-reservation',
] as const) {
  test(`switch aborts old ${field} race immediately before configure`, async () => {
    const f = fixture(),
      copy = f.port.copy;
    f.port.copy = async () => {
      await copy();
      if (field === 'minPublicLength') f.states.old.policy.minPublicLength = 8;
      if (field === 'paused') f.states.old.policy.paused = false;
      if (field === 'maxRenewAhead') f.states.old.policy.maxRenewAhead = 0n;
      if (field === 'reserved-value') f.states.old.entries[0].reserved = false;
      if (field === 'new-reservation') f.states.old.entries.push({ node: 3n, reserved: true });
    };
    await assert.rejects(
      executeLaunchSwitch(f.port, 'old', 'next'),
      (e) =>
        e instanceof Error &&
        !!e.cause &&
        /Old registrar before configure/.test(String(e.cause)) &&
        /Recovery/.test(e.message),
    );
    assert(!f.configured);
  });
}
for (const field of ['minPublicLength', 'paused', 'maxRenewAhead', 'reservations'] as const) {
  test(`switch aborts replacement ${field} readback mismatch`, async () => {
    const f = fixture(),
      read = f.port.read;
    f.port.read = async (a) => {
      const s = await read(a);
      if (a === 'next') {
        if (field === 'minPublicLength') s.policy.minPublicLength = 3;
        if (field === 'paused') s.policy.paused = true;
        if (field === 'maxRenewAhead') s.policy.maxRenewAhead = 0n;
        if (field === 'reservations') s.entries = [];
      }
      return s;
    };
    await assert.rejects(
      executeLaunchSwitch(f.port, 'old', 'next'),
      (e) => e instanceof Error && /Replacement/.test(String(e.cause)),
    );
    assert(!f.configured);
    assert.equal(f.states.old.policy.paused, true);
  });
}
test('switch aborts active-module races, failed pause and failed copy without automatic resume', async () => {
  const f = fixture();
  f.setActive('other');
  await assert.rejects(executeLaunchSwitch(f.port, 'old', 'next'), /Active registrar/);
  assert(!f.configured);
  const g = fixture(),
    copy = g.port.copy;
  g.port.copy = async () => {
    await copy();
    g.setActive('other');
  };
  await assert.rejects(executeLaunchSwitch(g.port, 'old', 'next'));
  assert(!g.configured);
  const h = fixture();
  h.port.pause = async () => {};
  await assert.rejects(
    executeLaunchSwitch(h.port, 'old', 'next'),
    (e) => e instanceof Error && /before copy/.test(String(e.cause)),
  );
  assert(!h.configured);
  const i = fixture();
  i.port.copy = async () => {
    throw Error('RPC unavailable');
  };
  await assert.rejects(executeLaunchSwitch(i.port, 'old', 'next'), /Recovery/);
  assert(i.states.old.policy.paused);
  assert(!i.configured);
  await assert.rejects(executeLaunchSwitch(i.port, 'old', 'old'), /must differ/);
});
test('replacement recheck catches a change after its first readback', async () => {
  const f = fixture(),
    read = f.port.read;
  let reads = 0;
  f.port.read = async (a) => {
    const s = await read(a);
    if (a === 'next' && ++reads === 2) s.policy.minPublicLength = 9;
    return s;
  };
  await assert.rejects(
    executeLaunchSwitch(f.port, 'old', 'next'),
    (e) => e instanceof Error && /Replacement before configure/.test(String(e.cause)),
  );
  assert(!f.configured);
});
