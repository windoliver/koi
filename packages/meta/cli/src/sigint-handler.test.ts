/**
 * SIGINT double-tap state machine — unit tests.
 *
 * Covers the graceful-then-force protocol used by both `koi start` and the TUI
 * host. The state machine is a pure factory with injected timers and
 * callbacks, so these tests don't touch `process.on` or the real clock.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createSigintHandler, type SigintHandler, type Timer } from "./sigint-handler.js";

// ---------------------------------------------------------------------------
// Fake timer harness — lets tests advance virtual time without waiting.
// ---------------------------------------------------------------------------

interface FakeTimer extends Timer {
  readonly fireAfterMs: number;
  fired: boolean;
  cancelled: boolean;
}

function createFakeClock(): {
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly advance: (ms: number) => void;
  readonly now: () => number;
  readonly pending: () => readonly FakeTimer[];
} {
  let current = 0;
  const timers: {
    readonly at: number;
    readonly fn: () => void;
    readonly timer: FakeTimer;
  }[] = [];

  const setTimer = (fn: () => void, ms: number): Timer => {
    const timer: FakeTimer = {
      fireAfterMs: ms,
      fired: false,
      cancelled: false,
      cancel: () => {
        timer.cancelled = true;
      },
    };
    timers.push({ at: current + ms, fn, timer });
    return timer;
  };

  const advance = (ms: number): void => {
    const target = current + ms;
    // Fire in scheduled order. Strictly-less-than: a timer scheduled at t
    // fires when the clock moves PAST t, matching the semantic that a user
    // tap at exactly the window boundary beats the timer.
    timers.sort((a, b) => a.at - b.at);
    for (const entry of timers) {
      if (entry.at < target && !entry.timer.fired && !entry.timer.cancelled) {
        entry.timer.fired = true;
        entry.fn();
      }
    }
    current = target;
  };

  const pending = (): readonly FakeTimer[] =>
    timers.filter((t) => !t.timer.fired && !t.timer.cancelled).map((t) => t.timer);

  return { setTimer, advance, now: () => current, pending };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSigintHandler", () => {
  let onGraceful: ReturnType<typeof mock>;
  let onForce: ReturnType<typeof mock>;
  let write: ReturnType<typeof mock>;
  let clock: ReturnType<typeof createFakeClock>;
  let handler: SigintHandler;

  beforeEach(() => {
    onGraceful = mock(() => {});
    onForce = mock(() => {});
    write = mock((_msg: string) => {});
    clock = createFakeClock();
    handler = createSigintHandler({
      onGraceful: () => {
        onGraceful();
      },
      onForce: () => {
        onForce();
      },
      write: (msg: string) => {
        write(msg);
      },
      doubleTapWindowMs: 2000,
      failsafeMs: 8000,
      coalesceWindowMs: 0,
      setTimer: clock.setTimer,
      now: clock.now,
    });
  });

  test("first signal calls onGraceful and prints hint", () => {
    handler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForce).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const msg = write.mock.calls[0]?.[0] as string;
    expect(msg).toContain("Interrupting");
    expect(msg).toContain("Ctrl+C again to force");
  });

  test("second signal within window calls onForce and not onGraceful again", () => {
    handler.handleSignal();
    clock.advance(500);
    handler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  test("second signal exactly at window boundary still forces", () => {
    handler.handleSignal();
    clock.advance(2000);
    handler.handleSignal();
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  test("second signal after the double-tap window still forces", () => {
    // Once the interrupt sequence has started, subsequent taps always
    // force — they are the escape hatch, not a request to re-enter the
    // graceful path. Only `complete()` returns the handler to idle.
    handler.handleSignal();
    clock.advance(2500);
    handler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  test("failsafe timer fires onForce if graceful abort hangs", () => {
    handler.handleSignal();
    clock.advance(8001);
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  test("failsafe does not fire after dispose", () => {
    handler.handleSignal();
    handler.dispose();
    clock.advance(10_000);
    expect(onForce).not.toHaveBeenCalled();
  });

  test("dispose cancels all pending timers", () => {
    handler.handleSignal();
    expect(clock.pending().length).toBeGreaterThan(0);
    handler.dispose();
    expect(clock.pending().length).toBe(0);
  });

  test("taps after force keep calling onForce so callers can escalate", () => {
    handler.handleSignal(); // graceful
    handler.handleSignal(); // force
    handler.handleSignal(); // escalate
    handler.handleSignal(); // escalate
    expect(onGraceful).toHaveBeenCalledTimes(1);
    // Every tap after the first one hits onForce — first to request
    // cooperative shutdown, subsequent ones as the user's "get out NOW" path.
    expect(onForce).toHaveBeenCalledTimes(3);
  });

  test("dispose is safe to call before any signal", () => {
    expect(() => {
      handler.dispose();
    }).not.toThrow();
  });

  test("dispose is safe to call multiple times", () => {
    handler.handleSignal();
    handler.dispose();
    expect(() => {
      handler.dispose();
    }).not.toThrow();
  });

  test("without failsafeMs, only double-tap timer is armed", () => {
    const noFailsafeHandler = createSigintHandler({
      onGraceful: () => {
        onGraceful();
      },
      onForce: () => {
        onForce();
      },
      write: (msg: string) => {
        write(msg);
      },
      doubleTapWindowMs: 2000,
      // failsafeMs omitted
      coalesceWindowMs: 0,
      setTimer: clock.setTimer,
      now: clock.now,
    });
    noFailsafeHandler.handleSignal();
    expect(clock.pending().length).toBe(1);
    clock.advance(60_000);
    expect(onForce).not.toHaveBeenCalled();
  });

  test("complete() clears coalesce state so the next run's first tap is honored", () => {
    const coalescingHandler = createSigintHandler({
      onGraceful: () => {
        onGraceful();
      },
      onForce: () => {
        onForce();
      },
      write: (msg: string) => {
        write(msg);
      },
      doubleTapWindowMs: 2000,
      failsafeMs: 8000,
      coalesceWindowMs: 150,
      setTimer: clock.setTimer,
      now: clock.now,
    });
    // First run: graceful tap, then complete() after the run settles.
    coalescingHandler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(1);
    clock.advance(50); // still inside the original 150ms coalesce window
    coalescingHandler.complete();
    // Second run: a tap 50ms after complete — still inside what WOULD
    // have been the old coalesce window — must be treated as a new first
    // tap, not swallowed as a duplicate.
    clock.advance(50);
    coalescingHandler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(2);
    expect(onForce).not.toHaveBeenCalled();
  });

  test("complete() returns handler to idle so a later tap is a new first tap", () => {
    handler.handleSignal();
    handler.complete();
    // Within the original 2s window, but since we completed, this is a new tap.
    clock.advance(500);
    handler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(2);
    expect(onForce).not.toHaveBeenCalled();
  });

  test("complete() while idle is a no-op", () => {
    expect(() => {
      handler.complete();
    }).not.toThrow();
    handler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(1);
  });

  test("complete() cancels pending timers", () => {
    handler.handleSignal();
    expect(clock.pending().length).toBeGreaterThan(0);
    handler.complete();
    expect(clock.pending().length).toBe(0);
  });

  test("complete() after force leaves forced state in place", () => {
    handler.handleSignal();
    handler.handleSignal(); // force
    handler.complete();
    // Forced state is terminal for graceful — any later tap re-invokes
    // onForce (the escape-hatch escalation path), not onGraceful.
    handler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForce).toHaveBeenCalledTimes(2);
  });

  test("onWindowElapse='reset-to-idle' treats post-window tap as fresh first tap", () => {
    const resetHandler = createSigintHandler({
      onGraceful: () => {
        onGraceful();
      },
      onForce: () => {
        onForce();
      },
      write: (msg: string) => {
        write(msg);
      },
      doubleTapWindowMs: 2000,
      coalesceWindowMs: 0,
      onWindowElapse: "reset-to-idle",
      setTimer: clock.setTimer,
      now: clock.now,
    });
    resetHandler.handleSignal();
    clock.advance(2500); // past the window
    resetHandler.handleSignal();
    // Second tap is a fresh first tap, not a force escape.
    expect(onGraceful).toHaveBeenCalledTimes(2);
    expect(onForce).not.toHaveBeenCalled();
  });

  test("onWindowElapse='reset-to-idle' still forces on double-tap within window", () => {
    const resetHandler = createSigintHandler({
      onGraceful: () => {
        onGraceful();
      },
      onForce: () => {
        onForce();
      },
      write: (msg: string) => {
        write(msg);
      },
      doubleTapWindowMs: 2000,
      coalesceWindowMs: 0,
      onWindowElapse: "reset-to-idle",
      setTimer: clock.setTimer,
      now: clock.now,
    });
    resetHandler.handleSignal();
    clock.advance(500);
    resetHandler.handleSignal();
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  test("signals within coalesce window are treated as one tap", () => {
    const coalescingHandler = createSigintHandler({
      onGraceful: () => {
        onGraceful();
      },
      onForce: () => {
        onForce();
      },
      write: (msg: string) => {
        write(msg);
      },
      doubleTapWindowMs: 2000,
      failsafeMs: 8000,
      coalesceWindowMs: 50,
      setTimer: clock.setTimer,
      now: clock.now,
    });
    // Two signals at the same virtual instant — second is coalesced.
    coalescingHandler.handleSignal();
    coalescingHandler.handleSignal();
    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForce).not.toHaveBeenCalled();
  });

  test("signals after coalesce window are not coalesced", () => {
    const coalescingHandler = createSigintHandler({
      onGraceful: () => {
        onGraceful();
      },
      onForce: () => {
        onForce();
      },
      write: (msg: string) => {
        write(msg);
      },
      doubleTapWindowMs: 2000,
      failsafeMs: 8000,
      coalesceWindowMs: 50,
      setTimer: clock.setTimer,
      now: clock.now,
    });
    coalescingHandler.handleSignal();
    clock.advance(100); // past the 50ms coalesce window
    coalescingHandler.handleSignal();
    // Second tap is a real second tap → force.
    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForce).toHaveBeenCalledTimes(1);
  });

  test("onGraceful throwing does not prevent onForce on second tap", () => {
    const throwingHandler = createSigintHandler({
      onGraceful: () => {
        throw new Error("abort failed");
      },
      onForce: () => {
        onForce();
      },
      write: (msg: string) => {
        write(msg);
      },
      doubleTapWindowMs: 2000,
      failsafeMs: 8000,
      coalesceWindowMs: 0,
      setTimer: clock.setTimer,
      now: clock.now,
    });
    expect(() => {
      throwingHandler.handleSignal();
    }).toThrow("abort failed");
    // State should still have advanced so a second tap forces.
    throwingHandler.handleSignal();
    expect(onForce).toHaveBeenCalledTimes(1);
  });
});
