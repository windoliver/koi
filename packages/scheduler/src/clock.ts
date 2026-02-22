/**
 * Clock abstraction for testable time-dependent code.
 *
 * SystemClock delegates to global functions (production).
 * FakeClock provides manual tick(ms) for deterministic tests.
 */

// ---------------------------------------------------------------------------
// Clock interface
// ---------------------------------------------------------------------------

export interface Clock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => number;
  readonly setInterval: (callback: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly clearInterval: (id: number) => void;
}

// ---------------------------------------------------------------------------
// FakeClock (for tests)
// ---------------------------------------------------------------------------

export interface FakeClock extends Clock {
  readonly tick: (ms: number) => void;
  readonly currentTime: () => number;
}

interface PendingTimer {
  readonly callback: () => void;
  readonly fireAt: number;
  readonly interval: number | undefined;
  readonly id: number;
}

export function createFakeClock(startTime: number = 0): FakeClock {
  let time = startTime; // let: advances on tick()
  let nextId = 1; // let: incremented on each timer creation
  let timers = new Map<number, PendingTimer>(); // let: replaced immutably

  function scheduleTimer(callback: () => void, ms: number, interval: number | undefined): number {
    const id = nextId;
    nextId += 1;
    const updated = new Map(timers);
    updated.set(id, { callback, fireAt: time + ms, interval, id });
    timers = updated;
    return id;
  }

  return {
    now: () => time,
    currentTime: () => time,

    setTimeout: (callback, ms) => scheduleTimer(callback, ms, undefined),

    setInterval: (callback, ms) => scheduleTimer(callback, ms, ms),

    clearTimeout: (id) => {
      const updated = new Map(timers);
      updated.delete(id);
      timers = updated;
    },

    clearInterval: (id) => {
      const updated = new Map(timers);
      updated.delete(id);
      timers = updated;
    },

    tick: (ms) => {
      const target = time + ms;
      // Process timers in order of fire time
      while (time < target) {
        // Find earliest timer that fires before target
        let earliest: PendingTimer | undefined;
        for (const t of timers.values()) {
          if (t.fireAt <= target && (earliest === undefined || t.fireAt < earliest.fireAt)) {
            earliest = t;
          }
        }

        if (earliest === undefined || earliest.fireAt > target) {
          time = target;
          break;
        }

        time = earliest.fireAt;
        const cb = earliest.callback;
        const interval = earliest.interval;
        const timerId = earliest.id;

        if (interval !== undefined) {
          // Reschedule interval timer
          const updated = new Map(timers);
          updated.set(timerId, { callback: cb, fireAt: time + interval, interval, id: timerId });
          timers = updated;
        } else {
          // Remove one-shot timer
          const updated = new Map(timers);
          updated.delete(timerId);
          timers = updated;
        }

        cb();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SystemClock (production)
// ---------------------------------------------------------------------------

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    setInterval: (cb, ms) => setInterval(cb, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id),
    clearInterval: (id) => clearInterval(id),
  };
}
