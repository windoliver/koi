/**
 * Subprocess-based SandboxExecutor implementation.
 *
 * Spawns a child Bun process running subprocess-runner.ts (dev) or
 * subprocess-runner.js (after build) to execute arbitrary code in isolation.
 *
 * Protocol:
 *   argv[2] = absolute path to a temp .ts file containing the code
 *   argv[3] = JSON-encoded input
 *   stderr  = __KOI_RESULT__\n<json>\n  (framed protocol output)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutionContext,
  SandboxError,
  SandboxErrorCode,
  SandboxExecutor,
  SandboxResult,
} from "@koi/core/sandbox-executor";

/** Framing marker emitted by subprocess-runner on stderr. */
const RESULT_MARKER = "__KOI_RESULT__\n";

/** Default maximum output bytes read from stderr (10 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Default bun executable name. */
const DEFAULT_BUN_PATH = "bun";

export interface SubprocessExecutorConfig {
  readonly bunPath?: string;
  readonly maxOutputBytes?: number;
  readonly cwd?: string;
}

/** Resolve the runner script path relative to this file's location. */
function resolveRunnerPath(): string {
  const here = import.meta.dir;
  const ext = here.endsWith("dist") ? "subprocess-runner.js" : "subprocess-runner.ts";
  return join(here, ext);
}

/** Write code to a temp file and return its path and the temp dir. */
function writeCodeToTemp(code: string): { readonly codePath: string; readonly tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "koi-sandbox-"));
  const codePath = join(tempDir, "code.ts");
  writeFileSync(codePath, code, "utf8");
  return { codePath, tempDir };
}

/** Clean up temp dir, ignoring errors. */
function cleanupTemp(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_: unknown) {
    // best-effort cleanup — ignore errors
  }
}

/** Parse the framed result from stderr text. Returns undefined if marker absent. */
function parseFramedResult(stderrText: string): unknown {
  const markerIdx = stderrText.lastIndexOf(RESULT_MARKER);
  if (markerIdx === -1) return undefined;
  const jsonStart = markerIdx + RESULT_MARKER.length;
  const jsonText = stderrText.slice(jsonStart).trimEnd();
  try {
    return JSON.parse(jsonText);
  } catch (_: unknown) {
    return undefined;
  }
}

/**
 * Type-predicate: checks that v is a non-null object with an "ok" field,
 * plus optional "output" and "error" fields — the framed result shape.
 * Avoids `as` casts when narrowing the raw JSON parse result.
 */
function isFramedObject(
  v: unknown,
): v is { readonly ok: unknown; readonly output?: unknown; readonly error?: unknown } {
  return v !== null && typeof v === "object" && "ok" in v;
}

/** Classify a killed process exit into a SandboxErrorCode. */
function classifyKilledCode(timerFired: boolean, exitCode: number): SandboxErrorCode {
  if (timerFired) return "TIMEOUT";
  // exitCode 137 = SIGKILL from outside (e.g. OOM killer), -9 = Bun internal
  if (exitCode === 137 || exitCode === -9) return "OOM";
  return "CRASH";
}

type ExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

export function createSubprocessExecutor(config?: SubprocessExecutorConfig): SandboxExecutor {
  const bunPath = config?.bunPath ?? DEFAULT_BUN_PATH;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const cwdOverride = config?.cwd;

  const runnerPath = resolveRunnerPath();

  return {
    execute: async (
      code: string,
      input: unknown,
      timeoutMs: number,
      _context?: ExecutionContext,
    ): Promise<ExecuteResult> => {
      const { codePath, tempDir } = writeCodeToTemp(code);
      const start = Date.now();

      // Fix 1: wrap everything after writeCodeToTemp in try/finally so the
      // temp dir is removed on every code path (including spawn rejection).
      try {
        const spawnOpts =
          cwdOverride !== undefined
            ? {
                stdout: "pipe" as const,
                stderr: "pipe" as const,
                // Fix 5: ignore stdin so the sandboxed child cannot read from parent's stdin
                stdin: "ignore" as const,
                cwd: cwdOverride,
              }
            : {
                stdout: "pipe" as const,
                stderr: "pipe" as const,
                // Fix 5: ignore stdin so the sandboxed child cannot read from parent's stdin
                stdin: "ignore" as const,
              };

        const proc = Bun.spawn(
          [bunPath, "run", runnerPath, codePath, JSON.stringify(input ?? null)],
          spawnOpts,
        );

        // Kill the process after timeout.
        // `let` justified: `killed` is a mutable flag set inside the timer callback.
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          proc.kill(9);
        }, timeoutMs);

        // Fix 6: use structural check to call unref() without NodeJS.Timeout cast.
        // Bun's Timer type does not expose `unref` in its declared types but the
        // underlying object supports it at runtime — check defensively.
        if ("unref" in timer && typeof timer.unref === "function") timer.unref();

        await proc.exited;
        clearTimeout(timer);

        const durationMs = Date.now() - start;

        // Fix 4: read FULL stderr before slicing. The result marker must be
        // searched in the complete text — truncating before the search would
        // miss markers that land past the cap and misclassify results as CRASH.
        const rawStderr = await new Response(proc.stderr).text();
        const exitCode = proc.exitCode ?? -1;

        // Killed or OOM
        if (killed || exitCode === 137 || exitCode === -9) {
          const errorCode: SandboxErrorCode = classifyKilledCode(killed, exitCode);
          const error: SandboxError = {
            code: errorCode,
            message:
              errorCode === "TIMEOUT"
                ? "Sandbox execution timed out"
                : "Sandbox process killed (OOM or signal)",
            durationMs,
          };
          return { ok: false, error };
        }

        // Fix 4 (continued): search marker in full text; only apply maxOutputBytes
        // to the stack snippet used in CRASH error messages.
        const framed = parseFramedResult(rawStderr);

        if (framed === undefined) {
          // Only cap the snippet, not the search input.
          const snippet = rawStderr.slice(-2000).slice(0, maxOutputBytes);
          const error: SandboxError = {
            code: "CRASH",
            message: "Sandbox exited without result marker",
            durationMs,
            stack: snippet,
          };
          return { ok: false, error };
        }

        // Fix 3: use isFramedObject type-predicate instead of `as Record<string, unknown>`
        if (!isFramedObject(framed)) {
          const error: SandboxError = {
            code: "CRASH",
            message: "Sandbox result marker contained invalid JSON",
            durationMs,
          };
          return { ok: false, error };
        }

        if (framed.ok === false) {
          const errMsg = typeof framed.error === "string" ? framed.error : "Unknown sandbox error";
          const error: SandboxError = {
            code: "CRASH",
            message: errMsg,
            durationMs,
          };
          return { ok: false, error };
        }

        const value: SandboxResult = {
          output: framed.output,
          durationMs,
        };
        return { ok: true, value };
      } finally {
        // Fix 1: always remove temp dir, even if spawn or stderr read throws.
        cleanupTemp(tempDir);
      }
    },
  };
}
