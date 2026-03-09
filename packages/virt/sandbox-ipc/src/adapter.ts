/**
 * bridgeToExecutor() — Adapts SandboxBridge to forge's SandboxExecutor interface.
 *
 * This adapter allows the IPC bridge to be used as a drop-in replacement
 * for the SandboxExecutor dependency in @koi/forge's verification pipeline.
 */

import type { ExecutionContext, SandboxError, SandboxExecutor, SandboxResult } from "@koi/core";
import { mapIpcErrorToSandbox } from "./errors.js";
import type { SandboxBridge } from "./types.js";

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function bridgeToExecutor(bridge: SandboxBridge): SandboxExecutor {
  return {
    execute: async (
      code: string,
      input: unknown,
      timeoutMs: number,
      context?: ExecutionContext,
    ): Promise<
      | { readonly ok: true; readonly value: SandboxResult }
      | { readonly ok: false; readonly error: SandboxError }
    > => {
      // Reject non-object input instead of silently coercing to {}.
      // The SandboxBridge expects JsonObject; callers passing arrays,
      // strings, or other primitives must be told explicitly.
      if (!isJsonObject(input)) {
        return {
          ok: false,
          error: {
            code: "CRASH",
            message: `SandboxExecutor input must be a plain object, got ${Array.isArray(input) ? "array" : typeof input}`,
            durationMs: 0,
          },
        };
      }

      const result = await bridge.execute(code, input, {
        timeoutMs,
        ...(context !== undefined ? { context } : {}),
      });

      if (!result.ok) {
        return {
          ok: false,
          error: mapIpcErrorToSandbox(result.error),
        };
      }

      return {
        ok: true,
        value: {
          output: result.value.output,
          durationMs: result.value.durationMs,
          ...(result.value.memoryUsedBytes !== undefined
            ? { memoryUsedBytes: result.value.memoryUsedBytes }
            : {}),
        },
      };
    },
  };
}
