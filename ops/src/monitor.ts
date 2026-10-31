import type { ModulesState } from "./modular.js";
export type Check = { name: string; ok: boolean; detail: string };
export type Incident = { name: string; kind: "alert" | "recovered" | "changed"; at: number };
export type State = { checkedAt: number; release?: string; checks: Check[]; failures: Record<string, number>; open: string[]; block?: number; blockAdvancedAt?: number; modules?: ModulesState };

/** Alert once after three failures; retain incidents until an actual healthy check recovers. */
export function transition(previous: State | undefined, checks: Check[], at: number, block?: number): { state: State; incidents: Incident[] } {
  const failures: Record<string, number> = {};
  const open = new Set(previous?.open ?? []);
  const incidents: Incident[] = [];
  for (const check of checks) {
    failures[check.name] = check.ok ? 0 : (previous?.failures[check.name] ?? 0) + 1;
    if (!check.ok && failures[check.name] >= 3 && !open.has(check.name)) {
      open.add(check.name); incidents.push({ name: check.name, kind: "alert", at });
    } else if (check.ok && open.delete(check.name)) incidents.push({ name: check.name, kind: "recovered", at });
  }
  const blockAdvancedAt = block !== undefined && (previous?.block === undefined || block > previous.block) ? at : previous?.blockAdvancedAt ?? at;
  return { state: { checkedAt: at, checks, failures, open: [...open], block: block ?? previous?.block, blockAdvancedAt }, incidents };
}

export function metricSample(input: unknown): { name: string; value: number; release: string; bucket: number } | undefined {
  if (!input || typeof input !== "object") return;
  const d = input as Record<string, unknown>;
  if (Object.keys(d).sort().join(",") !== "name,release,value" || typeof d.release !== "string" || !/^[a-zA-Z0-9.-]{1,64}$/.test(d.release) || typeof d.name !== "string" || !["LCP", "INP", "CLS"].includes(d.name) || typeof d.value !== "number" || !Number.isFinite(d.value) || d.value < 0 || d.value > (d.name === "CLS" ? 10 : 120000)) return;
  const buckets = d.name === "CLS" ? [0.1, 0.25, 0.5, 1, 2, 10] : [200, 500, 1000, 2500, 4000, 10000, 60000, 120000];
  return { name: d.name, value: d.value, release: d.release, bucket: buckets.find(b => (d.value as number) <= b)! };
}
