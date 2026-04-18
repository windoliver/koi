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

import { constants as osConstants } from "node:os";

export interface Sigusr1HandlerDeps {
  /** Forwards to the TUI command's closure-local `shutdown()`. */
  readonly shutdown: (exitCode: number, reason: string) => void;
  /** Used to emit a one-line trace to stderr. Typically `process.stderr.write`. */
  readonly write: (msg: string) => void;
}

/**
 * Platform-specific fallback signal numbers for SIGUSR1. Used only when
 * `os.constants.signals.SIGUSR1` is unavailable (Windows, or an unusual
 * libc). Matches macOS (30) and Linux (10) POSIX conventions so supervisors
 * and incident tooling see `128 + sigNum` on every platform.
 */
const FALLBACK_SIGUSR1 = {
  darwin: 30,
  linux: 10,
} as const satisfies Record<string, number>;

function resolveSigusr1Number(): number {
  const fromOs = osConstants.signals.SIGUSR1;
  if (typeof fromOs === "number" && fromOs > 0) return fromOs;
  if (process.platform === "darwin") return FALLBACK_SIGUSR1.darwin;
  // Linux-convention default covers every other POSIX platform (freebsd,
  // netbsd, openbsd) that also assigns SIGUSR1 = 10. Windows lacks SIGUSR1
  // entirely, but the handler can never fire there — the signal is simply
  // not delivered — so any sentinel value is moot.
  return FALLBACK_SIGUSR1.linux;
}

/**
 * Exit code `128 + signal_number`. Computed at module load because the
 * signal-number map is platform-specific: macOS assigns SIGUSR1 = 30
 * (exit 158), Linux assigns SIGUSR1 = 10 (exit 138). Supervisors keying
 * on `(exitCode - 128) === signalNum` get the canonical value on every
 * platform without per-callsite conditionals.
 */
export const SIGUSR1_EXIT_CODE: number = 128 + resolveSigusr1Number();

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

// Module-level reference so `installEarlySigusr1Handler` and
// `removeEarlySigusr1Handler` share the same listener identity across call
// sites (bin.ts installs, tui-command.ts removes) without globals.
// let: justified — set by install, cleared by remove, never mutated mid-call.
let earlyHandler: (() => void) | null = null;

/**
 * Install a minimal `SIGUSR1` handler BEFORE the TUI bootstraps (#1906).
 *
 * Why: `runTuiCommand` installs the full graceful-shutdown handler only
 * after ~4000 lines of startup work. A `SIGUSR1` arriving during that
 * window would hit Bun/Node's default behavior (Node launches an
 * inspector; Bun's default is implementation-defined) instead of the
 * intended escape hatch. Installing a trivial exit-code handler first
 * both masks the default and exits cleanly if the user targets the
 * process during startup. `runTuiCommand` calls
 * `removeEarlySigusr1Handler()` before registering its full handler.
 *
 * Idempotent: repeated calls do not install multiple listeners.
 */
export function installEarlySigusr1Handler(): void {
  if (earlyHandler !== null) return;
  const handler = (): void => {
    process.exit(SIGUSR1_EXIT_CODE);
  };
  earlyHandler = handler;
  process.on("SIGUSR1", handler);
}

/**
 * Remove the early handler installed by `installEarlySigusr1Handler`.
 * No-op if none was installed. Safe to call from cleanup paths.
 */
export function removeEarlySigusr1Handler(): void {
  if (earlyHandler === null) return;
  process.removeListener("SIGUSR1", earlyHandler);
  earlyHandler = null;
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
