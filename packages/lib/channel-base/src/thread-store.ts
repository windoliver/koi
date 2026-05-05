/**
 * @koi/channel-base — ThreadStore: CAS-backed thread state for outbound messaging.
 */

export type ThreadState = { readonly chain: readonly string[] };

export interface ThreadStore {
  get(threadKey: string): Promise<{ readonly state: ThreadState; readonly version: number } | null>;
  cas(threadKey: string, expectedVersion: number, next: ThreadState): Promise<boolean>;
}

type ThreadRecord = {
  readonly state: ThreadState;
  readonly version: number;
};

export class InMemoryThreadStore implements ThreadStore {
  readonly #map = new Map<string, ThreadRecord>();

  async get(k: string): Promise<{ readonly state: ThreadState; readonly version: number } | null> {
    const r = this.#map.get(k);
    return r ? { state: r.state, version: r.version } : null;
  }

  async cas(k: string, expected: number, next: ThreadState): Promise<boolean> {
    const cur = this.#map.get(k);
    const v = cur?.version ?? 0;
    if (v !== expected) return false;
    this.#map.set(k, { state: next, version: v + 1 });
    return true;
  }
}
