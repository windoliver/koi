/**
 * bridgeToExecutor() — Adapts SandboxBridge to forge's SandboxExecutor interface.
 *
 * This adapter allows the IPC bridge to be used as a drop-in replacement
 * for the SandboxExecutor dependency in @koi/forge's verification pipeline.
 */

import { ipcErrorToSandboxError } from "./errors.js";
import type { SandboxBridge } from "./types.js";

// ---------------------------------------------------------------------------
// SandboxExecutor types (duplicated from @koi/forge to avoid L2→L2 import)
// ---------------------------------------------------------------------------

type SandboxErrorCode = "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";

interface SandboxError {
  readonly code: SandboxErrorCode;
  readonly message: string;
  readonly durationMs: number;
}

interface SandboxResult {
  readonly output: unknown;
  readonly durationMs: number;
  readonly memoryUsedBytes?: number;
}

interface SandboxExecutor {
  readonly execute: (
    code: string,
    input: unknown,
    timeoutMs: number,
  ) => Promise<
    | { readonly ok: true; readonly value: SandboxResult }
    | { readonly ok: false; readonly error: SandboxError }
  >;
}

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
    ): Promise<
      | { readonly ok: true; readonly value: SandboxResult }
      | { readonly ok: false; readonly error: SandboxError }
    > => {
      // Coerce input to JsonObject — the bridge expects a record
      const safeInput: Readonly<Record<string, unknown>> = isJsonObject(input) ? input : {};

      const result = await bridge.execute(code, safeInput, { timeoutMs });

      if (!result.ok) {
        return {
          ok: false,
          error: ipcErrorToSandboxError(result.error),
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
