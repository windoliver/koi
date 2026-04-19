import type { CoalescedMatch, PatternMatch, PendingMatchStore, TurnRequestKey } from "@koi/core";

const MAX_BUCKETS = 256;
const MAX_TOMBSTONES = 4096;

interface WindowState {
  count: number;
  lastTimestamp: number;
  /** Per-record payloads keyed by monotonic recordId. */
  records: Map<number, PatternMatch>;
}

interface Snapshot {
  readonly view: readonly CoalescedMatch[];
  readonly idsByKey: Map<string, readonly number[]>;
  readonly tombstoneSeqsDelivered: readonly number[];
  readonly tombstoneOverflowCountDelivered: number;
}

interface TombstoneEntry {
  readonly seq: number;
  readonly firstMatch: PatternMatch;
  readonly lastTimestamp: number;
}

function keyOf(taskId: string, event: string, stream: "stdout" | "stderr"): string {
  return `${taskId}\u241F${event}\u241F${stream}`;
}

export function createPendingMatchStore(): PendingMatchStore {
  const currentWindow = new Map<string, WindowState>();
  const snapshotCache = new WeakMap<TurnRequestKey, Snapshot>();
  const matchers = new Set<{ readonly cancel: () => void }>();
  // let is justified: monotonically incremented counters (mutable by design)
  let nextRecordId = 0;
  let nextTombstoneSeq = 0;
  let disposed = false;

  const tombstones: TombstoneEntry[] = [];
  // let is justified: overflow counter that accumulates evictions beyond MAX_TOMBSTONES
  let tombstoneOverflowCount = 0;

  function pushTombstone(entry: Omit<TombstoneEntry, "seq">): void {
    if (tombstones.length >= MAX_TOMBSTONES) {
      tombstones.shift();
      tombstoneOverflowCount += 1;
    }
    tombstones.push({ seq: nextTombstoneSeq++, ...entry });
  }

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

    const tombstoneSeqsDelivered: number[] = [];
    for (const t of tombstones) {
      tombstoneSeqsDelivered.push(t.seq);
      view.push({
        taskId: t.firstMatch.taskId,
        event: "__watch_dropped__",
        stream: t.firstMatch.stream,
        firstMatch: t.firstMatch,
        count: 0,
        lastTimestamp: t.lastTimestamp,
      });
    }

    const tombstoneOverflowCountDelivered = tombstoneOverflowCount;

    if (tombstoneOverflowCount > 0 && tombstones.length > 0) {
      const sample = tombstones[0];
      if (sample !== undefined) {
        view.push({
          taskId: sample.firstMatch.taskId,
          event: "__watch_dropped_older__",
          stream: sample.firstMatch.stream,
          firstMatch: sample.firstMatch,
          count: tombstoneOverflowCount,
          lastTimestamp: Date.now(),
        });
      }
    }

    return { view, idsByKey, tombstoneSeqsDelivered, tombstoneOverflowCountDelivered };
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
        return;
      }
      // New bucket — evict oldest if at cap.
      if (currentWindow.size >= MAX_BUCKETS) {
        const oldestIter = currentWindow.entries().next();
        if (!oldestIter.done && oldestIter.value !== undefined) {
          const [oldestKey, oldest] = oldestIter.value;
          let firstId = Number.POSITIVE_INFINITY;
          for (const rid of oldest.records.keys()) {
            if (rid < firstId) firstId = rid;
          }
          const oldestFirstMatch = oldest.records.get(firstId);
          if (oldestFirstMatch !== undefined) {
            pushTombstone({ firstMatch: oldestFirstMatch, lastTimestamp: oldest.lastTimestamp });
          }
          currentWindow.delete(oldestKey);
        }
      }
      currentWindow.set(key, {
        count: 1,
        lastTimestamp: match.timestamp,
        records: new Map([[id, match]]),
      });
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
      // Remove only tombstones that were part of this snapshot — preserve later arrivals.
      const deliveredSet = new Set(snap.tombstoneSeqsDelivered);
      for (let i = tombstones.length - 1; i >= 0; i--) {
        const t = tombstones[i];
        if (t !== undefined && deliveredSet.has(t.seq)) {
          tombstones.splice(i, 1);
        }
      }
      // Decrement overflow by the delivered amount only; clamp to 0 defensively.
      tombstoneOverflowCount = Math.max(
        0,
        tombstoneOverflowCount - snap.tombstoneOverflowCountDelivered,
      );
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
      tombstones.length = 0;
      tombstoneOverflowCount = 0;
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
