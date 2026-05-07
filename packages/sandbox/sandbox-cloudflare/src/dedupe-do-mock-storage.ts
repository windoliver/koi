/**
 * In-memory `DedupeDoStorage` shim for unit tests. Mirrors the subset of the
 * Cloudflare DO `state.storage` API the dedupe class actually depends on.
 *
 * Transactions are simulated with a snapshot/rollback pattern — sufficient for
 * single-threaded tests. Real CF DO storage gives true atomicity per object id;
 * the production class relies on that, the mock approximates it.
 */

import type { DedupeDoStorage } from "./dedupe-do-types.js";

interface MockStorageState {
  store: Map<string, unknown>;
  alarmAtMs: number | null;
}

const cloneState = (s: MockStorageState): MockStorageState => ({
  store: new Map(s.store),
  alarmAtMs: s.alarmAtMs,
});

export interface MockStorageHandle extends DedupeDoStorage {
  readonly debugDump: () => ReadonlyMap<string, unknown>;
  readonly debugSetAlarm: (atMs: number | null) => void;
  readonly debugGetAlarm: () => number | null;
}

export const createMockDoStorage = (): MockStorageHandle => {
  const state: MockStorageState = { store: new Map(), alarmAtMs: null };
  // Real CF DO storage is single-threaded per object id. The mock serialises
  // transactions through this promise chain so concurrent claim() calls in
  // tests behave the way they will in production.
  let txnQueue: Promise<unknown> = Promise.resolve();

  const wrap = (target: MockStorageState): DedupeDoStorage => ({
    get: async <T>(key: string) => target.store.get(key) as T | undefined,
    put: async (entries) => {
      for (const [k, v] of Object.entries(entries)) target.store.set(k, v);
    },
    delete: async (keys) => {
      let n = 0;
      for (const k of keys) if (target.store.delete(k)) n++;
      return n;
    },
    list: async (options) => {
      const prefix = options?.prefix ?? "";
      const out = new Map<string, unknown>();
      for (const [k, v] of target.store) {
        if (k.startsWith(prefix)) out.set(k, v);
      }
      return out;
    },
    setAlarm: async (whenMs) => {
      target.alarmAtMs = whenMs;
    },
    getAlarm: async () => target.alarmAtMs,
    transaction: async (fn) => {
      const next = txnQueue.then(async () => {
        const snapshot = cloneState(target);
        try {
          const txn = wrap(target);
          return await fn(txn);
        } catch (e) {
          target.store = snapshot.store;
          target.alarmAtMs = snapshot.alarmAtMs;
          throw e;
        }
      });
      txnQueue = next.catch(() => undefined);
      return next;
    },
  });

  return {
    ...wrap(state),
    debugDump: () => state.store,
    debugSetAlarm: (atMs) => {
      state.alarmAtMs = atMs;
    },
    debugGetAlarm: () => state.alarmAtMs,
  };
};
