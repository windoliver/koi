/**
 * Worker-side functions for message parsing, code execution, and response formatting.
 *
 * Re-exports execution functions from worker-exec.ts (bundleable, zero deps)
 * and adds parseHostMessage (requires protocol.ts / Zod — not bundled).
 */

import type { Result } from "@koi/core";
import { parseExecuteMessage } from "./protocol.js";

export type { WorkerError, WorkerResponse, WorkerResult } from "./worker-exec.js";
// Re-export all execution functions and types from the zero-dep module.
// These are used by tests and by worker-entry.ts (bundled into WORKER_SCRIPT).
export { executeCode, formatError, formatResult } from "./worker-exec.js";

// ---------------------------------------------------------------------------
// Message parsing (not bundled into worker — uses Zod via protocol.ts)
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
