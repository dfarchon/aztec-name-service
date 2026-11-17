import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { NameRegistryV8Contract } from '../artifacts/NameRegistryV8.js';
import { NameRegistryV8RehearsalContract } from '../artifacts/NameRegistryV8Rehearsal.js';
import metadata from '../artifacts/modular-metadata.json' with { type: 'json' };
import { AnsError } from '../core/errors.js';
import type { AnsContext } from '../wallet/context.js';
import { runTx, type TxOptions } from './tx.js';

/** Nonces are uint64; class IDs are field integers; sequence is uint32; timestamps use chain seconds. */
export type CoreUpgradeAction = { expectedNonce: bigint } & (
  | { kind: 'approve_release'; classId: bigint; family: bigint; releaseSeq: number }
  | { kind: 'revoke_release'; classId: bigint }
  | { kind: 'approve_edge_pair'; older: bigint; newer: bigint }
  | { kind: 'revoke_edge' | 'propose' | 'execute'; from: bigint; to: bigint }
  | { kind: 'cancel_proposal' | 'cancel_scheduled' | 'accept_administrator' }
  | { kind: 'nominate_administrator'; administrator: AztecAddress }
);
export const CORE_UPGRADE_FAMILY = 0x414e535f434f5245n;

/** Uses the shared wallet queue, identity checks, dynamic artifact and fixed-delay guards. No retries or resends. */
export async function administerCoreUpgrade(ctx: AnsContext, action: CoreUpgradeAction, options: TxOptions = {}) {
  if (action.expectedNonce < 0n || action.expectedNonce >= 1n << 64n) throw new AnsError('invalid_argument', 'expectedNonce must be uint64');
  const result = await runTx(ctx, async () => {
    const state = await ctx.reader.getCoreUpgradeState();
    if (state.nonce !== action.expectedNonce) throw new AnsError('invalid_argument', 'upgrade nonce changed; refresh status before signing');
    const A = BigInt(metadata.v8.classId), B = BigInt(metadata.v8Rehearsal.classId);
    const known = (id: bigint) => id === A || (ctx.reader.upgradeProfile.allowRehearsalSuccessor === true && id === B);
    const reviewedEdge = (from: bigint, to: bigint) => known(from) && known(to) && ((from === A && to === B) || (from === B && to === A));
    if ('classId' in action && !known(action.classId)) throw new AnsError('wrong_deployment', 'release has no reviewed artifact in this profile');
    if ('from' in action && !reviewedEdge(action.from, action.to)) throw new AnsError('wrong_deployment', 'directed edge has no reviewed artifacts in this profile');
    if (action.kind === 'approve_edge_pair' && (!known(action.older) || !known(action.newer) || action.older !== A || action.newer !== B)) throw new AnsError('wrong_deployment', 'edge pair does not match reviewed release order');
    if (action.kind === 'approve_release' && action.releaseSeq !== (action.classId === A ? 1 : 2)) throw new AnsError('invalid_argument', 'releaseSeq differs from reviewed exact artifact');
    if (action.kind === 'propose' && action.from !== BigInt(state.currentClass)) throw new AnsError('invalid_argument', 'source differs from snapshot current class');
    if (action.kind === 'execute' && (!state.pending.active || action.from !== state.pending.from || action.to !== state.pending.to)) throw new AnsError('invalid_argument', 'arguments differ from stored proposal');
    const contract = state.currentClass === metadata.v8.classId
      ? NameRegistryV8Contract.at(ctx.reader.registry, ctx.wallet)
      : NameRegistryV8RehearsalContract.at(ctx.reader.registry, ctx.wallet);
    const n = action.expectedNonce;
    const field = (id: bigint) => new Fr(id);
    switch (action.kind) {
      case 'approve_release':
        if (!Number.isInteger(action.releaseSeq) || action.releaseSeq <= 0 || action.releaseSeq > 0xffff_ffff) throw new AnsError('invalid_argument', 'releaseSeq must be a positive uint32');
        if (action.family !== CORE_UPGRADE_FAMILY) throw new AnsError('invalid_argument', 'wrong core family');
        if (![metadata.v8.classId, ...(ctx.reader.upgradeProfile.allowRehearsalSuccessor ? [metadata.v8Rehearsal.classId] : [])].some(id => BigInt(id) === action.classId)) throw new AnsError('wrong_deployment', 'release has no reviewed artifact in this profile');
        return contract.methods.approve_release(n, field(action.classId), field(action.family), action.releaseSeq);
      case 'revoke_release': return contract.methods.revoke_release(n, field(action.classId));
      case 'approve_edge_pair': return contract.methods.approve_edge_pair(n, field(action.older), field(action.newer));
      case 'revoke_edge': return contract.methods.revoke_edge(n, field(action.from), field(action.to));
      case 'propose': return contract.methods.propose_upgrade(n, field(action.from), field(action.to));
      case 'execute': return contract.methods.execute_upgrade(n, field(action.from), field(action.to));
      case 'cancel_proposal': return contract.methods.cancel_upgrade(n);
      case 'cancel_scheduled':
        if (!state.scheduled.active || state.scheduled.activationAt - state.snapshot.timestamp <= 900n) throw new AnsError('unsupported', 'scheduled cancellation needs more than 900 seconds of proving/inclusion margin');
        return contract.methods.cancel_scheduled_upgrade(n);
      case 'nominate_administrator': return contract.methods.nominate_administrator(n, action.administrator);
      case 'accept_administrator': return contract.methods.accept_administrator(n);
    }
  }, options);
  // Receipt tracking is preserved by runTx. A readback exception must never lead to automatic resubmission.
  try { return { ...result, readback: await ctx.reader.getCoreUpgradeState() }; }
  catch (cause) { throw new AnsError('unknown_tx_state', 'transaction tracked; upgrade readback unavailable; recover by this hash without resending', cause, result.txHash); }
}
