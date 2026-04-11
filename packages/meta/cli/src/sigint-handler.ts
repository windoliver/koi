/**
 * SIGINT double-tap state machine.
 *
 * First Ctrl+C triggers a graceful abort (`onGraceful`) and prints a hint.
 * A second Ctrl+C within `doubleTapWindowMs` forces an exit (`onForce`).
 * A failsafe timer calls `onForce` after `failsafeMs` as defense-in-depth
 * if the graceful abort hangs.
 *
 * The handler is a pure factory with injected timers so it can be unit-tested
 * without touching `process.on` or the real clock. Hosts install it by calling
 * `handleSignal()` from `process.on("SIGINT", ...)`.
 *
 * See docs/L2/interrupt.md for the protocol and issue #1653.
 */

export interface Timer {
  readonly cancel: () => void;
}

export interface SigintHandlerDeps {
  /** Called on the first SIGINT. Typically `controller.abort()`. */
  readonly onGraceful: () => void;
  /** Called on the second SIGINT within the window, or when the failsafe fires. */
  readonly onForce: () => void;
  /** Used to print the "Interrupting…" hint. Typically `process.stderr.write`. */
  readonly write: (msg: string) => void;
  /** How long the user has to tap Ctrl+C a second time. */
  readonly doubleTapWindowMs: number;
  /**
   * Failsafe: force-exit this long after the first SIGINT if abort hangs.
   * Omit when the graceful path is synchronous and no timeout is needed
   * (e.g. TUI first tap only aborts an in-memory controller).
   */
  readonly failsafeMs?: number;
  /**
   * Coalesce signals arriving within this window into a single tap.
   * Defense-in-depth for duplicate-delivery edge cases where the same
   * physical Ctrl+C could be observed twice (e.g. an in-app keyboard path
   * and a process-level SIGINT handler routing to the same state machine).
   * In the common configurations in this repo the child process is in its
   * own process group so there is no duplicate delivery to defend against;
   * the default is 0 (disabled) and callers opt in explicitly when they
   * have a genuine source of duplicates.
   * Default: 0. Human intentional double-taps are on the order of 300-500ms
   * apart, so a value up to ~150ms is safe if enabled.
   */
  readonly coalesceWindowMs?: number;
  /**
   * Policy for what happens when the double-tap window elapses without a
   * second tap:
   *   - `"stay-armed"` (default): the handler stays in the armed state;
   *     only `complete()` or a subsequent forced tap returns it to idle.
   *     Callers that wire `complete()` to an observable "graceful finished"
   *     event (e.g. TUI drain loop's `finally`) should use this.
   *   - `"reset-to-idle"`: after the window elapses, the handler goes back
   *     to idle and the next SIGINT is treated as a fresh first tap. Use
   *     this when there is no good hook for `complete()` — the `koi start`
   *     interactive loop runs multiple turns without a per-turn callback,
   *     and staying armed across turns would turn routine cancellations
   *     into force-exits.
   */
  readonly onWindowElapse?: "stay-armed" | "reset-to-idle";
  /** Injectable timer factory. Production uses a `setTimeout` wrapper. */
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  /** Injectable clock. Production uses `() => Date.now()`. */
  readonly now?: () => number;
}

export interface SigintHandler {
  /** Call from `process.on("SIGINT", () => handler.handleSignal())`. */
  readonly handleSignal: () => void;
  /**
   * Mark the in-flight graceful interrupt as finished. Returns the state
   * machine to `idle` so any later SIGINT starts a fresh double-tap window.
   * Call this when the interrupted operation has observably settled (e.g.
   * the engine emitted its terminal `done` event). Safe to call when idle.
   */
  readonly complete: () => void;
  /** Cancel all pending timers. Safe to call repeatedly. */
  readonly dispose: () => void;
}

/**
 * State:
 *  - `idle`       — no graceful abort in flight
 *  - `armed`      — graceful abort requested; `failsafeTimer` is always
 *                   active while in this state; `doubleTapTimer` is active
 *                   only during the double-tap window (null afterwards)
 *  - `forced`     — onForce has been called; further signals are no-ops
 */
type State =
  | { readonly kind: "idle" }
  | {
      readonly kind: "armed";
      readonly failsafeTimer: Timer | null;
      doubleTapTimer: Timer | null;
    }
  | { readonly kind: "forced" };

