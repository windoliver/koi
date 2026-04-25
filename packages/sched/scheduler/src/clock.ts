export interface Clock {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => void;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export interface FakeClock extends Clock {
  readonly tick: (ms: number) => void;
  readonly setTime: (ms: number) => void;
}

export function createFakeClock(initialTime = 0): FakeClock {
  let current = initialTime;
  type TimerEntry = { readonly fireAt: number; readonly fn: () => void; id: number };
  const timers: TimerEntry[] = [];
  let nextId = 1;

  function fireElapsed(): void {
    let continueLoop = true;
    while (continueLoop) {
      timers.sort((a, b) => a.fireAt - b.fireAt);
      continueLoop = false;
      while (timers.length > 0 && (timers[0] as TimerEntry).fireAt <= current) {
        const entry = timers.shift() as TimerEntry;
        entry.fn();
        continueLoop = true;
      }
    }
  }

  return {
    now: () => current,
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++;
      timers.push({ fireAt: current + ms, fn, id });
      // FakeClock uses integer IDs internally; the platform handle type is opaque,
      // so a double-cast is required to satisfy the Clock interface signature.
      const handle = id as unknown as ReturnType<typeof globalThis.setTimeout>;
      // Fire zero-delay timers immediately so callers can use setTimeout(fn, 0)
      // as a microtask-yield pattern in tests without an extra tick() call.
      if (ms === 0) fireElapsed();
      return handle;
    },
    clearTimeout(id) {
      // Reverse the double-cast from setTimeout above.
      const numId = id as unknown as number;
      const idx = timers.findIndex((t) => t.id === numId);
      if (idx !== -1) timers.splice(idx, 1);
    },
    tick(ms: number): void {
      const end = current + ms;
      while (current < end) {
        if (timers.length === 0) {
          current = end;
          break;
        }
        timers.sort((a, b) => a.fireAt - b.fireAt);
        const nextFire = (timers[0] as TimerEntry).fireAt;
        if (nextFire > end) {
          current = end;
          break;
        }
        current = nextFire;
        fireElapsed();
      }
    },
    setTime(ms: number): void {
      current = ms;
      fireElapsed();
    },
  };
}
