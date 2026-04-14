/**
 * EventBatcher tests — deterministic via injected timer functions.
 *
 * Instead of fake-timer libraries (not available in Bun 1.3.x), we inject
 * synchronous timer stubs that give us direct control over when flushes fire.
 */

import { describe, expect, mock, test } from "bun:test";
import { createEventBatcher, type TimerHandle } from "./event-batcher.js";

// ---------------------------------------------------------------------------
// Timer stub helpers
// ---------------------------------------------------------------------------

/** A minimal synchronous timer stub: capture the callback, call flush() manually. */
function makeTimerStub() {
  let pending: (() => void) | null = null;
  let cancelled = false;

  const schedule = mock((_fn: () => void, _ms: number): TimerHandle => {
    pending = _fn;
    cancelled = false;
    return 0;
  });
  const cancel = mock((_id: TimerHandle): void => {
    cancelled = true;
    pending = null;
  });

  return {
    schedule,
    cancel,
    /** Fire the pending timeout (simulates the interval elapsing). */
    tick(): void {
      if (pending && !cancelled) {
        const fn = pending;
        pending = null;
        fn();
      }
    },
    get hasPending(): boolean {
      return pending !== null && !cancelled;
    },
  };
}

// ---------------------------------------------------------------------------
// Basic flush behaviour
// ---------------------------------------------------------------------------

