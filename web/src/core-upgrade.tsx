import { useEffect, useState } from 'react';
import type { CoreUpgradeState } from '@ans/sdk/read';
import type { CoreUpgradeAction } from '@ans/sdk';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { useSession, liveWritesAllowed } from './session';
import { CopyValue, TxLine, useTx } from './components';
import { date } from './format';
import { translate } from './i18n';

/** Reads remain available without a wallet. Every write refreshes status inside the SDK wallet queue. */
export function CoreUpgradeControls() {
  const session = useSession(), { reader, ctx } = session;
  const [state, setState] = useState<CoreUpgradeState>();
  const [administrator, setAdministrator] = useState<string>();
  const [error, setError] = useState<string>();
  const [target, setTarget] = useState(''), [nominee, setNominee] = useState('');
  const [sequence, setSequence] = useState('2'), [revision, refresh] = useState(0);
  const tx = useTx();
  useEffect(() => {
    let live = true; setState(undefined); setAdministrator(undefined); setError(undefined);
    if (reader?.deployment.protocolVersion === 8) void (async () => {
      const snapshot = await reader.snapshot();
      const [upgrade, admin] = await Promise.all([reader.getCoreUpgradeState(snapshot), reader.getAdministrator(snapshot)]);
      if (live) { setState(upgrade); setAdministrator(admin?.toString()); }
    })().catch(() => { if (live) setError(translate('Core upgrade status unavailable. Refresh before signing.')); });
    return () => { live = false; };
  }, [reader, revision]);
  if (reader?.deployment.protocolVersion !== 8) return null;
  const ready = !!ctx && !!state && liveWritesAllowed(session.status) && !tx.busy && !error;
  const isAdmin = ctx?.account.toString() === administrator;
  const perform = (build: (fresh: CoreUpgradeState) => CoreUpgradeAction) => void tx.exec('Core upgrade', async onUpdate => {
    if (!ctx || !liveWritesAllowed(session.status)) throw new Error('Network not ready. Reconnect and retry.');
    const fresh = await ctx.reader.getCoreUpgradeState();
    const { administerCoreUpgrade } = await import('@ans/sdk');
    await administerCoreUpgrade(ctx, build(fresh), { onUpdate }); refresh(value => value + 1);
  });
  const fieldTarget = () => { if (!/^0x[0-9a-fA-F]{1,64}$/.test(target)) throw new Error('Enter an exact hexadecimal class ID'); return BigInt(target); };
  return <details className="card" id="core-upgrade-controls"><summary>{translate('Core upgrade')}</summary>
    <p>{translate('Trusted single administrator. Core changes wait 24 hours plus 24 protocol hours. Module changes remain immediate. Rollback preserves writes.')}</p>
    {state && <dl>
      <dt>{translate('Current class')}</dt><dd><CopyValue value={state.currentClass} /></dd>
      <dt>{translate('Snapshot block')}</dt><dd>{state.snapshot.blockNumber}</dd>
      <dt>{translate('Upgrade nonce')}</dt><dd>{String(state.nonce)}</dd>
      {state.pending.active && <><dt>{translate('Proposal ready')}</dt><dd>{date(state.pending.readyAt)}</dd></>}
      {state.scheduled.active && <><dt>{translate('Protocol activation')}</dt><dd>{date(state.scheduled.activationAt)}</dd></>}
    </dl>}
    {error && <p role="alert" className="err">{error}</p>}
    <button className="ghost" disabled={tx.busy} onClick={() => refresh(value => value + 1)}>{translate('Refresh contract status')}</button>
    {ctx && isAdmin && <fieldset disabled={!ready}>
      <label>{translate('Exact reviewed target class')}<input id="upgrade-target" value={target} onChange={event => setTarget(event.target.value)} /></label>
      <label>{translate('Release sequence')}<input id="upgrade-sequence" type="number" min="1" value={sequence} onChange={event => setSequence(event.target.value)} /></label>
      <button onClick={() => perform(fresh => ({ kind: 'approve_release', expectedNonce: fresh.nonce, classId: fieldTarget(), family: 0x414e535f434f5245n, releaseSeq: Number(sequence) }))}>{translate('Approve reviewed release')}</button>
      <button onClick={() => perform(fresh => ({ kind: 'approve_edge_pair', expectedNonce: fresh.nonce, older: BigInt(fresh.originalClass), newer: fieldTarget() }))}>{translate('Approve directed edge pair')}</button>
      <button onClick={() => perform(fresh => ({ kind: 'revoke_release', expectedNonce: fresh.nonce, classId: fieldTarget() }))}>{translate('Revoke release')}</button>
      <button onClick={() => perform(fresh => ({ kind: 'revoke_edge', expectedNonce: fresh.nonce, from: BigInt(fresh.currentClass), to: fieldTarget() }))}>{translate('Revoke directed edge')}</button>
      <button onClick={() => perform(fresh => ({ kind: 'propose', expectedNonce: fresh.nonce, from: BigInt(fresh.currentClass), to: fieldTarget() }))}>{translate('Propose upgrade or rollback')}</button>
      <button disabled={!ready || !state?.pending.active || state.snapshot.timestamp < state.pending.readyAt} onClick={() => perform(fresh => ({ kind: 'execute', expectedNonce: fresh.nonce, from: fresh.pending.from, to: fresh.pending.to }))}>{translate('Execute stored proposal')}</button>
      <button disabled={!ready || !state?.pending.active} onClick={() => perform(fresh => ({ kind: 'cancel_proposal', expectedNonce: fresh.nonce }))}>{translate('Cancel proposal')}</button>
      <button disabled={!ready || !state?.scheduled.active || state.scheduled.activationAt - state.snapshot.timestamp <= 900n} onClick={() => perform(fresh => ({ kind: 'cancel_scheduled', expectedNonce: fresh.nonce }))}>{translate('Cancel before activation')}</button>
      <label>{translate('Next administrator')}<input id="upgrade-administrator" value={nominee} onChange={event => setNominee(event.target.value)} /></label>
      <button onClick={() => perform(fresh => ({ kind: 'nominate_administrator', expectedNonce: fresh.nonce, administrator: AztecAddress.fromStringUnsafe(nominee) }))}>{translate('Nominate administrator')}</button>
    </fieldset>}
    {ctx && <button disabled={!ready} onClick={() => perform(fresh => ({ kind: 'accept_administrator', expectedNonce: fresh.nonce }))}>{translate('Accept administrator nomination')}</button>}
    <TxLine tx={tx} />
  </details>;
}
