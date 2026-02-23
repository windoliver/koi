/**
 * Pure execution functions for the sandboxed worker — zero imports.
 *
 * CRITICAL: This file must have NO imports from project packages or
 * external dependencies. It is bundled into a self-contained worker
 * script that runs inside the OS sandbox with no access to node_modules.
 *
 * Types are defined locally (structurally compatible with protocol.ts
 * ResultMessage / ErrorMessage) to avoid pulling in Zod transitively.
 */

// ---------------------------------------------------------------------------
// Response types (local — avoids protocol.ts → zod in bundle)
// ---------------------------------------------------------------------------

export interface WorkerResult {
  readonly kind: "result";
  readonly output: unknown;
  readonly durationMs: number;
}

export interface WorkerError {
  readonly kind: "error";
  readonly code: "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";
  readonly message: string;
  readonly durationMs: number;
}

export type WorkerResponse = WorkerResult | WorkerError;

// ---------------------------------------------------------------------------
// Code execution
// ---------------------------------------------------------------------------

/**
 * Execute user code in a sandboxed context with timeout protection.
 *
 * Uses `new Function()` which is acceptable here — the OS sandbox
 * (not JS-level isolation) is the trust boundary.
 *
 * @param onTimeout - Injectable timeout action for testing. Defaults to `process.exit(124)`.
 */
export async function executeCode(
  code: string,
  input: Readonly<Record<string, unknown>>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<WorkerResponse> {
  const startTime = performance.now();

  // Internal timeout watchdog — worker kills itself if execution exceeds deadline.
  // onTimeout is injectable for testing (avoids killing the test runner).
  const timeoutAction = onTimeout ?? (() => process.exit(124));
  const timeoutHandle = setTimeout(timeoutAction, timeoutMs);

  try {
    const fn = new Function("input", code) as (input: Readonly<Record<string, unknown>>) => unknown;
    const result = await Promise.resolve(fn(input));
    const durationMs = performance.now() - startTime;

    clearTimeout(timeoutHandle);
    return formatResult(result, durationMs);
  } catch (e: unknown) {
    const durationMs = performance.now() - startTime;
    clearTimeout(timeoutHandle);

    const message = e instanceof Error ? e.message : String(e);

    if (message.includes("Permission denied") || message.includes("EACCES")) {
      return formatError("PERMISSION", message, durationMs);
    }

    return formatError("CRASH", message, durationMs);
  }
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

export function formatResult(output: unknown, durationMs: number): WorkerResult {
  return {
    kind: "result",
    output,
    durationMs,
  };
}

export function formatError(
  code: "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH",
  message: string,
  durationMs: number,
): WorkerError {
  return {
    kind: "error",
    code,
    message,
    durationMs,
  };
}
