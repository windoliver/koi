import { describe, expect, test } from "bun:test";
import type { Timer } from "./sigint-handler.js";
import {
  createTuiSigintHandler,
  decideTuiGracefulAction,
  TUI_BG_EXIT_HINT,
} from "./tui-graceful-sigint.js";

describe("decideTuiGracefulAction", () => {
  test("active foreground stream → abort-active-stream (regardless of background)", () => {
    expect(
      decideTuiGracefulAction({
        hasActiveForegroundStream: true,
        hasActiveBackgroundTasks: false,
      }).kind,
    ).toBe("abort-active-stream");

    expect(
      decideTuiGracefulAction({
        hasActiveForegroundStream: true,
        hasActiveBackgroundTasks: true,
      }).kind,
    ).toBe("abort-active-stream");
  });

  test("idle foreground + live background → wait-for-bg-exit-tap (#1772 fix)", () => {
    // This is the regression target: previously, first Ctrl+C at idle
    // foreground ALWAYS triggered full shutdown — even when background
    // subprocesses were still running — tearing down the TUI on one tap.
    const result = decideTuiGracefulAction({
      hasActiveForegroundStream: false,
      hasActiveBackgroundTasks: true,
    });
    expect(result.kind).toBe("wait-for-bg-exit-tap");
    if (result.kind === "wait-for-bg-exit-tap") {
      expect(result.hint).toBe(TUI_BG_EXIT_HINT);
      expect(result.hint).toMatch(/Ctrl\+C again/);
    }
  });

  test("idle foreground + no background → shutdown (existing behavior preserved)", () => {
    // First Ctrl+C at an idle, empty TUI continues to quit immediately.
    // This is the conventional single-SIGINT-at-idle termination path.
    expect(
      decideTuiGracefulAction({
        hasActiveForegroundStream: false,
        hasActiveBackgroundTasks: false,
      }).kind,
    ).toBe("shutdown");
  });

  test("hint text names Ctrl+C specifically so the user knows what to press", () => {
    // Regression guard: the hint must stay actionable. If someone generalises
    // it to "press again" the user has no indication of which key.
    expect(TUI_BG_EXIT_HINT).toContain("Ctrl+C");
  });
});

// ---------------------------------------------------------------------------
// createTuiSigintHandler — integration with the SIGINT state machine
// ---------------------------------------------------------------------------

/**
 * Deterministic test harness: a fake timer factory that records pending
 * fires and can be advanced manually. Same pattern as sigint-handler.test.ts.
 */
interface FakeTimers {
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly advance: (ms: number) => void;
  readonly pending: () => number;
}

function createFakeTimers(): FakeTimers {
  // let: justified — monotonic clock for ordering pending timers
  let clock = 0;
  interface Pending {
    readonly fireAt: number;
    readonly fn: () => void;
    cancelled: boolean;
  }
  const pending: Pending[] = [];

  const setTimer = (fn: () => void, ms: number): Timer => {
    const entry: Pending = { fireAt: clock + ms, fn, cancelled: false };
    pending.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };

  const advance = (ms: number): void => {
    clock += ms;
    // Fire pending timers in fireAt order. Nested timer scheduling is
    // supported because we re-scan after each fire, and any newly added
    // entries whose fireAt is already <= clock will be picked up on the
    // next iteration.
    for (;;) {
      const due = pending
        .filter((p) => !p.cancelled && p.fireAt <= clock)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (due === undefined) return;
      due.cancelled = true;
      due.fn();
    }
  };

  const pendingCount = (): number => pending.filter((p) => !p.cancelled).length;

  return { setTimer, advance, pending: pendingCount };
}

interface HarnessState {
  hasForeground: boolean;
  hasBackground: boolean;
  abortCount: number;
  shutdownCount: number;
  forceCount: number;
  writes: string[];
}

