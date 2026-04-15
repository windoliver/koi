/**
 * Pure decision logic + factory for the TUI's SIGINT graceful handler.
 *
 * When the SIGINT state machine fires `onGraceful` (first Ctrl+C of a
 * double-tap window), the TUI has to choose between three outcomes based
 * on what is running right now:
 *
 *   1. **Abort the active foreground stream.** There is a model run in
 *      flight. Cancel it and keep the user in the TUI — the engine emits
 *      its terminal `done` with `stopReason: "interrupted"`, the user
 *      stays at the prompt and can retry.
 *
 *   2. **Wait for an explicit exit tap.** No foreground run, but there are
 *      live `bash_background` subprocesses. Print a hint and return,
 *      leaving the state machine armed so a second Ctrl+C within the
 *      double-tap window escalates to force-shutdown. Without this branch,
 *      first-tap-at-idle immediately tears down the TUI — see #1772.
 *
 *   3. **Shutdown.** No foreground, no background. First Ctrl+C at an
 *      idle, empty TUI quits immediately — matches the standard single-
 *      SIGINT termination convention for REPLs with nothing in flight.
 *
 * Critically, case 2 schedules a self-disarm via `handler.complete()`
 * after the double-tap window elapses. Without that, the handler stays
 * `armed` indefinitely (the TUI's default `onWindowElapse` is `stay-armed`
 * because the active-foreground path relies on the drain loop to call
 * `complete()` when the turn settles — but the bg-wait path has no such
 * hook). A later single Ctrl+C during a new foreground turn would then
 * be treated as the second tap of the stale bg-wait sequence and
 * force-exit the TUI, discarding the turn the user intended to cancel.
 *
 * The decision function and the factory are dependency-injected so
 * both the three-way decision AND the disarm behavior can be unit-tested
 * without spinning up a TUI or a runtime.
 */

import type { SigintHandler, SigintHandlerDeps, Timer } from "./sigint-handler.js";
import { createSigintHandler } from "./sigint-handler.js";

export type TuiGracefulAction =
  | { readonly kind: "abort-active-stream" }
  | { readonly kind: "wait-for-bg-exit-tap"; readonly hint: string }
  | { readonly kind: "shutdown" };

export interface TuiGracefulInputs {
  /** True when a foreground model stream is currently active. */
  readonly hasActiveForegroundStream: boolean;
  /** True when at least one `bash_background` subprocess is still running. */
  readonly hasActiveBackgroundTasks: boolean;
}

/** Hint shown on the first Ctrl+C when only background tasks are running. */
export const TUI_BG_EXIT_HINT =
  "\nBackground tasks still running. Press Ctrl+C again to exit (background tasks will be terminated).\n";

/** Decide the TUI's graceful-SIGINT action given the current run state. */
export function decideTuiGracefulAction(inputs: TuiGracefulInputs): TuiGracefulAction {
  if (inputs.hasActiveForegroundStream) {
    return { kind: "abort-active-stream" };
  }
  if (inputs.hasActiveBackgroundTasks) {
    return { kind: "wait-for-bg-exit-tap", hint: TUI_BG_EXIT_HINT };
  }
  return { kind: "shutdown" };
}

/**
 * Dependencies for the TUI sigint wrapper. The runtime probes
 * (`hasActiveForegroundStream`, `hasActiveBackgroundTasks`) are functions
 * because the values change over the life of the session; they must be
 * read fresh on every signal.
 */
export interface TuiSigintDeps {
  readonly hasActiveForegroundStream: () => boolean;
  readonly hasActiveBackgroundTasks: () => boolean;
  readonly abortActiveStream: () => void;
  /**
   * Graceful shutdown entry — called when the first Ctrl+C arrives at an
   * empty idle TUI (no foreground, no background). Typically kicks off
   * the TUI's cooperative `shutdown(130)` path.
   */
  readonly onShutdown: () => void;
  /**
   * Force shutdown entry — called when the double-tap window sees a
   * second Ctrl+C while armed. Typically aborts the foreground stream,
   * SIGTERMs background subprocesses, waits for SIGKILL escalation,
   * and calls `process.exit(130)`.
   */
  readonly onForce: () => void;
  readonly write: (msg: string) => void;
  readonly setTimer: (fn: () => void, ms: number) => Timer;
  readonly doubleTapWindowMs: number;
  readonly coalesceWindowMs?: number;
  readonly now?: () => number;
}

/**
 * Build the TUI's SIGINT handler with the three-way graceful-action
 * decision and the bg-wait self-disarm timer wired in.
 *
 * The returned handler is a plain `SigintHandler` — callers install it
 * via `process.on("SIGINT", () => handler.handleSignal())` exactly as
 * before. The bg-wait disarm is implemented by scheduling a timer that
 * calls `handler.complete()` after the double-tap window; that closes
 * the state-poisoning gap flagged in #1772 review round 1.
 */
export function createTuiSigintHandler(deps: TuiSigintDeps): SigintHandler {
  // let: justified — forward reference so the bg-wait branch below can
  // schedule a self-disarm timer that calls handler.complete(). The
  // handler itself is assigned immediately after createSigintHandler
  // returns, before any signal can fire.
  let handlerRef: SigintHandler | undefined;

  const handlerDeps: SigintHandlerDeps = {
    onGraceful: (): void => {
      const action = decideTuiGracefulAction({
        hasActiveForegroundStream: deps.hasActiveForegroundStream(),
        hasActiveBackgroundTasks: deps.hasActiveBackgroundTasks(),
      });
      switch (action.kind) {
        case "abort-active-stream":
          deps.abortActiveStream();
          return;
        case "wait-for-bg-exit-tap":
          deps.write(action.hint);
          // Self-disarm after the double-tap window. Without this, the
          // state machine stays `armed` indefinitely and a later fresh
          // Ctrl+C — e.g. during a new foreground turn started minutes
          // later — is treated as the second tap of this stale sequence
          // and forces the TUI to exit, destroying the cancellable turn.
          // `complete()` is a no-op if the state has already moved on
          // (e.g. a genuine second tap escalated to `forced` first), so
          // the timer is safe to fire unconditionally.
          deps.setTimer(() => {
            handlerRef?.complete();
          }, deps.doubleTapWindowMs);
          return;
        case "shutdown":
          deps.onShutdown();
          return;
      }
    },
    onForce: deps.onForce,
    write: deps.write,
    doubleTapWindowMs: deps.doubleTapWindowMs,
    setTimer: deps.setTimer,
    ...(deps.coalesceWindowMs !== undefined ? { coalesceWindowMs: deps.coalesceWindowMs } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };

  const handler = createSigintHandler(handlerDeps);
  handlerRef = handler;
  return handler;
}
