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

export interface IngressQueue<P = unknown, N = unknown> {
  enqueue(key: string, item: QueueItem<P, N>): Promise<EnqueueResult>;
  claim(workerId: string, leaseMs: number): Promise<ClaimedItem<P, N> | null>;
  ack(workerId: string, key: string): Promise<void>;
  nack(workerId: string, key: string): Promise<void>;
  deadLetter(workerId: string, key: string, reason: string): Promise<void>;
  getDeadLetters(): Promise<readonly DeadLetterItem<P, N>[]>;
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

export class InMemoryIngressQueue<P = unknown, N = unknown> implements IngressQueue<P, N> {
  readonly #records = new Map<string, InternalRecord<P, N>>();
  readonly #dead: DeadLetterItem<P, N>[] = [];
  readonly #now: () => number;

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

  async ack(workerId: string, key: string): Promise<void> {
    const rec = this.#records.get(key);
    if (rec?.claim?.workerId === workerId) this.#records.delete(key);
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
  }

  async getDeadLetters(): Promise<readonly DeadLetterItem<P, N>[]> {
    return this.#dead.slice();
  }
}