function makeHarness(initial?: Partial<HarnessState>): {
  readonly state: HarnessState;
  readonly timers: FakeTimers;
  readonly handler: ReturnType<typeof createTuiSigintHandler>;
} {
  const state: HarnessState = {
    hasForeground: false,
    hasBackground: false,
    abortCount: 0,
    shutdownCount: 0,
    forceCount: 0,
    writes: [],
    ...initial,
  };
  const timers = createFakeTimers();
  const handler = createTuiSigintHandler({
    hasActiveForegroundStream: () => state.hasForeground,
    hasActiveBackgroundTasks: () => state.hasBackground,
    abortActiveStream: () => {
      state.abortCount += 1;
    },
    onShutdown: () => {
      state.shutdownCount += 1;
    },
    onForce: () => {
      state.forceCount += 1;
    },
    write: (msg) => {
      state.writes.push(msg);
    },
    setTimer: timers.setTimer,
    doubleTapWindowMs: 2000,
    coalesceWindowMs: 0,
  });
  return { state, timers, handler };
}

describe("createTuiSigintHandler — active foreground", () => {
  test("first Ctrl+C aborts stream; second within window forces", () => {
    const { state, handler, timers } = makeHarness({ hasForeground: true });
    handler.handleSignal();
    expect(state.abortCount).toBe(1);
    expect(state.shutdownCount).toBe(0);
    expect(state.forceCount).toBe(0);

    // Second tap inside the 2s window → force
    timers.advance(500);
    handler.handleSignal();
    expect(state.forceCount).toBe(1);
  });
});

describe("createTuiSigintHandler — idle foreground + no background", () => {
  test("first Ctrl+C calls onShutdown immediately", () => {
    const { state, handler } = makeHarness();
    handler.handleSignal();
    expect(state.shutdownCount).toBe(1);
    expect(state.abortCount).toBe(0);
    expect(state.forceCount).toBe(0);
  });
});

