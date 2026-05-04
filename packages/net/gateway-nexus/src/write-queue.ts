/**
 * Coalescing write queue: dedups updates to the same path within a flush
 * window. Immediate writes (create/delete) bypass coalescing.
 *
 * Failure semantics: a failed write requeues at the head of the next
 * flush so a transient Nexus outage does not silently drop session
 * persistence. A newer write for the same path supersedes the requeued
 * stale value (last-writer-wins by enqueue order), so coalescing is
 * preserved. Per-entry retry is bounded by `maxRetries`; entries that
 * exhaust retries are dropped and reported via `onError` so the host
 * can fail-closed instead of silently losing the write.
 */

import type { WriteQueueConfig } from "./config.js";
import { DEFAULT_WRITE_QUEUE_CONFIG } from "./config.js";

type WriteFn = (path: string, data: string) => Promise<void>;
type ErrorReporter = (
  err: unknown,
  ctx: { readonly path: string; readonly retries: number },
) => void;

const DEFAULT_MAX_RETRIES = 5;

export interface WriteQueue {
  /** Queue a write. immediate=true bypasses coalescing for create/delete. */
  readonly enqueue: (path: string, data: string, immediate?: boolean) => void;
  /** Drop any pending entry for `path` and tombstone the path so any
   *  in-flight (failed OR successful) write cannot be requeued or otherwise
   *  resurrect the value. The tombstone is cleared once any in-flight write
   *  for that path settles (whether or not delete won the race). Used by
   *  delete() to prevent ghost-resurrect of a deleted record. */
  readonly cancel: (path: string) => void;
  /** Resolve once any in-flight write for `path` (immediate or flush-batch)
   *  has settled. delete() awaits this before issuing the remote delete so
   *  write-then-delete ordering is preserved at the Nexus layer. */
  readonly drainPath: (path: string) => Promise<void>;
  /** Flush all pending writes. Resolves once every in-flight write settles. */
  readonly flush: () => Promise<void>;
  /** Stop the timer and drain. */
  readonly dispose: () => Promise<void>;
  /** Number of pending entries. */
  readonly size: () => number;
}

interface PendingEntry {
  readonly data: string;
  readonly retries: number;
}

