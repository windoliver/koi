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
      readonly reason: "in-flight" | "committed" | "capacity-exhausted";
    };

export interface IdempotencyStore {
  tryBegin(key: string, leaseMs: number): Promise<TryBeginResult>;
  commit(lease: Lease, commitTtlMs: number): Promise<void>;
  abort(lease: Lease): Promise<void>;
  renew(lease: Lease, leaseMs: number): Promise<void>;
}

export type InMemoryIdempotencyStoreOptions = {
  readonly maxCommittedRecords?: number;
  readonly now?: () => number;
};

type LeaseRecord = { token: string; expiresAt: number };
type CommittedRecord = { expiresAt: number };

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
      return { ok: false, reason: "committed" };
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
    const live = this.#leases.get(lease.key);
    if (!live || live.token !== lease.token) {
      throw new Error(`commit: lease ${lease.key} not held`);
    }
    this.#leases.delete(lease.key);
    this.#committed.set(lease.key, { expiresAt: this.#now() + commitTtlMs });
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
    live.expiresAt = this.#now() + leaseMs;
  }
}
