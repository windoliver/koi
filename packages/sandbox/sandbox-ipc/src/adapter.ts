import type {
  ExecutionContext,
  SandboxError,
  SandboxExecutor,
  SandboxResult,
} from "@koi/core/sandbox-executor";
import { createSandboxBridge } from "./bridge.js";
import type { BridgeConfig, IpcError } from "./types.js";

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

      const bridge = await createSandboxBridge(config);

      try {
        const result = await bridge.execute(code, input, { timeoutMs, context });
        if (!result.ok) {
          return {
            ok: false,
            error: mapIpcErrorToSandboxError(result.error),
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
      } finally {
        await bridge.dispose();
      }
    },
  };
}