export function createWriteQueue(
  writeFn: WriteFn,
  configOverrides?: Partial<WriteQueueConfig>,
  onError?: ErrorReporter,
): WriteQueue {
  const config: WriteQueueConfig = { ...DEFAULT_WRITE_QUEUE_CONFIG, ...configOverrides };
  const pending = new Map<string, PendingEntry>();
  // Paths cancelled while a write may be in flight. Cleared once the
  // in-flight write for the path settles AND no immediate-write tombstone
  // recheck is outstanding. Bounded by (in-flight count + delete races).
  const tombstones = new Set<string>();
  // Tracks ALL in-flight writeFn calls by path so delete() can serialize
  // against EVERY concurrent write (not just the latest one) and so
  // tombstone cleanup waits for every settler. A Set per path handles the
  // edge case where an immediate write is in flight while flushAll picks up
  // a newly queued write for the same path.
  const inFlightByPath = new Map<string, Set<Promise<unknown>>>();
  // Outstanding immediate-write promises so dispose() can drain them.
  const immediatePromises = new Set<Promise<unknown>>();
  // let justified: timer holder, mutated on (re)start
  let timer: ReturnType<typeof setInterval> | undefined;
  // let justified: tracks the in-flight flushAll so dispose/flush can await
  let inFlight: Promise<void> | undefined;

  function reportError(err: unknown, path: string, retries: number): void {
    if (onError === undefined) return;
    try {
      onError(err, { path, retries });
    } catch {
      /* swallow: error reporter must never crash the flush loop */
    }
  }

  /** Wrap writeFn so each call is tracked by path. Tombstone cleanup is
   *  deliberately NOT done here — finally() would run BEFORE flushAll's
   *  requeue-decision loop sees the tombstone, defeating the protection.
   *  Cleanup happens explicitly in flushAll/fireImmediate AFTER the
   *  requeue decision.
   *
   *  writeFn is invoked via Promise.resolve().then(...) so a synchronous
   *  throw becomes a rejected promise — without this, a sync throw would
   *  bypass the inFlightByPath registration and Promise.allSettled in
   *  flushAll, silently dropping the entry without any retry or onError. */
  function trackedWrite(path: string, data: string): Promise<void> {
    let set = inFlightByPath.get(path);
    if (set === undefined) {
      set = new Set();
      inFlightByPath.set(path, set);
    }
    const p = Promise.resolve().then(() => writeFn(path, data));
    set.add(p);
    return p.finally(() => {
      const s = inFlightByPath.get(path);
      if (s === undefined) return;
      s.delete(p);
      if (s.size === 0) inFlightByPath.delete(path);
    });
  }

  /** Clear a tombstone iff it is no longer needed: there is no in-flight
   *  write for the path AND no fresh enqueue is pending. Called by the
   *  flush loop and fireImmediate after their requeue decisions are made. */
  function maybeClearTombstone(path: string): void {
    if (!tombstones.has(path)) return;
    if (inFlightByPath.has(path)) return;
    if (pending.has(path)) return;
    tombstones.delete(path);
  }

  async function flushAll(): Promise<void> {
    if (pending.size === 0) return;
    const entries = [...pending.entries()];
    pending.clear();
    const results = await Promise.allSettled(
      entries.map(([path, e]) => trackedWrite(path, e.data)),
    );
    // Requeue failures that have retry budget left, but only if no newer
    // write for the same path has arrived during the flush — last-writer
    // wins because the newer entry already replaced the failed value
    // semantically.
    for (let i = 0; i < entries.length; i++) {
      const result = results[i];
      const entry = entries[i];
      if (result === undefined || entry === undefined) continue;
      const [path, e] = entry;
      if (result.status === "fulfilled") {
        maybeClearTombstone(path);
        continue;
      }
      if (pending.has(path)) {
        // Newer write supersedes — drop the stale failed value (still
        // surface the error so callers can react).
        reportError(result.reason, path, e.retries);
        maybeClearTombstone(path);
        continue;
      }
      if (tombstones.has(path)) {
        // delete() cancelled this path while the write was in flight; do
        // not requeue or the deleted record will be resurrected.
        reportError(result.reason, path, e.retries);
        maybeClearTombstone(path);
        continue;
      }
      const nextRetries = e.retries + 1;
      if (nextRetries > DEFAULT_MAX_RETRIES) {
        reportError(result.reason, path, e.retries);
        maybeClearTombstone(path);
        continue;
      }
      pending.set(path, { data: e.data, retries: nextRetries });
      startTimer();
    }
  }

  function startFlush(): Promise<void> {
    if (inFlight !== undefined) return inFlight;
    inFlight = flushAll().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  function startTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void startFlush();
    }, config.flushIntervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  async function fireImmediate(path: string, data: string): Promise<void> {
    try {
      await trackedWrite(path, data);
      maybeClearTombstone(path);
    } catch (err: unknown) {
      // Convert immediate-write failure into a queued retry so the write
      // is not lost on a transient Nexus blip. Only requeue if no fresher
      // value for the same path has been queued in the meantime, and no
      // delete() has tombstoned the path while the write was in flight.
      if (tombstones.has(path)) {
        reportError(err, path, 0);
        maybeClearTombstone(path);
        return;
      }
      if (!pending.has(path)) {
        pending.set(path, { data, retries: 1 });
        startTimer();
      } else {
        reportError(err, path, 0);
      }
    }
  }

  return {
    enqueue(path: string, data: string, immediate?: boolean): void {
      // Any new write clears the tombstone — the caller has explicitly
      // re-asserted that this path should hold a value.
      tombstones.delete(path);
      if (immediate === true) {
        pending.delete(path);
        // Track the immediate-write promise so dispose() can drain it.
        const p = fireImmediate(path, data);
        immediatePromises.add(p);
        void p.finally(() => immediatePromises.delete(p));
        return;
      }
      if (pending.size >= config.maxQueueSize && !pending.has(path)) {
        const firstKey = pending.keys().next().value;
        if (firstKey !== undefined) pending.delete(firstKey);
      }
      pending.set(path, { data, retries: 0 });
      startTimer();
    },
    cancel(path: string): void {
      pending.delete(path);
      // Only tombstone if there is an in-flight write that could resurrect
      // the value after delete(). Without an in-flight write the tombstone
      // serves no purpose and would never be cleared.
      if (inFlightByPath.has(path)) tombstones.add(path);
    },
    async drainPath(path: string): Promise<void> {
      // Drain in a loop because settling one in-flight write can spawn
      // another for the same path (e.g., flushAll picks up a queued write
      // for a path that already had an immediate write in flight). Loop
      // until the path's in-flight Set is genuinely empty so delete()
      // never proceeds while a same-path write is still landing — silently
      // capping iterations would let a stale write resurrect the record.
      // Convergence relies on producers eventually stopping; the typical
      // case is 1 immediate write + 0-1 retry, so 1-2 iterations.
      while (true) {
        const set = inFlightByPath.get(path);
        if (set === undefined || set.size === 0) return;
        // Snapshot — new writes added after this point are picked up by the
        // next loop iteration.
        const snapshot = [...set];
        await Promise.allSettled(snapshot.map((p) => p.catch(() => {})));
      }
    },
    async flush(): Promise<void> {
      if (inFlight !== undefined) await inFlight.catch(() => {});
      await startFlush();
    },
    async dispose(): Promise<void> {
      stopTimer();
      // Drain any in-flight immediate writes before final flush so a stack
      // shutdown does not return before the initial HA session record has
      // actually reached Nexus.
      if (immediatePromises.size > 0) {
        await Promise.allSettled([...immediatePromises]);
      }
      if (inFlight !== undefined) await inFlight.catch(() => {});
      await startFlush();
      // After final flush, drain any immediate writes that were spawned
      // mid-flush (rare, but possible if onError triggered re-enqueues).
      if (immediatePromises.size > 0) {
        await Promise.allSettled([...immediatePromises]);
      }
    },
    size(): number {
      return pending.size;
    },
  };
}
