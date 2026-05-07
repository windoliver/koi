/**
 * In-memory `KvCommandRunner` mock for testing the state machine without
 * Upstash. TTLs are tracked but no real expiry — tests advance state via
 * direct calls. Atomic block is serialised through a Promise queue so
 * concurrent claim() calls behave the same as production (Redis Lua EVAL
 * is single-threaded per shard).
 */

import type { KvCommandRunner } from "./kv-state-machine.js";

export interface MockKvHandle extends KvCommandRunner {
  readonly debugDump: () => ReadonlyMap<string, string>;
  /** Force-expire a key as if its TTL elapsed. */
  readonly debugExpire: (key: string) => void;
}

export const createMockKv = (): MockKvHandle => {
  const store = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const handle: MockKvHandle = {
    get: async (key) => store.get(key),
    setNxEx: async (key, value, _ttlSec) => {
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    },
    setEx: async (key, value, _ttlSec) => {
      store.set(key, value);
    },
    del: async (key) => (store.delete(key) ? 1 : 0),
    atomic: async (fn) => {
      const next = queue.then(() => fn());
      queue = next.catch(() => undefined);
      return next;
    },
    debugDump: () => store,
    debugExpire: (key) => {
      store.delete(key);
    },
  };
  return handle;
};
