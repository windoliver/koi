/**
 * Built-in promoted-tier executor — runs code in-process via `new Function()`.
 *
 * No isolation — promoted tier runs with full process privileges.
 * Security gate is HITL approval in @koi/forge, not the executor.
 *
 * Uses a compilation cache keyed by code string to avoid repeated parsing.
 */

import type { SandboxError, SandboxExecutor, SandboxResult } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function classifyError(e: unknown, durationMs: number): SandboxError {
  const message = e instanceof Error ? e.message : String(e);

  if (message.includes("Permission denied") || message.includes("EACCES")) {
    return { code: "PERMISSION", message, durationMs };
  }

  return { code: "CRASH", message, durationMs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type CompiledFn = (input: unknown) => unknown;

export function createPromotedExecutor(): SandboxExecutor {
  const cache = new Map<string, CompiledFn>();

  const execute = async (
    code: string,
    input: unknown,
    _timeoutMs: number,
  ): Promise<ExecuteResult> => {
    const start = performance.now();

    try {
      let fn = cache.get(code);
      if (fn === undefined) {
        fn = new Function("input", code) as CompiledFn;
        cache.set(code, fn);
      }

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
