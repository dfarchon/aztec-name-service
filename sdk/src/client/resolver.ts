import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";

import type { Snapshot } from "../core/types.js";
import { AnsError } from "../core/errors.js";
import type { RegistryReader } from "./reader.js";
import { type BatchEntry, resolvePrimaryMany } from "./resolve.js";

export type ResolverOptions = {
  /** Upper bound for a cached answer. Never exceeds the name's own expiry. Default 30 s. */
  ttlMs?: number;
  /** How often cached answers are checked against reorgs. Default 15 s. */
  reorgCheckMs?: number;
};

type Entry = { value: BatchEntry; until: number; snapshot: Snapshot };

/**
 * Cached reverse resolution for display surfaces (labels, leaderboards). Entries are keyed by deployment and
 * address; errors are never cached; a reorg below a cached snapshot drops everything.
 */
export class Resolver {
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<BatchEntry>>();
  private lastReorgCheck = 0;
  private classId?: string;
  private epoch = 0;
  private reorgCheck?: Promise<void>;

  constructor(
    readonly reader: RegistryReader,
    private readonly opts: ResolverOptions = {},
  ) {}

  private key(address: AztecAddress) {
    return `${this.reader.registry.toString()}|${address.toString()}`;
  }

  /** Drops every cached answer, e.g. on account, network or season switch. Late results of older calls are ignored. */
  invalidate() {
    this.entries.clear();
    this.inflight.clear();
    this.epoch++;
  }

  async primary(address: AztecAddress): Promise<BatchEntry> {
    return (await this.primaryMany([address])).get(address.toString())!;
  }

  async primaryMany(
    addresses: AztecAddress[],
  ): Promise<Map<string, BatchEntry>> {
    if (addresses.length === 0) return new Map();
    if (this.reader.modular) {
      const classId = await this.reader.assertCurrentClass();
      if (this.classId && classId !== this.classId) this.invalidate();
      this.classId = classId;
    }
    await this.checkReorg();
    const now = Date.now();
    const out = new Map<string, BatchEntry>();
    const missing: AztecAddress[] = [];
    const seen = new Set<string>();
    const waiting: [string, Promise<BatchEntry>][] = [];
    for (const a of addresses) {
      const k = this.key(a);
      if (seen.has(k)) continue;
      seen.add(k);
      const hit = this.entries.get(k);
      if (hit && hit.until > now) out.set(a.toString(), hit.value);
      else if (this.inflight.has(k))
        waiting.push([a.toString(), this.inflight.get(k)!]);
      else missing.push(a);
    }

    if (missing.length) {
      const epoch = this.epoch;
      const batch = resolvePrimaryMany(this.reader, missing);
      for (const a of missing) {
        const k = this.key(a);
        const p = batch.then((m) => m.get(a.toString())!);
        this.inflight.set(k, p);
        p.finally(
          () => this.inflight.get(k) === p && this.inflight.delete(k),
        ).catch(() => {});
      }
      const results = await batch;
      for (const a of missing) {
        const value = results.get(a.toString())!;
        out.set(a.toString(), value);
        if (epoch === this.epoch && value.status !== "error") {
          this.entries.set(this.key(a), {
            value,
            until: now + this.ttlFor(value),
            snapshot: value.snapshot,
          });
        }
      }
    }
    for (const [k, p] of waiting) out.set(k, await p);
    return out;
  }

  private ttlFor(value: BatchEntry): number {
    const ttl = this.opts.ttlMs ?? 30_000;
    if (value.status !== "verified") return ttl;
    const remaining = Number(value.expiresAt - value.snapshot.timestamp) * 1000;
    return Math.max(0, Math.min(ttl, remaining));
  }

  private async checkReorg() {
    if (this.reorgCheck) return this.reorgCheck;
    const now = Date.now();
    for (const [key, entry] of this.entries)
      if (entry.until <= now) this.entries.delete(key);
    if (
      now - this.lastReorgCheck < (this.opts.reorgCheckMs ?? 15_000) ||
      this.entries.size === 0
    )
      return;
    const snapshots = new Map<string, Snapshot>();
    for (const e of this.entries.values()) {
      snapshots.set(e.snapshot.blockHash, e.snapshot);
    }
    const epoch = this.epoch;
    const check = (async () => {
      try {
        // Entries may have been filled on different forks; a newer canonical block does not validate an older
        // cached hash. Check each distinct snapshot once, independent of the number of cached addresses.
        const canonical = await Promise.all([...snapshots.values()].map(s => this.reader.isCanonical(s)));
        if (canonical.some(value => !value) && epoch === this.epoch)
          this.invalidate();
        this.lastReorgCheck = now;
      } catch (e) {
        if (epoch === this.epoch) this.invalidate();
        throw new AnsError("network", "cannot verify cached snapshot", e);
      }
    })();
    this.reorgCheck = check;
    try {
      await check;
    } finally {
      if (this.reorgCheck === check) this.reorgCheck = undefined;
    }
  }
}
