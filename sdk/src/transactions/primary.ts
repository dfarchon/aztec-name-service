import { AnsError } from "../core/errors.js";
import { nodeOf } from "../core/hash.js";
import { normalizeName } from "../core/label.js";
import { nameStatus } from "../core/lifecycle.js";
import type { AnsContext } from "../wallet/context.js";
import type { NameRef } from "./holder.js";
import { runTx, type TxOptions } from "./tx.js";

/**
 * Confirms, from the address itself, that `name` is its primary name. The forward record must already
 * point at this account; the current binding version is pinned so an older confirmation can never revive.
 */
export async function setPrimary(
  ctx: AnsContext,
  args: { name: NameRef },
  opts?: TxOptions,
) {
  const snapshot = await ctx.reader.snapshot();
  const label =
    typeof args.name === "string" ? normalizeName(args.name, { allowSubnames: ctx.reader.extended }) : args.name;
  const node = await nodeOf(label);
  const rec = await ctx.reader.getName(node, snapshot);
  if (nameStatus(rec, snapshot.timestamp) !== "active")
    throw new AnsError("not_active", "name is not active");
  const forward = await ctx.reader.getAddress(node, rec.generation, snapshot);
  if (!forward.present || !forward.addr.equals(ctx.account)) {
    throw new AnsError(
      "forward_mismatch",
      "the name does not point to this account",
    );
  }
  const call = ctx
    .contract()
    .methods.set_primary(node, rec.generation, forward.bindingVersion);
  const tx = await runTx(ctx, call, opts);
  return {
    tx,
    node,
    generation: rec.generation,
    bindingVersion: forward.bindingVersion,
  };
}

export async function clearPrimary(ctx: AnsContext, opts?: TxOptions) {
  return { tx: await runTx(ctx, ctx.contract().methods.clear_primary(), opts) };
}
