/**
 * EventBatcher — coalesces high-frequency events into render-cadence batches.
 *
 * Used between the engine worker (postMessage source) and the TUI store
 * (dispatch sink). Events arriving within one JavaScript task are grouped
 * via queueMicrotask, then flushed via a single setTimeout window.
 *
 * Timer model:
 *   enqueue()  →  queueMicrotask  →  scheduleTimeout(flushIntervalMs)  →  onFlush(batch)
 *
 * The two-stage approach:
 *   - queueMicrotask: coalesces events arriving in the same synchronous burst
 *     (e.g. all events from one postMessage callback) before scheduling the timer
 *   - scheduleTimeout(16): rate-limits flushes to ≈60fps, matching OpenTUI's
 *     render cadence, so events arriving in distinct network ticks are coalesced
 *
 * Timer functions are injectable for testing (pass synchronous replacements
 * instead of relying on runtime fake-timer support).
 */

export interface EventBatcher<T> {
  /** Add an event to the pending batch. No-op after dispose(). */
  enqueue(event: T): void;
  /**
   * Flush any buffered events synchronously, bypassing the timer.
   * Use this before dispatching end-of-stream signals so buffered content
   * is applied to the store before connection state changes.
   * No-op after dispose() or when the buffer is empty.
   */
  flushSync(): void;
  /** Cancel all pending timers and drop the buffer. No flush is performed. */
  dispose(): void;
}

export interface EventBatcherOptions {
  /** Milliseconds between flushes. Default: 16 (≈60fps). */
  readonly flushIntervalMs?: number;
  /**
   * Injectable timeout scheduler (default: globalThis.setTimeout).
   * Pass a synchronous spy in tests to avoid real timer waits.
   */
  readonly scheduleTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injectable cancel function (default: globalThis.clearTimeout). */
  readonly cancelTimeout?: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * Create a new EventBatcher.
 *
 * @param onFlush  Called with the accumulated batch on each flush.
 *                 Errors thrown by onFlush propagate to the caller; the
 *                 batcher resets its buffer so subsequent batches still work.
 * @param options  Optional tuning (default interval: 16ms).
 */
export function createEventBatcher<T>(
  onFlush: (batch: readonly T[]) => void,
  options?: EventBatcherOptions,
): EventBatcher<T> {
  const flushIntervalMs = options?.flushIntervalMs ?? 16;
  const doSetTimeout = options?.scheduleTimeout ?? setTimeout;
  const doClearTimeout = options?.cancelTimeout ?? clearTimeout;

  // `let` justified: reassigned on each flush cycle and by dispose()
  let buffer: T[] = [];
  let microtaskPending = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function scheduleFlush(): void {
    if (flushTimer !== null) return; // already scheduled
    flushTimer = doSetTimeout(flush, flushIntervalMs);
  }

  function flush(): void {
    flushTimer = null;
    if (disposed || buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    onFlush(batch); // may throw — intentional: caller sees the error
  }

  return {
    enqueue(event: T): void {
      if (disposed) return;
      buffer.push(event);
      if (!microtaskPending) {
        microtaskPending = true;
        queueMicrotask(() => {
          microtaskPending = false;
          if (!disposed && buffer.length > 0) scheduleFlush();
        });
      }
    },

    flushSync(): void {
      if (disposed || buffer.length === 0) return;
      // Cancel the pending timer — we're flushing now
      if (flushTimer !== null) {
        doClearTimeout(flushTimer);
        flushTimer = null;
      }
      microtaskPending = false;
      const batch = buffer;
      buffer = [];
      onFlush(batch);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (flushTimer !== null) {
        doClearTimeout(flushTimer);
        flushTimer = null;
      }
      buffer = [];
      microtaskPending = false;
    },
  };
}
