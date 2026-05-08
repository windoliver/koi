import type {
  ExecutionContext,
  SandboxError,
  SandboxExecutor,
  SandboxResult,
} from "@koi/core/sandbox-executor";
import { createSandboxBridge } from "./bridge.js";
import type { BridgeConfig, IpcError, SandboxBridge } from "./types.js";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapIpcErrorToSandboxError(error: IpcError): SandboxError {
  const durationMs = error.durationMs ?? 0;

  switch (error.code) {
    case "TIMEOUT":
      return { code: "TIMEOUT", message: error.message, durationMs };
    case "OOM":
      return { code: "OOM", message: error.message, durationMs };
    case "PERMISSION":
      return { code: "PERMISSION", message: error.message, durationMs };
    case "WORKER_ERROR":
    case "CRASH":
    case "DESERIALIZE":
    case "RESULT_TOO_LARGE":
    case "SPAWN_FAILED":
    case "DISPOSED":
      return { code: "CRASH", message: error.message, durationMs };
  }
}

function invalidInputError(input: unknown): SandboxError {
  return {
    code: "CRASH",
    message: `sandbox-ipc bridgeToExecutor expects a plain object input, got ${Array.isArray(input) ? "array" : typeof input}`,
    durationMs: 0,
  };
}

function mapUnknownErrorToSandboxError(error: unknown): SandboxError {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return mapIpcErrorToSandboxError(error as IpcError);
  }

  return {
    code: "CRASH",
    message: error instanceof Error ? error.message : String(error),
    durationMs: 0,
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  };
}

export function bridgeToExecutor(config: BridgeConfig): SandboxExecutor {
  return {
    async execute(
      code: string,
      input: unknown,
      timeoutMs: number,
      context?: ExecutionContext,
    ): Promise<
      | { readonly ok: true; readonly value: SandboxResult }
      | { readonly ok: false; readonly error: SandboxError }
    > {
      if (!isJsonObject(input)) {
        return { ok: false, error: invalidInputError(input) };
      }

      let bridge: SandboxBridge | undefined;
      let mappedResult:
        | { readonly ok: true; readonly value: SandboxResult }
        | { readonly ok: false; readonly error: SandboxError };

      try {
        bridge = await createSandboxBridge(config);

        const result = await bridge.execute(code, input, { timeoutMs, context });
        if (!result.ok) {
          mappedResult = {
            ok: false,
            error: mapIpcErrorToSandboxError(result.error),
          };
        } else {
          mappedResult = {
            ok: true,
            value: {
              output: result.value.output,
              durationMs: result.value.durationMs,
              ...(result.value.memoryUsedBytes !== undefined
                ? { memoryUsedBytes: result.value.memoryUsedBytes }
                : {}),
            },
          };
        }
      } catch (error) {
        return {
          ok: false,
          error: mapUnknownErrorToSandboxError(error),
        };
      } finally {
        if (bridge !== undefined) {
          try {
            await bridge.dispose();
          } catch (error) {
            mappedResult = {
              ok: false,
              error: mapUnknownErrorToSandboxError(error),
            };
          }
        }
      }

      return mappedResult;
    },
  };
}
