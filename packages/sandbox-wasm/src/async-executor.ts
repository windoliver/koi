/**
 * Async QuickJS-in-Wasm sandbox executor.
 *
 * Like the sync executor (wasm-executor.ts), but supports async host functions
 * that can be called from within the guest sandbox. This is the foundation for
 * Code Mode's `callTool()` bridge.
 *
 * Uses the Emscripten asyncify variant of QuickJS. Asyncified host functions
 * appear **synchronous** to guest code — `callTool(name, args)` suspends the
 * Wasm stack, the host resolves the Promise, and Wasm resumes transparently.
 *
 * **Constraint:** asyncify supports only one pending suspension at a time.
 * Sequential host calls are fine; concurrent calls (Promise.all) are not.
 */

import type { SandboxError, SandboxErrorCode, SandboxResult } from "@koi/core";
import type { QuickJSAsyncContext, QuickJSAsyncRuntime } from "quickjs-emscripten-core";
import { getAsyncModule } from "./async-module-loader.js";
import { classifyError } from "./classify-error.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AsyncWasmSandboxConfig {
  /** Maximum heap memory in bytes. Default: 8MB. */
  readonly memoryLimitBytes?: number;
  /** Maximum stack size in bytes. Default: 512KB. */
  readonly maxStackSizeBytes?: number;
}

export type AsyncExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeInput(
  input: unknown,
  start: number,
):
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: SandboxError } {
  try {
    const json = JSON.stringify(input) ?? "undefined";
    return { ok: true, json };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Input is not JSON-serializable";
    return {
      ok: false,
      error: { code: "CRASH" as SandboxErrorCode, message, durationMs: performance.now() - start },
    };
  }
}

/**
 * Safely dispose a QuickJS object, swallowing errors from the asyncify variant's
 * internal host-ref cleanup. The asyncify build may throw "QuickJSRuntime not found"
 * or "Lifetime not alive" during disposal — these are non-fatal cleanup artifacts.
 */
function safeDispose(obj: { readonly alive: boolean; readonly dispose: () => void }): void {
  try {
    if (obj.alive) {
      obj.dispose();
    }
  } catch (_e: unknown) {
    // Asyncify variant may throw during host-ref cleanup. Safe to ignore since
    // the Wasm linear memory is released when the module is freed.
  }
}

/** Extract `memory_used_size` from a QuickJS memory usage dump. */
function extractMemoryUsed(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  if (!("memory_used_size" in raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  return typeof rec.memory_used_size === "number" ? rec.memory_used_size : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AsyncWasmExecutor {
  readonly execute: (
    code: string,
    input: unknown,
    timeoutMs: number,
    hostFunctions?: ReadonlyMap<string, (argsJson: string) => Promise<string>>,
  ) => Promise<AsyncExecuteResult>;
}

export function createAsyncWasmExecutor(config?: AsyncWasmSandboxConfig): AsyncWasmExecutor {
  const memoryLimitBytes = config?.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const maxStackSizeBytes = config?.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES;

  const execute = async (
    code: string,
    input: unknown,
    timeoutMs: number,
    hostFunctions?: ReadonlyMap<string, (argsJson: string) => Promise<string>>,
  ): Promise<AsyncExecuteResult> => {
    const module = await getAsyncModule();
    const start = performance.now();

    const serialized = serializeInput(input, start);
    if (!serialized.ok) return serialized;

    const runtime = module.newRuntime();
    try {
      runtime.setMemoryLimit(memoryLimitBytes);
      runtime.setMaxStackSize(maxStackSizeBytes);
      const deadline = start + timeoutMs;
      runtime.setInterruptHandler(() => performance.now() > deadline);

      const context = runtime.newContext();
      try {
        return await evaluateAsyncContext(
          context,
          runtime,
          code,
          serialized.json,
          start,
          hostFunctions,
        );
      } finally {
        safeDispose(context);
      }
    } finally {
      safeDispose(runtime);
    }
  };

  return { execute };
}

// ---------------------------------------------------------------------------
// Context evaluation (extracted to keep execute < 50 lines)
// ---------------------------------------------------------------------------

async function evaluateAsyncContext(
  context: QuickJSAsyncContext,
  runtime: QuickJSAsyncRuntime,
  code: string,
  inputJson: string,
  start: number,
  hostFunctions?: ReadonlyMap<string, (argsJson: string) => Promise<string>>,
): Promise<AsyncExecuteResult> {
  // Inject input as a global variable.
  const inputResult = context.evalCode(`const input = ${inputJson};`);
  if (inputResult.error) {
    inputResult.error.dispose();
    const durationMs = performance.now() - start;
    return {
      ok: false,
      error: { code: "CRASH", message: "Failed to inject input", durationMs },
    };
  }
  inputResult.value.dispose();

  // Register asyncified host functions. They appear synchronous to guest code:
  // `const result = hostFn(args)` — no await needed.
  // The asyncify variant requires handles stay alive during evalCodeAsync,
  // so we collect them and dispose after evaluation completes.
  const fnHandles: Array<{ readonly alive: boolean; readonly dispose: () => void }> = [];
  if (hostFunctions !== undefined) {
    for (const [name, fn] of hostFunctions) {
      // AsyncFunctionImplementation signature: (this: QuickJSHandle, ...args: QuickJSHandle[])
      // The `this` is the JS this-binding (TypeScript annotation), args are the actual arguments.
      const handle = context.newAsyncifiedFunction(name, async (...args) => {
        const firstArg = args[0];
        const argStr = firstArg !== undefined ? context.dump(firstArg) : "";
        for (const arg of args) {
          arg.dispose();
        }
        const resultStr = await fn(typeof argStr === "string" ? argStr : JSON.stringify(argStr));
        return context.newString(resultStr);
      });
      fnHandles.push(handle);
      context.setProp(context.global, name, handle);
    }
  }

  // Evaluate directly — last expression value is the result.
  // Asyncified functions are synchronous from the guest's perspective.
  const result = await context.evalCodeAsync(code);

  // Dispose function handles now that evaluation is complete.
  for (const handle of fnHandles) {
    if (handle.alive) {
      handle.dispose();
    }
  }

  if (result.error) {
    const dumped: unknown = context.dump(result.error);
    result.error.dispose();
    return { ok: false, error: classifyError(dumped, performance.now() - start) };
  }

  const output: unknown = context.dump(result.value);
  result.value.dispose();

  return buildSuccessResult(context, runtime, output, start);
}

function buildSuccessResult(
  context: QuickJSAsyncContext,
  runtime: QuickJSAsyncRuntime,
  output: unknown,
  start: number,
): AsyncExecuteResult {
  const memHandle = runtime.computeMemoryUsage();
  const memoryUsedBytes = extractMemoryUsed(context.dump(memHandle));
  memHandle.dispose();

  const durationMs = performance.now() - start;
  const value: SandboxResult =
    typeof memoryUsedBytes === "number"
      ? { output, durationMs, memoryUsedBytes }
      : { output, durationMs };

  return { ok: true, value };
}
