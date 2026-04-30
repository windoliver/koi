/**
 * Gate factory functions for external verification.
 *
 * Gates answer "did this iteration actually work?" without relying on
 * LLM self-assessment. Three built-ins ship by default:
 *   - createTestGate: shell exit-code-0 = pass
 *   - createFileGate: string or regex match in a file
 *   - createCompositeGate: AND-combine sub-gates
 */

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
      const proc = Bun.spawn(args as string[], {
        cwd,
        stdout: "ignore",
        stderr: "pipe",
      });

      const onAbort = (): void => {
        proc.kill();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        proc.kill();
      }, timeoutMs);

      // Drain stderr concurrently — never await proc.exited with a pipe still buffering.
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      clearTimeout(timer);
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

/** Create a gate that checks if a file contains a string or matches a regex. */
export function createFileGate(path: string, match: string | RegExp): VerificationFn {
  return async (_ctx: GateContext): Promise<VerificationResult> => {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) {
      return { passed: false, details: `File not found: ${path}` };
    }

    try {
      const content = await file.text();
      const matched = typeof match === "string" ? content.includes(match) : match.test(content);

      return {
        passed: matched,
        details: matched
          ? `File gate passed: ${path}`
          : `File gate failed: pattern not found in ${path}`,
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
