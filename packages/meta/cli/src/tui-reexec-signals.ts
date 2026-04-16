/**
 * Signal handling for the `koi tui` re-exec parent wrapper (see issue #1653).
 *
 * bin.ts spawns the browser-build TUI child and then installs SIGINT and
 * SIGTERM handlers on the parent. This module holds the actual handler
 * logic so bin.ts stays minimal — the startup-latency gate (#1637) locks
 * bin.ts's post-fast-path identifier set to a small whitelist, and keeping
 * signal handling out of bin.ts avoids widening that measurement blind
 * spot with a dozen new identifiers.
 *
 * The functions here are NOT executed on the startup-latency measurement
 * path (bench-entry.ts's command-dispatch scenario short-circuits before
 * any re-exec spawn), so extending bench-entry.ts to cover them is not
 * required.
 */

import type { Subprocess } from "bun";

// After the first SIGTERM, escalate to SIGKILL and hard-exit after this
// many milliseconds if the child refuses to exit. Prevents the wrapper
// from hanging forever on `proc.exited` when the child wedges.
const PARENT_SIGTERM_ESCALATION_MS = 10_000;

/**
 * Arm SIGINT, SIGTERM, and SIGHUP handlers on the re-exec parent process
 * BEFORE spawning the child. Returns a function to bind the child process
 * reference once spawned. This two-phase design eliminates the race window
 * where a signal could arrive between spawn and handler installation (#1750).
 *
 * Usage:
 * ```ts
 * const bindChild = armTuiReexecSignalHandlers();
 * const proc = Bun.spawn(...);
 * bindChild(proc);
 * ```
 *
 * SIGINT: the terminal delivers Ctrl+C to the whole foreground process
 * group, so the child already receives it directly. Forwarding would
 * double-deliver and turn a single Ctrl+C into a force-exit under
 * scheduler delay. Install a no-op handler purely to suppress Node's
 * default "terminate parent immediately" behavior so the parent can
 * block on `proc.exited` and follow the child's graceful interrupt flow.
 *
 * Known limitation: `kill -INT <wrapperPid>` (PID-directed, no group
 * delivery) won't reach the child. SIGINT is conventionally
 * terminal-driven; supervisors should use SIGTERM for PID-directed
 * termination, which IS forwarded below with SIGKILL escalation.
 *
 * SIGTERM: PID-directed from supervisors only hits the parent, so
 * forwarding is the only path. The 10s SIGKILL escalation guarantees
 * the wrapper cannot hang forever if the child refuses to exit.
 *
 * SIGHUP (#1750): tmux sends SIGHUP when a session is killed. Without
 * a handler, the parent ignores it and hangs on `proc.exited`, orphaning
 * the child. Forward as SIGTERM to trigger the child's graceful shutdown.
 *
 * All forwarding state is per-installation (closure-local), so sequential
 * re-exec children in one process each get independent signal forwarding.
 */
export interface TuiReexecSignalGuard {
  /** True if a termination signal arrived before bindChild was called. */
  readonly terminated: boolean;
  /** Exit code for the pending signal (143 for SIGTERM, 129 for SIGHUP). */
  readonly terminatedExitCode: number;
  /** Bind the child process. Replays any pending signal immediately. */
  readonly bindChild: (proc: Subprocess) => void;
}

export function armTuiReexecSignalHandlers(): TuiReexecSignalGuard {
  // let: justified — mutable child ref, set once when caller binds.
  let child: Subprocess | null = null;
  // let: justified — set once on first forward call to prevent double-
  // escalation when both SIGHUP and SIGTERM arrive.
  let forwardingStarted = false;
  // let: justified — tracks whether a signal arrived before bindChild.
  // If true, bindChild replays the forward immediately.
  let pendingSignal = false;
  // let: justified — exit code matching the pending signal kind.
  // 143 = SIGTERM (128+15), 129 = SIGHUP (128+1).
  let pendingExitCode = 143;

  const forwardToChild = (proc: Subprocess, exitCode: number): void => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // Child already exited.
    }
    const escalate = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Nothing more to do.
      }
      process.exit(exitCode);
    }, PARENT_SIGTERM_ESCALATION_MS);
    if (typeof escalate === "object" && escalate !== null && "unref" in escalate) {
      (escalate as { unref: () => void }).unref();
    }
  };

  const forward = (exitCode: number): void => {
    if (forwardingStarted) return;
    forwardingStarted = true;
    pendingExitCode = exitCode;
    if (child !== null) {
      forwardToChild(child, exitCode);
    } else {
      // Signal arrived between arm and bind — record it so bindChild
      // can replay the forward once the child ref is available.
      pendingSignal = true;
    }
  };

  const onSigterm = (): void => {
    forward(143);
  };
  const onSighup = (): void => {
    forward(129);
  };

  // Only arm SIGTERM/SIGHUP pre-spawn. SIGINT (Ctrl+C) must NOT be
  // masked before the child exists — otherwise a user pressing Ctrl+C
  // during startup would be silently ignored and the TUI would launch.
  // The SIGINT no-op handler is installed in bindChild after spawn.
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  return {
    get terminated(): boolean {
      return forwardingStarted;
    },
    get terminatedExitCode(): number {
      return pendingExitCode;
    },
    bindChild(proc: Subprocess): void {
      child = proc;
      // Now that the child exists, install the SIGINT no-op so the
      // parent doesn't exit before the child's graceful interrupt flow.
      process.on("SIGINT", noopSigintHandler);
      // Replay: if a signal arrived between arm and bind, forward now.
      if (pendingSignal) {
        forwardToChild(proc, pendingExitCode);
      }
      // Clean up listeners when the child exits so a later re-exec child
      // in the same process starts from a clean state.
      void proc.exited.then(() => {
        process.removeListener("SIGINT", noopSigintHandler);
        process.removeListener("SIGTERM", onSigterm);
        process.removeListener("SIGHUP", onSighup);
      });
    },
  };
}

/**
 * @deprecated Use {@link armTuiReexecSignalHandlers} instead.
 * Kept for backward compatibility — calls arm + bind in one step.
 */
export function installTuiReexecSignalHandlers(proc: Subprocess): void {
  armTuiReexecSignalHandlers().bindChild(proc);
}

function noopSigintHandler(): void {
  // Intentional no-op — see module docstring.
}
