/**
 * Pure decision logic for the TUI's SIGINT graceful handler.
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
 * The function is pure and dependency-injected so the three-way decision
 * can be unit-tested without spinning up a TUI, a runtime, or the SIGINT
 * state machine.
 */

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
