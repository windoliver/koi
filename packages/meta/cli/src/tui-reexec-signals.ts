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
 * Install SIGINT and SIGTERM handlers on the re-exec parent process.
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
 */
export function installTuiReexecSignalHandlers(proc: Subprocess): void {
  process.on("SIGINT", noopSigintHandler);
  process.on("SIGTERM", () => {
    forwardSigtermWithEscalation(proc);
  });
}

function noopSigintHandler(): void {
  // Intentional no-op — see module docstring.
}

function forwardSigtermWithEscalation(proc: Subprocess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    // Child already exited — `await proc.exited` will unblock on the
    // next tick.
  }
  const escalate = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Nothing more to do.
    }
    process.exit(143);
  }, PARENT_SIGTERM_ESCALATION_MS);
  if (typeof escalate === "object" && escalate !== null && "unref" in escalate) {
    (escalate as { unref: () => void }).unref();
  }
}
