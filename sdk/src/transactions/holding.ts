import { AnsError } from '../core/errors.js';
import { nodeOf } from '../core/hash.js';
import { type Label, normalizeName } from '../core/label.js';
import { nameStatus, type NameStatus } from '../core/lifecycle.js';
import type { NameRecord, Snapshot } from '../core/types.js';
import type { AnsContext } from '../wallet/context.js';

export type NameRef = string | Label;
const toLabel = (n: NameRef, allowSubnames = false) =>
  typeof n === 'string' ? normalizeName(n, { allowSubnames }) : n;

export type Holding = {
  label: Label;
  node: bigint;
  record: NameRecord;
  /** Editor revision; independent from record.revision on V7. */
  recordRevision: number;
  status: NameStatus;
  /** The context's account controls the current generation. */
  isHolder: boolean;
  canEdit: boolean;
  labelPublished: boolean;
  snapshot: Snapshot;
};

/** Current state of a name from the point of view of the context's account. Always call before a holder action. */
export async function inspectHolding(
  ctx: AnsContext,
  name: NameRef,
  opts: { snapshot?: Snapshot } = {},
): Promise<Holding> {
  const snapshot = opts.snapshot ?? (await ctx.reader.snapshot());
  const label = toLabel(name, ctx.reader.extended);
  const node = await nodeOf(label);
  const [record, published] = await Promise.all([
    ctx.reader.getName(node, snapshot),
    ctx.reader.getPublishedLabel(node, snapshot),
  ]);
  const isHolder = record.generation > 0 && record.owner.equals(ctx.account);
  return {
    label,
    node,
    record,
    recordRevision: ctx.reader.deployment.protocolVersion >= 7
      ? await ctx.reader.getRecordRevision(node, record.generation, snapshot)
      : record.revision,
    status: nameStatus(record, snapshot.timestamp),
    isHolder,
    canEdit:
      isHolder ||
      (ctx.reader.extended &&
        (await ctx.reader.getManager(node, record.generation, snapshot)).equals(ctx.account)),
    labelPublished: published.present,
    snapshot,
  };
}

/** Shared lease and role rules for holder and record actions. */
export function assertHoldingAccess(h: Holding, access: 'owner' | 'editor', allowGrace = false) {
  const allowed = access === 'owner' ? h.isHolder : h.canEdit;
  if (!allowed)
    throw new AnsError(
      'not_holder',
      access === 'owner'
        ? 'this account does not hold the name'
        : 'only the owner or editor can change records',
    );
  if (h.status !== 'active' && !(allowGrace && h.status === 'grace'))
    throw new AnsError('not_active', `name is ${h.status}`);
}
