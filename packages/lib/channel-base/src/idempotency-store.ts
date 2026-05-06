/**
 * @koi/channel-base — IdempotencyStore: two-phase reservation + commit.
 *
 * See docs/superpowers/specs/2026-05-05-issue-1363-enterprise-channels-design.md.
 */

export type Lease = {
  readonly key: string;
  readonly token: string;
  readonly expiresAt: number;
};

export type TryBeginResult =
  | { readonly ok: true; readonly lease: Lease }
  | {
      readonly ok: false;
      readonly reason: "in-flight" | "committed" | "poisoned" | "capacity-exhausted";
    };

export interface IdempotencyStore {
  tryBegin(key: string, leaseMs: number): Promise<TryBeginResult>;
  /**
   * Commit a successful handler outcome. Future `tryBegin` on this key
   * returns `committed`, signalling the worker to ack-without-running.
   */
  commit(lease: Lease, commitTtlMs: number): Promise<void>;
  /**
   * Commit a terminal-failure tombstone (handler timeout / max-retry
   * exhaustion). Future `tryBegin` on this key returns `poisoned`,
   * signalling the worker to dead-letter the redelivered queue item
   * rather than silently ack it. Required because some channel adapters
   * (notably email IMAP) gate provider-side acknowledgement on handler
   * success: a poisoned key acked-without-running would let the IMAP
   * adapter mark the message read despite no successful handler run.
   */
  commitPoison(lease: Lease, commitTtlMs: number): Promise<void>;
  abort(lease: Lease): Promise<void>;
  renew(lease: Lease, leaseMs: number): Promise<void>;
}

export type InMemoryIdempotencyStoreOptions = {
  readonly maxCommittedRecords?: number;
  readonly now?: () => number;
};

type LeaseRecord = { readonly token: string; readonly expiresAt: number };
type CommittedRecord = {
  readonly expiresAt: number;
  readonly kind: "ok" | "poison";
};

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #leases = new Map<string, LeaseRecord>();
  readonly #committed = new Map<string, CommittedRecord>();
  readonly #maxCommitted: number;
  readonly #now: () => number;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.#maxCommitted = options.maxCommittedRecords ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  async tryBegin(key: string, leaseMs: number): Promise<TryBeginResult> {
    const now = this.#now();
    const committed = this.#committed.get(key);
    if (committed && committed.expiresAt > now) {
      return { ok: false, reason: committed.kind === "poison" ? "poisoned" : "committed" };
    }
    if (committed) this.#committed.delete(key);
    const live = this.#leases.get(key);
    if (live && live.expiresAt > now) {
      return { ok: false, reason: "in-flight" };
    }
    if (this.#committed.size >= this.#maxCommitted) {
      return { ok: false, reason: "capacity-exhausted" };
    }
    const token = crypto.randomUUID();
    const expiresAt = now + leaseMs;
    this.#leases.set(key, { token, expiresAt });
    return { ok: true, lease: { key, token, expiresAt } };
  }

  async commit(lease: Lease, commitTtlMs: number): Promise<void> {
    this.#commitInternal(lease, commitTtlMs, "ok");
  }

  async commitPoison(lease: Lease, commitTtlMs: number): Promise<void> {
    this.#commitInternal(lease, commitTtlMs, "poison");
  }

  #commitInternal(lease: Lease, commitTtlMs: number, kind: "ok" | "poison"): void {
    const live = this.#leases.get(lease.key);
    if (!live || live.token !== lease.token) {
      throw new Error(`commit: lease ${lease.key} not held`);
    }
    this.#leases.delete(lease.key);
    this.#committed.set(lease.key, { expiresAt: this.#now() + commitTtlMs, kind });
  }

  async abort(lease: Lease): Promise<void> {
    const live = this.#leases.get(lease.key);
    if (live && live.token === lease.token) this.#leases.delete(lease.key);
  }

  async renew(lease: Lease, leaseMs: number): Promise<void> {
    const live = this.#leases.get(lease.key);
    if (!live || live.token !== lease.token) {
      throw new Error(`renew: lease ${lease.key} not held`);
    }
    this.#leases.set(lease.key, {
      token: live.token,
      expiresAt: this.#now() + leaseMs,
    });
  }
}
