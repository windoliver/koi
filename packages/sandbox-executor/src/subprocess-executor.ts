/**
 * Subprocess-based promoted executor — runs brick code in an isolated child process.
 *
 * Instead of executing via in-process `import()`, spawns a child Bun process
 * that loads the brick's entry module. This provides process-level isolation:
 * - Separate memory space (no access to host heap)
 * - Killable on timeout (SIGKILL, not just Promise.race)
 * - Restricted environment variables (only what's explicitly passed)
 * - Crash isolation (child OOM/segfault doesn't take down host)
 *
 * Falls back to in-process `new Function()` for bricks without entry files
 * (backward-compatible with existing behavior).
 */

import { join } from "node:path";
import type { ExecutionContext, SandboxError, SandboxExecutor, SandboxResult } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

interface SubprocessOutput {
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path to the subprocess runner script.
 * When running from source, import.meta.dir is `src/` and the runner is adjacent.
 * When imported from built output (dist/), fall back to the `src/` sibling directory.
 */
function resolveRunnerPath(): string {
  const adjacent = join(import.meta.dir, "subprocess-runner.ts");
  if (import.meta.dir.endsWith("/dist") || import.meta.dir.endsWith("\\dist")) {
    // Built output — resolve to src/ sibling
    return join(import.meta.dir, "..", "src", "subprocess-runner.ts");
  }
  return adjacent;
}

const RUNNER_PATH = resolveRunnerPath();

/** Maximum stdout size from subprocess (10 MB). Prevents OOM from malicious output. */
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

/** Environment variables safe to forward to child processes. */
const SAFE_ENV_KEYS = new Set(["PATH", "HOME", "TMPDIR", "NODE_ENV", "BUN_INSTALL"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSafeEnv(workspacePath?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // Add workspace's node_modules to NODE_PATH so imports resolve
  if (workspacePath !== undefined) {
    env.NODE_PATH = join(workspacePath, "node_modules");
  }
  return env;
}

function classifyError(e: unknown, durationMs: number): SandboxError {
  const message = e instanceof Error ? e.message : String(e);

  if (message.includes("timed out") || message.includes("SIGKILL")) {
    return { code: "TIMEOUT", message, durationMs };
  }
  if (message.includes("Permission denied") || message.includes("EACCES")) {
    return { code: "PERMISSION", message, durationMs };
  }
  if (message.includes("out of memory") || message.includes("OOM")) {
    return { code: "OOM", message, durationMs };
  }

  return { code: "CRASH", message, durationMs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type CompiledFn = (input: unknown) => unknown;

export function createSubprocessExecutor(): SandboxExecutor {
  const execute = async (
    code: string,
    input: unknown,
    timeoutMs: number,
    context?: ExecutionContext,
  ): Promise<ExecuteResult> => {
    const start = performance.now();

    // Subprocess path: when entryPath is available, run in child process
    if (context?.entryPath !== undefined) {
      try {
        const payload = JSON.stringify({ entryPath: context.entryPath, input });
        const env = buildSafeEnv(context.workspacePath);

        const proc = Bun.spawn(["bun", "run", RUNNER_PATH], {
          stdin: new Blob([payload]),
          stdout: "pipe",
          stderr: "pipe",
          env,
          ...(context.workspacePath !== undefined ? { cwd: context.workspacePath } : {}),
        });

        const timeoutId = setTimeout(() => {
          proc.kill("SIGKILL");
        }, timeoutMs);

        const exitCode = await proc.exited;
        clearTimeout(timeoutId);

        const stdout = await new Response(proc.stdout).text();
        const durationMs = performance.now() - start;

        if (stdout.length > MAX_STDOUT_BYTES) {
          return {
            ok: false,
            error: {
              code: "CRASH",
              message: `Subprocess output exceeded ${String(MAX_STDOUT_BYTES)} byte limit`,
              durationMs,
            },
          };
        }

        if (exitCode !== 0) {
          // Try to parse structured error from stdout
          try {
            const parsed = JSON.parse(stdout) as SubprocessOutput;
            if (parsed.error !== undefined) {
              return { ok: false, error: classifyError(new Error(parsed.error), durationMs) };
            }
          } catch (_: unknown) {
            // Fallback to stderr
          }

          const stderr = await new Response(proc.stderr).text();
          const errorMsg =
            stderr.length > 0 ? stderr : `Subprocess exited with code ${String(exitCode)}`;
          return { ok: false, error: classifyError(new Error(errorMsg), durationMs) };
        }

        // Parse structured output
        // let justified: result is parsed from stdout JSON
        let result: SubprocessOutput;
        try {
          result = JSON.parse(stdout) as SubprocessOutput;
        } catch (_: unknown) {
          return {
            ok: false,
            error: { code: "CRASH", message: "Failed to parse subprocess output", durationMs },
          };
        }

        if (!result.ok) {
          return {
            ok: false,
            error: classifyError(new Error(result.error ?? "Unknown subprocess error"), durationMs),
          };
        }

        return { ok: true, value: { output: result.output, durationMs } };
      } catch (e: unknown) {
        const durationMs = performance.now() - start;
        return { ok: false, error: classifyError(e, durationMs) };
      }
    }

    // Fallback: new Function() for bricks without entry files
    try {
      const fn = new Function("input", code) as CompiledFn;
      const result: unknown = await Promise.resolve(fn(input));
      const durationMs = performance.now() - start;
      return { ok: true, value: { output: result, durationMs } };
    } catch (e: unknown) {
      const durationMs = performance.now() - start;
      return { ok: false, error: classifyError(e, durationMs) };
    }
  };

  return { execute };
}
