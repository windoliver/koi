/**
 * Clock abstraction for testable time-dependent code.
 *
 * Production code uses createRealClock() which delegates to globalThis.
 * Tests use createFakeClock() which provides manual time advancement.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Handle for a scheduled timer that can be cleared. */
export interface TimerHandle {
  readonly clear: () => void;
}

/** Injectable clock interface for time-dependent operations. */
export interface Clock {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => TimerHandle;
  readonly setInterval: (fn: () => void, ms: number) => TimerHandle;
}

/** FakeClock extends Clock with test-only time control. */
export interface FakeClock extends Clock {
  readonly advance: (ms: number) => void;
  readonly pendingCount: () => number;
}

// ---------------------------------------------------------------------------
// Pending timer entry (internal)
// ---------------------------------------------------------------------------

interface PendingTimer {
  readonly fn: () => void;
  fireAt: number; // let-equivalent: mutated for interval rescheduling
  readonly intervalMs: number | undefined; // undefined = one-shot
  cancelled: boolean; // let-equivalent: mutable for cancellation
}

// ---------------------------------------------------------------------------
// Real clock
// ---------------------------------------------------------------------------

export function createRealClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const id = globalThis.setTimeout(fn, ms);
      return { clear: () => globalThis.clearTimeout(id) };
    },
    setInterval: (fn, ms) => {
      const id = globalThis.setInterval(fn, ms);
      return { clear: () => globalThis.clearInterval(id) };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake clock (deterministic, for tests)
// ---------------------------------------------------------------------------

export function createFakeClock(startTime = 0): FakeClock {
  let currentTime = startTime; // let: advanced by advance()
  const timers: PendingTimer[] = []; // let-equivalent: mutated for timer management

  function now(): number {
    return currentTime;
  }

  function addTimer(fn: () => void, ms: number, intervalMs: number | undefined): TimerHandle {
    const timer: PendingTimer = {
      fn,
      fireAt: currentTime + ms,
      intervalMs,
      cancelled: false,
    };
    timers.push(timer);
    return {
      clear: () => {
        timer.cancelled = true;
      },
    };
  }

  function advance(ms: number): void {
    const targetTime = currentTime + ms;

    // Process timers in chronological order until we reach targetTime
    // Use a loop since firing a timer may schedule new timers
    while (currentTime < targetTime) {
      // Find the next timer that should fire at or before targetTime
      let earliest: PendingTimer | undefined;
      let earliestIdx = -1;

      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t === undefined) continue;
        if (t.cancelled) continue;
        if (t.fireAt <= targetTime) {
          if (earliest === undefined || t.fireAt < earliest.fireAt) {
            earliest = t;
            earliestIdx = i;
          }
        }
      }

      if (earliest === undefined) {
        // No more timers to fire before targetTime
        currentTime = targetTime;
        break;
      }

      // Advance time to the timer's fire point
      currentTime = earliest.fireAt;

      if (earliest.intervalMs !== undefined) {
        // Reschedule interval timer for next firing
        earliest.fireAt = currentTime + earliest.intervalMs;
      } else {
        // Remove one-shot timer
        timers.splice(earliestIdx, 1);
      }

      earliest.fn();
    }

    // Clean up cancelled timers
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i]?.cancelled) {
        timers.splice(i, 1);
      }
    }
  }

  function pendingCount(): number {
    return timers.filter((t) => !t.cancelled).length;
  }

  return {
    now,
    setTimeout: (fn, ms) => addTimer(fn, ms, undefined),
    setInterval: (fn, ms) => addTimer(fn, ms, ms),
    advance,
    pendingCount,
  };
}
