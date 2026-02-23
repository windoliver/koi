/**
 * Worker-side pure functions for message parsing, code execution, and response formatting.
 *
 * These functions are used inside the sandboxed worker process.
 * They are extracted here for testability — the worker script imports them.
 */

import type { Result } from "@koi/core";
import type { ErrorMessage, ResultMessage } from "./protocol.js";
import { parseExecuteMessage } from "./protocol.js";

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

export interface ExecuteRequest {
  readonly code: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export function parseHostMessage(raw: unknown): Result<ExecuteRequest, string> {
  const parsed = parseExecuteMessage(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid host message: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  const { code, input, timeoutMs } = parsed.data;
  return { ok: true, value: { code, input, timeoutMs } };
}

// ---------------------------------------------------------------------------
// Code execution
// ---------------------------------------------------------------------------

export type WorkerResponse =
  | {
      readonly kind: "result";
      readonly output: unknown;
      readonly durationMs: number;
      readonly memoryUsedBytes?: number;
    }
  | {
      readonly kind: "error";
      readonly code: "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";
      readonly message: string;
      readonly durationMs: number;
    };

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
    // new Function() is acceptable here: the OS sandbox is the trust boundary,
    // not JS-level isolation. The sandbox prevents file/network/process access.
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

export function formatResult(output: unknown, durationMs: number): ResultMessage {
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
): ErrorMessage {
  return {
    kind: "error",
    code,
    message,
    durationMs,
  };
}
