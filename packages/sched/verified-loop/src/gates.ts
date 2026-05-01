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
      const escalate = (): void => {
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), 1_000);
      };

      const onAbort = (): void => {
        escalate();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        escalate();
      }, timeoutMs);

      // Drain stderr concurrently — never await proc.exited with a pipe still buffering.
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      ctx.signal.removeEventListener("abort", onAbort);

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
