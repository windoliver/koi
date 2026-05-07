/**
 * @koi/channel-base — IngressQueue: durable inbound work item buffer.
 *
 * Webhook handlers enqueue once on receipt; a separate handler worker
 * claims items, dispatches to the user handler, and acks/nacks/dead-letters.
 */

export type QueueItem<P = unknown, N = unknown> = {
  readonly key: string;
  readonly payload: P;
  readonly normalized: N;
};

export type ClaimedItem<P = unknown, N = unknown> = QueueItem<P, N> & {
  readonly attempts: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
};

export type DeadLetterItem<P = unknown, N = unknown> = QueueItem<P, N> & {
  readonly attempts: number;
  readonly reason: string;
};

export type EnqueueResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "duplicate" };

export type RenewResult =
  | { readonly ok: true; readonly leaseExpiresAt: number }
  | { readonly ok: false };

export type DrainResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "dead-letter"; readonly details: string };

export interface IngressQueue<P = unknown, N = unknown> {
  enqueue(key: string, item: QueueItem<P, N>): Promise<EnqueueResult>;
  claim(workerId: string, leaseMs: number): Promise<ClaimedItem<P, N> | null>;
  /**
   * Extend an existing claim's lease. Returns `{ok:false}` if the worker no
   * longer owns the claim (expired, reassigned, or item gone). Workers MUST
   * abort the in-flight handler on `{ok:false}` to prevent duplicate
   * execution under a successor claim.
   */
  renew(workerId: string, key: string, leaseMs: number): Promise<RenewResult>;
  ack(workerId: string, key: string): Promise<void>;
  nack(workerId: string, key: string): Promise<void>;
  deadLetter(workerId: string, key: string, reason: string): Promise<void>;
  getDeadLetters(): Promise<readonly DeadLetterItem<P, N>[]>;
  /**
   * Resolves when the worker reaches a terminal state for `key`:
   * `{ok:true}` on `ack`, `{ok:false, reason:"dead-letter"}` on
   * `deadLetter`. Resolves immediately if `key` is already terminal or
   * unknown. Used by ingress paths that need to gate provider
   * acknowledgement on handler success (e.g., IMAP for email).
   */
  awaitDrain(key: string): Promise<DrainResult>;
}

type ClaimRecord = {
  readonly workerId: string;
  readonly token: string;
  readonly expiresAt: number;
};

type InternalRecord<P, N> = {
  readonly item: QueueItem<P, N>;
  readonly attempts: number;
  readonly claim: ClaimRecord | null;
};

export type InMemoryIngressQueueOptions = {
  readonly now?: () => number;
};

type DrainWaiter = {
  readonly resolve: (r: DrainResult) => void;
};

export class InMemoryIngressQueue<P = unknown, N = unknown> implements IngressQueue<P, N> {
  readonly durability = "ephemeral" as const;
  readonly #records = new Map<string, InternalRecord<P, N>>();
  readonly #dead: DeadLetterItem<P, N>[] = [];
  readonly #now: () => number;
  readonly #drainWaiters = new Map<string, DrainWaiter[]>();

  constructor(options: InMemoryIngressQueueOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  async enqueue(key: string, item: QueueItem<P, N>): Promise<EnqueueResult> {
    if (this.#records.has(key)) return { ok: false, reason: "duplicate" };
    this.#records.set(key, { item, attempts: 0, claim: null });
    return { ok: true };
  }

  async claim(workerId: string, leaseMs: number): Promise<ClaimedItem<P, N> | null> {
    const now = this.#now();
    for (const [k, rec] of this.#records) {
      if (rec.claim && rec.claim.expiresAt > now) continue;
      const token = crypto.randomUUID();
      const expiresAt = now + leaseMs;
      this.#records.set(k, {
        item: rec.item,
        attempts: rec.attempts,
        claim: { workerId, token, expiresAt },
      });
      return {
        ...rec.item,
        attempts: rec.attempts,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
      };
    }
    return null;
  }

  async renew(workerId: string, key: string, leaseMs: number): Promise<RenewResult> {
    const now = this.#now();
    const rec = this.#records.get(key);
    if (!rec?.claim) return { ok: false };
    if (rec.claim.workerId !== workerId) return { ok: false };
    if (rec.claim.expiresAt <= now) return { ok: false };
    const expiresAt = now + leaseMs;
    this.#records.set(key, {
      item: rec.item,
      attempts: rec.attempts,
      claim: { workerId, token: rec.claim.token, expiresAt },
    });
    return { ok: true, leaseExpiresAt: expiresAt };
  }

  async ack(workerId: string, key: string): Promise<void> {
    const rec = this.#records.get(key);
    if (rec?.claim?.workerId === workerId) {
      this.#records.delete(key);
      this.#fireDrain(key, { ok: true });
    }
  }

  async nack(workerId: string, key: string): Promise<void> {
    const rec = this.#records.get(key);
    if (rec?.claim?.workerId !== workerId) return;
    this.#records.set(key, {
      item: rec.item,
      attempts: rec.attempts + 1,
      claim: null,
    });
  }

  async deadLetter(workerId: string, key: string, reason: string): Promise<void> {
    const rec = this.#records.get(key);
    if (rec?.claim?.workerId !== workerId) return;
    this.#dead.push({ ...rec.item, attempts: rec.attempts, reason });
    this.#records.delete(key);
    this.#fireDrain(key, { ok: false, reason: "dead-letter", details: reason });
  }

  async getDeadLetters(): Promise<readonly DeadLetterItem<P, N>[]> {
    return this.#dead.slice();
  }

  async awaitDrain(key: string): Promise<DrainResult> {
    // If the key is unknown, treat as already drained (ack-equivalent).
    // If it sits in the dead-letter list, surface that.
    if (!this.#records.has(key)) {
      const dl = this.#dead.find((d) => d.key === key);
      if (dl) return { ok: false, reason: "dead-letter", details: dl.reason };
      return { ok: true };
    }
    return new Promise<DrainResult>((resolve) => {
      const waiters = this.#drainWaiters.get(key) ?? [];
      waiters.push({ resolve });
      this.#drainWaiters.set(key, waiters);
    });
  }

  #fireDrain(key: string, result: DrainResult): void {
    const waiters = this.#drainWaiters.get(key);
    if (!waiters) return;
    this.#drainWaiters.delete(key);
    for (const w of waiters) w.resolve(result);
  }
}
