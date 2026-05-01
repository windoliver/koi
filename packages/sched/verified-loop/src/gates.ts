/**
 * Gate factory functions for external verification.
 *
 * Gates answer "did this iteration actually work?" without relying on
 * LLM self-assessment. Three built-ins ship by default:
 *   - createTestGate: shell exit-code-0 = pass
 *   - createFileGate: string or regex match in a file
 *   - createCompositeGate: AND-combine sub-gates
 */

import { isAbsolute, resolve } from "node:path";
import type { GateContext, VerificationFn, VerificationResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/** Create a gate that runs a shell command and passes on exit code 0. */
export function createTestGate(
  args: readonly string[],
  options?: { readonly cwd?: string; readonly timeoutMs?: number },
): VerificationFn {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (ctx: GateContext): Promise<VerificationResult> => {
    const cwd = options?.cwd ?? ctx.workingDir;

    if (ctx.signal.aborted) {
      return { passed: false, details: "Test gate skipped: aborted before start" };
    }

    try {
      // stdout is "ignore" — gate output is not surfaced and an unread pipe
      // can deadlock the child once the kernel buffer fills (fixed-size, OS
      // dependent). stderr is piped because we surface it on failure, but we
      // drain it concurrently with proc.exited for the same reason.
      //
      // detached:true puts the child in its own process group (pgid = pid),
      // so a `kill(-pid, signal)` reaches every descendant the child forks.
      // Without this, a `bash -c "..."` whose body forks workers leaks those
      // workers past timeout/abort — they keep mutating the workspace after
      // the loop has advanced.
      const proc = Bun.spawn(args as string[], {
        cwd,
        stdout: "ignore",
        stderr: "pipe",
        detached: true,
      });

      // Two-phase kill of the entire process group: SIGTERM gives
      // well-behaved descendants a chance to clean up, then a 1s grace +
      // SIGKILL guarantees they actually exit before we advance.
      const killGroup = (signal: NodeJS.Signals): void => {
        try {
          // Negative pid = process-group kill (POSIX). Bun.spawn detached:true
          // sets pgid = pid, so this targets the whole tree.
          if (proc.pid !== undefined) {
            process.kill(-proc.pid, signal);
          }
        } catch {
          // Group already gone, or kernel rejected (e.g. permissions). Fall
          // back to per-PID kill on the leader as a best-effort.
          try {
            proc.kill(signal);
          } catch {
            // already exited
          }
        }
      };
      // Use let — justified: SIGKILL escalation timer must be clearable from
      // the exit path so we never fire SIGKILL after the child already exited.
      // POSIX recycles PIDs/PGIDs aggressively; an untracked late kill could
      // hit an unrelated process group.
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      // Use let — justified: track whether the gate was aborted/timed out so
      // a graceful SIGTERM-handling child cannot return passed:true after we
      // explicitly cancelled verification.
      let aborted = false;
      let timedOut = false;
      // Use let — justified: latched once the child has exited so a late
      // abort/timeout (fired while we're still draining stderr) cannot
      // retroactively mark a successfully-completed run as failed.
      let exited = false;
      const escalate = (): void => {
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 1_000);
      };

      const onAbort = (): void => {
        if (exited) return;
        aborted = true;
        escalate();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        if (exited) return;
        timedOut = true;
        escalate();
      }, timeoutMs);

      // Drain stderr concurrently from the moment the child is spawned —
      // never await proc.exited with the pipe still buffering, or a noisy
      // child will block on write past the OS pipe buffer (~64KB) and
      // never reach exit. The drain promise is held live for the entire
      // lifetime of the gate so it stays under the timeout/abort budget.
      const stderrPromise = new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      // Latch `exited` synchronously after proc.exited resolves so a
      // late abort/timeout that fires while we're still waiting on
      // stderr drain (e.g., a background descendant inheriting the
      // stream) cannot retroactively mark a successful run as failed.
      exited = true;
      ctx.signal.removeEventListener("abort", onAbort);
      // The child has exited, but a forked descendant may still be
      // holding stderr open. Bound the post-exit drain wait so we never
      // hang the loop past timeoutMs — once the child's own writes have
      // flushed, descendant chatter is not worth waiting for.
      // Use let — justified: race outcome.
      let drainTimedOut = false;
      const drainGrace = new Promise<string>((resolve) => {
        setTimeout(() => {
          drainTimedOut = true;
          resolve("[stderr drain exceeded grace; possibly held by descendant]");
        }, 1_000).unref?.();
      });
      const stderr = await Promise.race([stderrPromise, drainGrace]);
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      // Intentionally NOT calling killGroup() here even on drainTimedOut:
      // the leader exited before this point, so the kernel can reuse the
      // numeric PGID for an unrelated process group on a busy host. A
      // post-exit group kill would risk SIGKILL'ing a stranger. Accept
      // the placeholder stderr and let the descendant linger — it can no
      // longer affect our verification result.
      void drainTimedOut;

      // Cancellation is a verification failure regardless of exit code. A
      // child that traps SIGTERM and exits 0 (or simply finishes during the
      // signal-delivery window) must not be reported as passed: the loop
      // explicitly told the gate to stop, so its result is untrusted.
      if (aborted) {
        return {
          passed: false,
          details: `Test gate aborted by ctx.signal (exit ${exitCode}): ${stderr.slice(0, 500)}`,
        };
      }
      if (timedOut) {
        return {
          passed: false,
          details: `Test gate timed out after ${timeoutMs}ms (exit ${exitCode}): ${stderr.slice(0, 500)}`,
        };
      }
      return {
        passed: exitCode === 0,
        details:
          exitCode === 0
            ? "Test gate passed"
            : `Test gate failed (exit ${exitCode}): ${stderr.slice(0, 500)}`,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { passed: false, details: `Test gate error: ${message}` };
    }
  };
}

