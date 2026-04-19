import type { CoalescedMatch, PatternMatch, PendingMatchStore, TurnRequestKey } from "@koi/core";

interface WindowState {
  count: number;
  lastTimestamp: number;
  /** Per-record payloads keyed by monotonic recordId. */
  records: Map<number, PatternMatch>;
}

interface Snapshot {
  readonly view: readonly CoalescedMatch[];
  readonly idsByKey: Map<string, readonly number[]>;
}

function keyOf(taskId: string, event: string, stream: "stdout" | "stderr"): string {
  return `${taskId}\u241F${event}\u241F${stream}`;
}

export function createPendingMatchStore(): PendingMatchStore {
  const currentWindow = new Map<string, WindowState>();
  const snapshotCache = new WeakMap<TurnRequestKey, Snapshot>();
  const matchers = new Set<{ readonly cancel: () => void }>();
  let nextRecordId = 0;
  let disposed = false;

  function snapshotWindow(): Snapshot {
    const view: CoalescedMatch[] = [];
    const idsByKey = new Map<string, readonly number[]>();
    for (const [key, s] of currentWindow) {
      let firstId = Number.POSITIVE_INFINITY;
      for (const id of s.records.keys()) {
        if (id < firstId) firstId = id;
      }
      const firstMatch = s.records.get(firstId);
      if (firstMatch === undefined) continue;
      view.push({
        taskId: firstMatch.taskId,
        event: firstMatch.event,
        stream: firstMatch.stream,
        firstMatch,
        count: s.count,
        lastTimestamp: s.lastTimestamp,
      });
      idsByKey.set(key, Array.from(s.records.keys()));
    }
    return { view, idsByKey };
  }

  return {
    record(match) {
      if (disposed) return;
      const key = keyOf(String(match.taskId), match.event, match.stream);
      const id = nextRecordId++;
      const existing = currentWindow.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastTimestamp = match.timestamp;
        existing.records.set(id, match);
      } else {
        currentWindow.set(key, {
          count: 1,
          lastTimestamp: match.timestamp,
          records: new Map([[id, match]]),
        });
      }
    },
    peek(request) {
      if (disposed) return [];
      const cached = snapshotCache.get(request);
      if (cached) return cached.view;
      const snap = snapshotWindow();
      snapshotCache.set(request, snap);
      return snap.view;
    },
    ack(request) {
      if (disposed) return;
      const snap = snapshotCache.get(request);
      if (!snap) return;
      for (const [key, ids] of snap.idsByKey) {
        const state = currentWindow.get(key);
        if (!state) continue;
        for (const id of ids) state.records.delete(id);
        if (state.records.size === 0) {
          currentWindow.delete(key);
        } else {
          state.count = state.records.size;
          let latest = 0;
          for (const m of state.records.values()) {
            if (m.timestamp > latest) latest = m.timestamp;
          }
          state.lastTimestamp = latest;
        }
      }
      snapshotCache.delete(request);
    },
    pending() {
      if (disposed) return 0;
      return currentWindow.size;
    },
    registerMatcher(matcher) {
      if (disposed) return;
      matchers.add(matcher);
    },
    unregisterMatcher(matcher) {
      matchers.delete(matcher);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const m of matchers) {
        try {
          m.cancel();
        } catch {
          /* swallow */
        }
      }
      matchers.clear();
      currentWindow.clear();
    },
  };
}
