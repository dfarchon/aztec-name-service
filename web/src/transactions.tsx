import { useEffect } from "react";
import type { AnsContext, TxState } from "@ans/sdk";
import { getSession, recordWriter, useSession } from "./session";
import { errorMessage } from "./format";
import { PENDING_TX } from "./usability";

const running = new WeakMap<AnsContext, Set<string>>();
export async function refreshTransaction(ctx: AnsContext, id: string, hash: string) {
  let active = running.get(ctx);
  if (!active) running.set(ctx, active = new Set());
  if (active.has(hash)) return;
  active.add(hash);
  try {
    const write = recordWriter(ctx);
    const { trackTx, toAnsError } = await import("@ans/sdk");
    let observed: TxState | undefined;
    try {
      const receipt = await trackTx(ctx.reader.node, hash, { timeoutMs: 15000, pollMs: 1500, waitFor: "confirmed", onUpdate: u => { observed = u.state; } });
      await write(r => ({ ...r, txs: r.txs.map(t => t.id === id || t.txHash === hash ? { ...t, state: receipt.state, error: undefined } : t) }));
    } catch (e) {
      const err = toAnsError(e);
      const state = err.code === "reverted" ? "reverted" : err.code === "dropped" ? "dropped" : observed ?? "unknown";
      await write(r => ({ ...r, txs: r.txs.map(t => t.id === id || t.txHash === hash ? { ...t, state, error: state === "included" ? undefined : errorMessage(e) } : t) }));
    }
  } finally { active.delete(hash); }
}

export function TransactionWatch() {
  const { ctx } = useSession();
  useEffect(() => {
    if (!ctx) return;
    let live = true;
    let ticking = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!live || ticking) return;
      ticking = true;
      try {
        const s = getSession();
        if (!document.hidden && s.ctx === ctx && s.status === "ready") {
          // Limit work per tick, deduplicate hashes, and never broadcast from a recovery watcher.
          const pending = [...new Map((s.records?.txs ?? []).filter(t => t.txHash && PENDING_TX.has(t.state)).map(t => [t.txHash!, t])).values()].slice(0, 4);
          await Promise.allSettled(pending.map(t => refreshTransaction(ctx, t.id, t.txHash!)));
        }
      } finally {
        ticking = false;
        if (live) timer = setTimeout(tick, 10000);
      }
    };
    void tick();
    const resume = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", resume);
    return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, [ctx]);
  return null;
}
