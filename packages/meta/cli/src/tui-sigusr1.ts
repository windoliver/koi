/**
 * SIGUSR1 escape-hatch handler for `koi tui` (issue #1906).
 *
 * The TUI's native OpenTUI input/render thread can deadlock on macOS
 * (`__ulock_wait2`, a lost condvar wakeup inside `libopentui.dylib`). When
 * that happens Ctrl+C is never delivered as SIGINT — raw mode routes the
 * byte to the TTY reader which is itself wedged on the native thread. The
 * JS event loop stays healthy, so kernel-delivered POSIX signals still
 * run through Node's signal layer and fire on the next tick. That makes
 * SIGUSR1 a reliable out-of-band escape.
 *
 * Users trigger it from another terminal with:
 *   kill -USR1 <koi-tui-pid>
 *
 * The handler is idempotent. The underlying `shutdown()` already arms an
 * 8s hard-exit failsafe, so a per-handler failsafe is not needed here.
 */

export interface Sigusr1HandlerDeps {
  /** Forwards to the TUI command's closure-local `shutdown()`. */
  readonly shutdown: (exitCode: number, reason: string) => void;
  /** Used to emit a one-line trace to stderr. Typically `process.stderr.write`. */
  readonly write: (msg: string) => void;
}

/**
 * Exit code `128 + signal_number`. SIGUSR1 is signal 30 on macOS and 10
 * on Linux; we pin to 158 (macOS) because this is the platform the deadlock
 * was reported on and because portable incident tooling should key on the
 * reason string, not the exact numeric code.
 */
export const SIGUSR1_EXIT_CODE = 158;

export function createSigusr1Handler(deps: Sigusr1HandlerDeps): () => void {
  // let: justified — set once on first signal to make subsequent signals no-ops.
  let triggered = false;
  return (): void => {
    if (triggered) return;
    triggered = true;
    try {
      deps.write("\n[koi tui] SIGUSR1 received — initiating force-escape shutdown\n");
    } catch {
      /* stderr unwritable after hangup — best effort */
    }
    deps.shutdown(SIGUSR1_EXIT_CODE, "SIGUSR1 received (force-escape from frozen TUI)");
  };
}

/**
 * One-line startup hint printed before the TUI takes over the terminal.
 * Users see the process PID in their scrollback and know the exact `kill`
 * command to run if the TUI freezes. Pure so tests don't depend on the
 * host process's real PID.
 */
export function generateTuiStartupHint(pid: number): string {
  return `[koi tui] pid=${pid}; if the TUI freezes, run: kill -USR1 ${pid}\n`;
}