export function createSigintHandler(deps: SigintHandlerDeps): SigintHandler {
  let state: State = { kind: "idle" };
  const now = deps.now ?? ((): number => Date.now());
  const coalesceWindowMs = deps.coalesceWindowMs ?? 0;
  const onWindowElapse = deps.onWindowElapse ?? "stay-armed";
  // let: justified — timestamp of most recent non-coalesced signal
  let lastSignalAt = Number.NEGATIVE_INFINITY;

  const clearTimers = (): void => {
    if (state.kind === "armed") {
      state.doubleTapTimer?.cancel();
      state.failsafeTimer?.cancel();
    }
  };

  const force = (): void => {
    if (state.kind === "forced") return;
    clearTimers();
    state = { kind: "forced" };
    deps.onForce();
  };

  const armDoubleTapTimer = (): Timer =>
    deps.setTimer(() => {
      // Double-tap window elapsed. Behavior depends on host policy:
      //   - stay-armed: clear the double-tap slot but stay in the armed
      //     state. Subsequent taps force until complete() is called.
      //   - reset-to-idle: the first-tap window expired without a force
      //     request; go back to idle so the next SIGINT is a fresh first
      //     tap. Failsafe (if any) is cancelled because there is no
      //     in-flight graceful request to guard anymore.
      if (state.kind !== "armed") return;
      if (onWindowElapse === "reset-to-idle") {
        state.failsafeTimer?.cancel();
        state = { kind: "idle" };
      } else {
        state.doubleTapTimer = null;
      }
    }, deps.doubleTapWindowMs);

  const handleSignal = (): void => {
    // Debounce benign double-delivery: if the same physical signal arrives
    // twice within the coalesce window (e.g. terminal delivers SIGINT to
    // the process group AND the re-exec launcher forwards it a few ms
    // later), treat the duplicates as a single tap.
    const t = now();
    if (coalesceWindowMs > 0 && t - lastSignalAt < coalesceWindowMs) {
      return;
    }
    lastSignalAt = t;

    if (state.kind === "forced") {
      // Already forced but the user is still tapping. They want out NOW.
      // Call onForce again so callers can escalate (e.g. wrap a cooperative
      // shutdown the first time and hard-exit on subsequent taps). Force
      // handlers must be idempotent in terms of user-visible effect.
      deps.onForce();
      return;
    }

    if (state.kind === "armed") {
      // Any tap after the first graceful request — within the double-tap
      // window OR after it elapsed — forces exit. Once the interrupt
      // sequence has started, the only way back to idle is `complete()`;
      // subsequent taps are the user's "get out NOW" escape hatch, not a
      // request to re-enter the graceful path.
      force();
      return;
    }

    // idle → armed. Install timers BEFORE calling onGraceful so that if
    // onGraceful throws, the state has still advanced and a second tap
    // will force-exit instead of re-entering the graceful path.
    const failsafeTimer =
      deps.failsafeMs !== undefined
        ? deps.setTimer(() => {
            force();
          }, deps.failsafeMs)
        : null;
    const doubleTapTimer = armDoubleTapTimer();
    state = { kind: "armed", failsafeTimer, doubleTapTimer };
    deps.write("\nInterrupting… (Ctrl+C again to force)\n");
    deps.onGraceful();
  };

  const complete = (): void => {
    // Graceful interrupt has observably finished. Return to idle so a later
    // SIGINT starts a fresh double-tap window. No-op when already idle or
    // forced — the window is scoped to a single in-flight cancellation.
    if (state.kind !== "armed") return;
    clearTimers();
    state = { kind: "idle" };
    // Reset the coalesce-window timestamp too: otherwise a legitimate
    // first Ctrl+C on a subsequent run that lands within coalesceWindowMs
    // of the last signal of the completed run is silently discarded as a
    // duplicate. Coalescing is scoped to a single in-flight sequence.
    lastSignalAt = Number.NEGATIVE_INFINITY;
  };

  const dispose = (): void => {
    clearTimers();
    if (state.kind === "armed") {
      state = { kind: "idle" };
    }
    lastSignalAt = Number.NEGATIVE_INFINITY;
  };

  return { handleSignal, complete, dispose };
}

/**
 * Production timer factory backed by `setTimeout`. Uses `.unref()` so the
 * failsafe doesn't keep the process alive when cleanup completes naturally.
 */
export function createUnrefTimer(fn: () => void, ms: number): Timer {
  const handle = setTimeout(fn, ms);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    (handle as { unref: () => void }).unref();
  }
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}
