/**
 * Gate factory functions for external verification.
 *
 * Gates are the "objective check" in the Ralph Loop — they answer
 * "did this iteration actually work?" without relying on LLM self-assessment.
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

    try {
      const proc = Bun.spawn(args as string[], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => {
        proc.kill();
      }, timeoutMs);

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const stderr = await new Response(proc.stderr).text();

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

/** Create a gate that requires all sub-gates to pass. */
export function createCompositeGate(gates: readonly VerificationFn[]): VerificationFn {
  return async (ctx: GateContext): Promise<VerificationResult> => {
    const details: string[] = [];
    const allCompleted: string[] = [];
    let allPassed = true;

    for (const gate of gates) {
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

    return {
      passed: allPassed,
      details: details.join("; "),
      itemsCompleted: allCompleted.length > 0 ? allCompleted : undefined,
    };
  };
}
