import type { JsonObject } from "@koi/core";
import type { SandboxError, SandboxResult } from "@koi/core/sandbox-executor";
import { createSandboxBridge } from "./bridge.js";
import type { BridgeConfig, IpcError, IpcErrorCode, SandboxBridge } from "./types.js";

/**
 * ExecutionContext shape supported by the IPC adapter. This is a strict
 * subset of `@koi/core` `ExecutionContext`: it deliberately omits
 * `entryPath` and `workspacePath` because the adapter wraps `code` as an
 * async function body and never imports a module file. Callers wanting full
 * module-source semantics should use `@koi/sandbox-executor`.
 */
export interface IpcExecutionContext {
  readonly networkAllowed?: boolean;
  readonly resourceLimits?: {
    readonly maxMemoryMb?: number;
    readonly maxPids?: number;
  };
  readonly env?: Readonly<Record<string, string>>;
}

export type IpcExecutorOutcome =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

/**
 * Narrowed executor surface returned by `bridgeToFunctionExecutor()`. The
 * method name (`executeFunctionBody`) and context type intentionally make
 * the function-body-only contract explicit, so this cannot be assigned to a
 * `SandboxExecutor` and silently lose `entryPath`/`workspacePath` semantics.
 */
export interface IpcSandboxExecutor {
  readonly executeFunctionBody: (
    code: string,
    input: unknown,
    timeoutMs: number,
    context?: IpcExecutionContext,
  ) => Promise<IpcExecutorOutcome>;
}

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
  // Wrap user code in an async IIFE so `await` works inside the body. The
  // outer worker compiles the entire payload as an `AsyncFunction`, and this
  // wrapper preserves async semantics for the caller's body too.
  return `return await (async function(input) {\n${code}\n})(input[${JSON.stringify(EXECUTOR_INPUT_KEY)}]);`;
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

export function bridgeToFunctionExecutor(
  config: BridgeConfig,
  options?: BridgeToExecutorOptions,
): IpcSandboxExecutor {
  const createBridge = options?.createBridge ?? createSandboxBridge;

  return {
    async executeFunctionBody(
      code: string,
      input: unknown,
      timeoutMs: number,
      context?: IpcExecutionContext,
    ): Promise<IpcExecutorOutcome> {
      // Defensive runtime check: even though `IpcExecutionContext` does not
      // declare `entryPath`/`workspacePath`, callers using `unknown`-typed
      // contexts could still pass them. Reject early with a clear pointer.
      const cast = context as { entryPath?: unknown; workspacePath?: unknown } | undefined;
      if (cast?.entryPath !== undefined || cast?.workspacePath !== undefined) {
        return {
          ok: false,
          error: {
            code: "CRASH",
            message:
              "sandbox-ipc bridgeToFunctionExecutor does not support entryPath/workspacePath. " +
              "Use @koi/sandbox-executor for module-source execution.",
            durationMs: 0,
          },
        };
      }

      // Reject module-style source up front. The adapter runs `code` via an
      // AsyncFunction body, which cannot accept top-level `import` or
      // `export` statements. Failing here gives the caller a clear pointer
      // to the right executor instead of an opaque worker CRASH.
      if (/^\s*(?:export\s|import\s)/m.test(code)) {
        return {
          ok: false,
          error: {
            code: "CRASH",
            message:
              "sandbox-ipc bridgeToFunctionExecutor expects an async function body, not module " +
              "source. Detected top-level `import`/`export`. Use @koi/sandbox-executor for " +
              "module execution.",
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
