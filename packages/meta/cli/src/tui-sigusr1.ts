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
 * `os.constants.signals.SIGUSR1` is unavailable (Windows or an unusual
 * libc where the constant is missing). Each entry matches the platform's
 * system header value so supervisors keying on `128 + signum` see the
 * canonical exit code even through the fallback path:
 *
 *   darwin/*bsd: 30 → 158
 *   linux/aix:   10 → 138
 *
 * SunOS/Solaris uses 16 but koi does not target it; if a user encounters
 * it, `resolveSigusr1Number` falls through to the final 10 default.
 */
const FALLBACK_SIGUSR1 = {
  darwin: 30,
  freebsd: 30,
  netbsd: 30,
  openbsd: 30,
  linux: 10,
  aix: 10,
} as const satisfies Record<string, number>;

type FallbackPlatform = keyof typeof FALLBACK_SIGUSR1;

function isFallbackPlatform(p: string): p is FallbackPlatform {
  return p in FALLBACK_SIGUSR1;
}

function resolveSigusr1Number(): number {
  const fromOs = osConstants.signals.SIGUSR1;
  if (typeof fromOs === "number" && fromOs > 0) return fromOs;
  if (isFallbackPlatform(process.platform)) return FALLBACK_SIGUSR1[process.platform];
  // Last-ditch default for unknown POSIX runtimes. SUSv3 does not pin
  // SIGUSR1 to a specific number; 10 matches the Linux/AIX convention and
  // is the most common value. Windows never reaches here because
  // SIGUSR1_SUPPORTED gates every install site.
  return 10;
}

/**
 * Exit code `128 + signal_number`. Computed at module load because the
 * signal-number map is platform-specific: macOS assigns SIGUSR1 = 30
 * (exit 158), Linux assigns SIGUSR1 = 10 (exit 138). Supervisors keying
 * on `(exitCode - 128) === signalNum` get the canonical value on every
 * platform without per-callsite conditionals.
 */
export const SIGUSR1_EXIT_CODE: number = 128 + resolveSigusr1Number();

/**
 * True when the runtime and platform support `SIGUSR1` delivery.
 * Windows is the only platform where `SIGUSR1` is outright unavailable;
 * every POSIX runtime delivers it, even on the rare host where
 * `os.constants.signals.SIGUSR1` is absent (`resolveSigusr1Number`
 * provides a fallback). Callers install handlers and emit the startup
 * hint only when this is true so Windows users see no extra output
 * and no non-functional listeners. Using a platform-only predicate
 * (not a signal-constant probe) keeps the gates consistent across
 * `bin.ts`, `tui-command.ts`, and `tui-reexec-signals.ts` — otherwise
 * a missing-constant edge case would leave the child with only the
 * early hard-exit handler while the parent no longer forwarded
 * `SIGUSR1` at all (#1906 round-7 review).
 */
export const SIGUSR1_SUPPORTED: boolean = process.platform !== "win32";

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

/*
 * The "early" SIGUSR1 handler that covers the window between child spawn
 * and `runTuiCommand`'s full handler install is inlined synchronously at
 * the top of `bin.ts` rather than exported from here (#1906 round-5
 * review). Any helper that wrapped `process.on("SIGUSR1", …)` in this
 * module would need to be imported, which pushes the install behind an
 * `await import(...)` — widening the race window by one module-resolution
 * round-trip.
 *
 * bin.ts stores its inline handler on `globalThis[EARLY_HANDLER_KEY]`
 * (Symbol.for, no import required) so `runTuiCommand` can swap that
 * specific listener without touching any unrelated SIGUSR1 handlers an
 * embedding host may have installed on the same process.
 */

const EARLY_HANDLER_KEY = Symbol.for("koi:tui:sigusr1:early-handler");

type EarlyHandlerHolder = Record<symbol, unknown>;

/**
 * Remove the inline early SIGUSR1 handler stashed by `bin.ts` on
 * `globalThis[Symbol.for("koi:tui:sigusr1:early-handler")]`. Safe
 * no-op when no early handler was stored (e.g. direct unit-test
 * invocation of `runTuiCommand`) or when the stored value is not a
 * function. Touches ONLY that specific listener — any SIGUSR1
 * listeners installed by an embedding host survive.
 */
export function removeStoredEarlySigusr1Handler(): void {
  const holder = globalThis as EarlyHandlerHolder;
  const fn = holder[EARLY_HANDLER_KEY];
  if (typeof fn !== "function") return;
  process.removeListener("SIGUSR1", fn as () => void);
  delete holder[EARLY_HANDLER_KEY];
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
