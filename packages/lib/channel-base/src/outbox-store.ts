/**
 * @koi/channel-base — OutboxStore: durable outbound state machine record.
 */

/**
 * `reserving` is the durable intent record written BEFORE thread CAS. After
 * the CAS succeeds it advances to `reserved`; if the CAS loses contention
 * it advances to `aborted`. A row stuck in `reserving` after a crash is
 * recoverable — see `recoverOrphanedReservations` in `@koi/channel-email`.
 */
export type OutboxStatus =
  | "reserving"
  | "reserved"
  | "sending"
  | "sent"
  | "aborted"
  | "awaiting-recovery";

export type OutboxRecord = {
  readonly messageId: string;
  readonly threadKey: string;
  readonly threadVersion: number;
  readonly payloadHash: string;
  readonly status: OutboxStatus;
  readonly createdAt: number;
};

export interface OutboxStore {
  put(record: OutboxRecord): Promise<void>;
  cas(messageId: string, expectedStatus: OutboxStatus, nextStatus: OutboxStatus): Promise<boolean>;
  get(messageId: string): Promise<OutboxRecord | null>;
  list(filter: { readonly status: OutboxStatus }): Promise<readonly OutboxRecord[]>;
}

export class InMemoryOutboxStore implements OutboxStore {
  readonly #map = new Map<string, OutboxRecord>();

  async put(r: OutboxRecord): Promise<void> {
    this.#map.set(r.messageId, r);
  }

  async cas(id: string, expected: OutboxStatus, next: OutboxStatus): Promise<boolean> {
    const cur = this.#map.get(id);
    if (!cur || cur.status !== expected) return false;
    this.#map.set(id, { ...cur, status: next });
    return true;
  }

  async get(id: string): Promise<OutboxRecord | null> {
    return this.#map.get(id) ?? null;
  }

  async list(filter: { readonly status: OutboxStatus }): Promise<readonly OutboxRecord[]> {
    return [...this.#map.values()].filter((r) => r.status === filter.status);
  }
}