describe("createTuiSigintHandler — idle foreground + live background (#1772)", () => {
  test("first Ctrl+C prints the bg hint and does NOT shut down", () => {
    const { state, handler } = makeHarness({ hasBackground: true });
    handler.handleSignal();
    expect(state.writes.join("")).toContain("Background tasks still running");
    expect(state.shutdownCount).toBe(0);
    expect(state.forceCount).toBe(0);
    expect(state.abortCount).toBe(0);
  });

  test("second Ctrl+C within the double-tap window forces shutdown", () => {
    const { state, handler, timers } = makeHarness({ hasBackground: true });
    handler.handleSignal();
    timers.advance(500);
    handler.handleSignal();
    expect(state.forceCount).toBe(1);
  });

  test("after the double-tap window, a later Ctrl+C is a FRESH first tap (regression guard for adversarial-review round 1)", () => {
    // The original #1772 patch left the state machine armed indefinitely
    // because `stay-armed` is the default onWindowElapse AND the bg-wait
    // branch has no complete() hook. A later fresh Ctrl+C during a new
    // foreground turn was then treated as the second tap and force-exited
    // the TUI — discarding the turn the user intended to cancel.
    //
    // This test locks the fix in: after the 2s window elapses, the
    // handler self-disarms via the scheduled complete() call.
    const { state, handler, timers } = makeHarness({ hasBackground: true });

    // First tap while idle with background task running.
    handler.handleSignal();
    expect(state.writes.join("")).toContain("Background tasks still running");
    expect(state.forceCount).toBe(0);

    // Wait past the double-tap window. The self-disarm timer should have
    // fired and returned the state machine to idle.
    timers.advance(2100);

    // Simulate: background task finished, then a new foreground turn
    // started. Press Ctrl+C to cancel that turn.
    state.hasBackground = false;
    state.hasForeground = true;

    handler.handleSignal();

    // MUST be treated as a fresh first tap — abort the active stream,
    // NOT force-exit the TUI.
    expect(state.abortCount).toBe(1);
    expect(state.forceCount).toBe(0);
    expect(state.shutdownCount).toBe(0);
  });

  test("new foreground turn INSIDE the double-tap window disarms the bg-wait state — host must call complete() at turn start (#1772 review r2)", () => {
    // Adversarial-review round 2 caught that the disarm timer leaves
    // a 2s window where the bg-wait armed state persists. If the user
    // submits a new prompt *within* that window, the new turn is not
    // yet past the disarm deadline — so a Ctrl+C to cancel the fresh
    // turn is treated as the second tap of the stale bg-wait sequence
    // and force-exits the TUI, destroying the active turn.
    //
    // The host (tui-command.ts) closes the gap by calling
    // `handler.complete()` at every turn start. This test simulates
    // that host behavior and locks in that the Ctrl+C then aborts the
    // foreground stream instead of forcing.
    const { state, handler, timers } = makeHarness({ hasBackground: true });

    // 1. First tap: idle foreground, live background → hint + armed.
    handler.handleSignal();
    expect(state.writes.join("")).toContain("Background tasks still running");
    expect(state.forceCount).toBe(0);

    // 2. The user submits a new prompt 500ms later (well inside the 2s
    //    double-tap window). The host invokes complete() at turn start
    //    to clear any stale bg-wait arm, then a new foreground run
    //    begins.
    timers.advance(500);
    handler.complete();
    state.hasForeground = true;

    // 3. User presses Ctrl+C to cancel the fresh turn.
    handler.handleSignal();

    // 4. MUST abort the stream, NOT force-exit.
    expect(state.abortCount).toBe(1);
    expect(state.forceCount).toBe(0);
    expect(state.shutdownCount).toBe(0);
  });

  test("stale bg-wait disarm timer cannot clobber a later turn's armed state (#1772 review r3)", () => {
    // Adversarial-review round 3 caught that the round-2 self-disarm
    // timer was fire-and-forget — never cancelled when the host called
    // `complete()` at turn start or when a later SIGINT took a
    // different branch. The stale timer would then fire mid-way
    // through a later turn's double-tap window, silently collapsing
    // the armed state back to idle and breaking the force-exit path.
    //
    // Repro:
    //   t=0     idle+bg → Ctrl+C → hint + armed + disarm timer for t=2
    //   t=0.5s  host calls complete() (new turn starting)
    //   t=0.8s  new turn active; user Ctrl+C to cancel fresh stream
    //           → handler enters fresh armed state; the round-2 disarm
    //             timer at t=2 is STILL pending
    //   t=1.0s  user second Ctrl+C → MUST force (inside double-tap
    //           window of step-0.8 arm)
    //   t=2.0s  the stale disarm timer would fire and call complete()
    //           → without round-3's invalidation this would wipe the
    //             armed state and turn the step-1.0 tap into a fresh
    //             first tap that just aborts again
    //
    // This test drives the sequence in a tighter window (the principle
    // is the same regardless of exact timestamps) and asserts the
    // second Ctrl+C forces — which can only happen if the stale timer
    // was cancelled by round-3's invalidation hook.
    const { state, handler, timers } = makeHarness({ hasBackground: true });

    // 1. Idle + bg → first tap → hint + armed + disarm timer scheduled
    handler.handleSignal();
    expect(state.writes.join("")).toContain("Background tasks still running");
    const pendingAfterBgWait = timers.pending();
    expect(pendingAfterBgWait).toBeGreaterThanOrEqual(1);

    // 2. Host calls complete() at turn start — should cancel the stale
    //    disarm timer AND reset state. After this, no bg-wait timer
    //    should still be pending from that arm.
    timers.advance(500);
    handler.complete();
    expect(timers.pending()).toBeLessThan(pendingAfterBgWait);

    // 3. New foreground turn starts, user Ctrl+C to cancel.
    state.hasBackground = false;
    state.hasForeground = true;
    handler.handleSignal();
    expect(state.abortCount).toBe(1);
    expect(state.forceCount).toBe(0);

    // 4. Advance past the original bg-wait disarm deadline. If the old
    //    timer is still live, it would fire here and call complete(),
    //    collapsing the armed state from step 3 back to idle.
    timers.advance(2000);

    // 5. Second Ctrl+C — MUST force. This can only happen if the
    //    step-3 armed state is still intact, i.e. the stale timer
    //    from step 1 was properly cancelled by the host complete()
    //    call in step 2.
    handler.handleSignal();
    expect(state.forceCount).toBe(1);
  });

  test("after the double-tap window with no new turn, next Ctrl+C re-enters the bg-wait branch cleanly", () => {
    // Belt-and-braces: if the user ignores the first bg-hint and the bg
    // task keeps running, the NEXT Ctrl+C should re-show the hint (fresh
    // first tap) rather than silently forcing.
    const { state, handler, timers } = makeHarness({ hasBackground: true });

    handler.handleSignal();
    const firstWriteCount = state.writes.length;

    timers.advance(2100);
    handler.handleSignal();

    expect(state.writes.length).toBeGreaterThan(firstWriteCount);
    expect(state.forceCount).toBe(0);
  });
});