describe("EventBatcher — basic flush", () => {
  test("does not flush when queue is empty", async () => {
    const timer = makeTimerStub();
    const onFlush = mock((_b: readonly string[]) => {});
    const batcher = createEventBatcher(onFlush, {
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    await Promise.resolve(); // drain microtasks
    timer.tick();

    expect(onFlush).not.toHaveBeenCalled();
    batcher.dispose();
  });

  test("flushes a single event after the interval", async () => {
    const timer = makeTimerStub();
    const onFlush = mock((_b: readonly string[]) => {});
    const batcher = createEventBatcher(onFlush, {
      flushIntervalMs: 16,
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    batcher.enqueue("a");
    await Promise.resolve(); // drain microtask → schedules timeout

    expect(timer.hasPending).toBe(true);
    timer.tick();

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]?.[0]).toEqual(["a"]);
    batcher.dispose();
  });

  test("coalesces a same-tick burst into one batch", async () => {
    const timer = makeTimerStub();
    const onFlush = mock((_b: readonly string[]) => {});
    const batcher = createEventBatcher(onFlush, {
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    // Five enqueues in the same synchronous tick — only one microtask scheduled
    batcher.enqueue("a");
    batcher.enqueue("b");
    batcher.enqueue("c");
    batcher.enqueue("d");
    batcher.enqueue("e");

    await Promise.resolve();
    timer.tick();

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush.mock.calls[0]?.[0]).toEqual(["a", "b", "c", "d", "e"]);
    batcher.dispose();
  });

  test("flushes two separate bursts as two batches", async () => {
    const timer = makeTimerStub();
    const flushed: (readonly string[])[] = [];
    const batcher = createEventBatcher<string>((b) => flushed.push(b), {
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    // First burst
    batcher.enqueue("x");
    await Promise.resolve();
    timer.tick();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(["x"]);

    // Second burst
    batcher.enqueue("y");
    batcher.enqueue("z");
    await Promise.resolve();
    timer.tick();

    expect(flushed).toHaveLength(2);
    expect(flushed[1]).toEqual(["y", "z"]);
    batcher.dispose();
  });

  test("does not schedule a second timer if one is already pending", async () => {
    const timer = makeTimerStub();
    const onFlush = mock((_b: readonly string[]) => {});
    const batcher = createEventBatcher(onFlush, {
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    batcher.enqueue("a");
    await Promise.resolve(); // schedules timer

    // Enqueue another event before the timer fires (new microtask)
    batcher.enqueue("b");
    await Promise.resolve(); // microtask runs — timer already scheduled, no new one

    expect(timer.schedule).toHaveBeenCalledTimes(1); // only one timer created
    timer.tick();
    expect(onFlush.mock.calls[0]?.[0]).toEqual(["a", "b"]); // both in one batch
    batcher.dispose();
  });
});

// ---------------------------------------------------------------------------
// dispose() behaviour
// ---------------------------------------------------------------------------

describe("EventBatcher — dispose", () => {
  test("dispose() before flush prevents onFlush from being called", async () => {
    const timer = makeTimerStub();
    const onFlush = mock((_b: readonly string[]) => {});
    const batcher = createEventBatcher(onFlush, {
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    batcher.enqueue("to-be-dropped");
    await Promise.resolve(); // schedules timer

    batcher.dispose(); // cancels timer + clears buffer
    timer.tick(); // fires nothing (cancelled)

    expect(onFlush).not.toHaveBeenCalled();
    expect(timer.cancel).toHaveBeenCalledTimes(1);
  });

  test("enqueue() after dispose() is a no-op — no crash, no flush", async () => {
    const timer = makeTimerStub();
    const onFlush = mock((_b: readonly string[]) => {});
    const batcher = createEventBatcher(onFlush, {
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    batcher.dispose();
    batcher.enqueue("after-dispose");
    await Promise.resolve();
    timer.tick();

    expect(onFlush).not.toHaveBeenCalled();
    expect(timer.schedule).not.toHaveBeenCalled();
  });

  test("dispose() is idempotent — calling twice does not throw", () => {
    const batcher = createEventBatcher((_b: readonly string[]) => {});
    batcher.dispose();
    expect(() => batcher.dispose()).not.toThrow();
  });

  test("isDisposed reflects dispose() state — #1742", () => {
    // An external producer (e.g. an in-flight stream drain passed this
    // batcher by reference) must be able to detect tear-down. Without this
    // probe, its enqueue()/flushSync() calls silently vanish after a
    // resetConversation(), leaving the UI with a truncated or missing reply.
    const batcher = createEventBatcher((_b: readonly string[]) => {});
    expect(batcher.isDisposed).toBe(false);
    batcher.dispose();
    expect(batcher.isDisposed).toBe(true);
    batcher.dispose(); // idempotent
    expect(batcher.isDisposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("EventBatcher — error resilience", () => {
  test("error in onFlush does not prevent subsequent batches", async () => {
    let callCount = 0;
    // Two separate timers needed — one per burst
    const timers: Array<ReturnType<typeof makeTimerStub>> = [];
    let timerIdx = 0;
    const schedule = (_fn: () => void, _ms: number): TimerHandle => {
      if (timerIdx >= timers.length) timers.push(makeTimerStub());
      // biome-ignore lint/style/noNonNullAssertion: timer pushed on line above when timerIdx >= timers.length
      const t = timers[timerIdx++]!;
      t.schedule(_fn, _ms);
      return 0;
    };

    const batcher = createEventBatcher<string>(
      (_batch) => {
        callCount++;
        if (callCount === 1) throw new Error("flush error");
      },
      { scheduleTimeout: schedule, cancelTimeout: () => {} },
    );

    // First burst — onFlush throws
    batcher.enqueue("a");
    await Promise.resolve();
    expect(() => timers[0]?.tick()).toThrow("flush error");
    expect(callCount).toBe(1);

    // Second burst — should still work
    timerIdx = 0; // reset index for next schedule call
    timers.length = 0;
    batcher.enqueue("b");
    await Promise.resolve();
    timers[0]?.tick();
    expect(callCount).toBe(2);

    batcher.dispose();
  });
});

// ---------------------------------------------------------------------------
// flushSync()
// ---------------------------------------------------------------------------

describe("EventBatcher — flushSync", () => {
  test("flushes buffer synchronously before timer fires", async () => {
    const timer = makeTimerStub();
    const flushed: (readonly string[])[] = [];
    const batcher = createEventBatcher<string>((b) => flushed.push(b), {
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    batcher.enqueue("a");
    batcher.enqueue("b");
    await Promise.resolve(); // schedules timer

    // Flush synchronously before timer fires
    batcher.flushSync();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual(["a", "b"]);
    // Timer should have been cancelled
    expect(timer.cancel).toHaveBeenCalledTimes(1);
    expect(timer.hasPending).toBe(false);
    batcher.dispose();
  });

  test("flushSync cancels pending timer to avoid double-flush", async () => {
    const timer = makeTimerStub();
    let flushCount = 0;
    const batcher = createEventBatcher<string>(
      () => {
        flushCount++;
      },
      {
        scheduleTimeout: timer.schedule,
        cancelTimeout: timer.cancel,
      },
    );

    batcher.enqueue("x");
    await Promise.resolve();
    batcher.flushSync(); // flushes now, cancels timer
    timer.tick(); // would have fired — but timer was cancelled

    expect(flushCount).toBe(1); // only one flush
    batcher.dispose();
  });

  test("flushSync is a no-op on empty buffer", () => {
    const onFlush = mock((_b: readonly string[]) => {});
    const batcher = createEventBatcher(onFlush);
    batcher.flushSync();
    expect(onFlush).not.toHaveBeenCalled();
    batcher.dispose();
  });

  test("flushSync is a no-op after dispose()", () => {
    const onFlush = mock((_b: readonly string[]) => {});
    const batcher = createEventBatcher(onFlush);
    batcher.enqueue("x");
    batcher.dispose();
    batcher.flushSync();
    expect(onFlush).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Default interval
// ---------------------------------------------------------------------------

describe("EventBatcher — defaults", () => {
  test("scheduleTimeout is called with 16 by default", async () => {
    const timer = makeTimerStub();
    const batcher = createEventBatcher<number>((_b) => {}, {
      scheduleTimeout: timer.schedule,
      cancelTimeout: timer.cancel,
    });

    batcher.enqueue(1);
    await Promise.resolve();

    expect(timer.schedule).toHaveBeenCalledWith(expect.any(Function), 16);
    batcher.dispose();
  });
});