/**
 * Create a gate that checks if a file contains a string or matches a regex.
 *
 * Relative paths are resolved against `ctx.workingDir` at call time, not the
 * process cwd. A loop launched from a different cwd than its workspace would
 * otherwise read an unrelated file and produce a false-positive verification.
 */
export function createFileGate(path: string, match: string | RegExp): VerificationFn {
  return async (ctx: GateContext): Promise<VerificationResult> => {
    if (ctx.signal.aborted) {
      return { passed: false, details: "File gate skipped: aborted before start" };
    }
    const resolvedPath = isAbsolute(path) ? path : resolve(ctx.workingDir, path);
    const file = Bun.file(resolvedPath);
    const exists = await file.exists();
    if (!exists) {
      return { passed: false, details: `File not found: ${resolvedPath}` };
    }

    try {
      const content = await file.text();
      // Reset lastIndex before .test() — `g`/`y` flagged regexes are stateful;
      // calling test() on the same instance twice can alternate pass/fail on
      // identical content, which would consume the failure budget despite no
      // change to the workspace.
      const matched =
        typeof match === "string"
          ? content.includes(match)
          : (() => {
              match.lastIndex = 0;
              return match.test(content);
            })();

      return {
        passed: matched,
        details: matched
          ? `File gate passed: ${resolvedPath}`
          : `File gate failed: pattern not found in ${resolvedPath}`,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { passed: false, details: `File gate error: ${message}` };
    }
  };
}

/** Create a gate that requires all sub-gates to pass. Items completed are deduped. */
export function createCompositeGate(gates: readonly VerificationFn[]): VerificationFn {
  return async (ctx: GateContext): Promise<VerificationResult> => {
    const details: string[] = [];
    const allCompleted: string[] = [];
    // Use let — justified: aggregate flag mutated across gate iterations
    let allPassed = true;

    for (const gate of gates) {
      if (ctx.signal.aborted) {
        details.push("Composite gate aborted before remaining sub-gates ran");
        allPassed = false;
        break;
      }
      const result = await gate(ctx);
      if (result.details) {
        details.push(result.details);
      }
      if (result.itemsCompleted) {
        allCompleted.push(...result.itemsCompleted);
      }
      if (!result.passed) {
        allPassed = false;
      }
    }

    const uniqueCompleted = [...new Set(allCompleted)];

    return {
      passed: allPassed,
      details: details.join("; "),
      itemsCompleted: uniqueCompleted.length > 0 ? uniqueCompleted : undefined,
    };
  };
}
