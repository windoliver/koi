import type { JsonObject } from "@koi/core";
import type {
  ExecutionContext,
  SandboxError,
  SandboxExecutor,
  SandboxResult,
} from "@koi/core/sandbox-executor";
import { createSandboxBridge } from "./bridge.js";
import type { BridgeConfig, IpcError, IpcErrorCode, SandboxBridge } from "./types.js";

const EXECUTOR_INPUT_KEY = "__koi_executor_input";
const KNOWN_IPC_ERROR_CODES: ReadonlySet<IpcErrorCode> = new Set<IpcErrorCode>([
  "TIMEOUT",
  "OOM",
  "PERMISSION",
  "CRASH",
  "SPAWN_FAILED",
  "DESERIALIZE",
  "RESULT_TOO_LARGE",
  "WORKER_ERROR",
  "DISPOSED",
]);
const SYSTEM_PERMISSION_CODES = new Set(["EACCES", "EPERM"]);

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

function extractErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return String(error);
}

function wrapExecutorCode(code: string): string {
  return `return (function(input) {\n${code}\n})(input[${JSON.stringify(EXECUTOR_INPUT_KEY)}]);`;
}

function wrapExecutorInput(input: unknown): JsonObject {
  return {
    [EXECUTOR_INPUT_KEY]: input,
  } as JsonObject;
}

function isKnownIpcError(error: unknown): error is IpcError {
  if (
    error === null ||
    typeof error !== "object" ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !KNOWN_IPC_ERROR_CODES.has(error.code as IpcErrorCode) ||
    !("message" in error) ||
    typeof error.message !== "string"
  ) {
    return false;
  }

  return true;
}

function mapUnknownErrorToSandboxError(error: unknown): SandboxError {
  if (isKnownIpcError(error)) {
    return mapIpcErrorToSandboxError(error);
  }

  const code = extractErrorCode(error);
  const message = extractErrorMessage(error);
  if (code !== undefined && SYSTEM_PERMISSION_CODES.has(code)) {
    return {
      code: "PERMISSION",
      message,
      durationMs: 0,
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }

  return {
    code: "CRASH",
    message,
    durationMs: 0,
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  };
}

interface BridgeToExecutorOptions {
  readonly createBridge?: (config: BridgeConfig) => Promise<SandboxBridge> | SandboxBridge;
}

export function bridgeToExecutor(
  config: BridgeConfig,
  options?: BridgeToExecutorOptions,
): SandboxExecutor {
  const createBridge = options?.createBridge ?? createSandboxBridge;

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
      // Reject ExecutionContext fields the IPC adapter does not yet plumb
      // through end-to-end. The adapter wraps `code` as a function body via
      // `new Function`, so module-style entries and workspace-rooted execution
      // are not supported. Failing fast is safer than silently dropping them.
      if (context?.entryPath !== undefined || context?.workspacePath !== undefined) {
        return {
          ok: false,
          error: {
            code: "CRASH",
            message:
              "sandbox-ipc bridgeToExecutor does not support ExecutionContext.entryPath or " +
              "ExecutionContext.workspacePath. Use @koi/sandbox-executor for module-source execution.",
            durationMs: 0,
          },
        };
      }

      let bridge: SandboxBridge | undefined;
      let mappedResult:
        | { readonly ok: true; readonly value: SandboxResult }
        | { readonly ok: false; readonly error: SandboxError }
        | undefined;

      try {
        bridge = await createBridge(config);

        const result = await bridge.execute(wrapExecutorCode(code), wrapExecutorInput(input), {
          timeoutMs,
          context,
        });
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
            // A disposal failure must not flip a completed execution into a
            // failure: the user code already ran (and may have performed
            // non-idempotent side effects), so an upstream retry would
            // duplicate work. Only surface the cleanup error when execution
            // produced no result at all.
            if (mappedResult === undefined) {
              mappedResult = {
                ok: false,
                error: mapUnknownErrorToSandboxError(error),
              };
            }
          }
        }
      }

      return (
        mappedResult ?? {
          ok: false,
          error: {
            code: "CRASH",
            message: "sandbox-ipc bridgeToExecutor reached an unreachable state",
            durationMs: 0,
          },
        }
      );
    },
  };
}
