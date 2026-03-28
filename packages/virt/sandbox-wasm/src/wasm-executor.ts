/**
 * QuickJS-in-Wasm sandbox executor.
 *
 * Runs untrusted JavaScript in a fresh QuickJS runtime per call.
 * Wasm linear memory boundary provides strong isolation — no access to
 * host globals (fetch, process, require, Bun, etc.).
 *
 * Each `execute()` call creates a new runtime + context and disposes
 * both afterward, ensuring zero state leakage between invocations.
 */

import type { SandboxError, SandboxExecutor, SandboxResult } from "@koi/core";
import { getSpanRecorder } from "@koi/execution-context";
import type { QuickJSContext, QuickJSRuntime } from "quickjs-emscripten-core";
import { classifyError } from "./classify-error.js";
import { getModule } from "./module-loader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WasmSandboxConfig {
  /** Maximum heap memory in bytes. Default: 4MB. */
  readonly memoryLimitBytes?: number;
  /** Maximum stack size in bytes. Default: 512KB. */
  readonly maxStackSizeBytes?: number;
}

type ExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MEMORY_LIMIT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STACK_SIZE_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely serialize input to a JSON string for injection into QuickJS.
 * Returns "undefined" for values JSON cannot represent (undefined, functions, symbols).
 * Returns an error result for values that cause JSON.stringify to throw (BigInt, circular).
 */
function serializeInput(
  input: unknown,
  start: number,
):
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: SandboxError } {
  try {
    // JSON.stringify returns `undefined` (not a string) for bare undefined,
    // function, and Symbol values. The ?? fallback produces valid JS "undefined".
    const json = JSON.stringify(input) ?? "undefined";
    return { ok: true, json };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Input is not JSON-serializable";
    return {
      ok: false,
      error: { code: "CRASH", message, durationMs: performance.now() - start },
    };
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

export function createWasmSandboxExecutor(config?: WasmSandboxConfig): SandboxExecutor {
  const memoryLimitBytes = config?.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const maxStackSizeBytes = config?.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES;

  const execute = async (
    code: string,
    input: unknown,
    timeoutMs: number,
  ): Promise<ExecuteResult> => {
    const module = await getModule();
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
        const result = evaluateInContext(context, runtime, code, serialized.json, start);
        const recorder = getSpanRecorder();
        if (recorder !== undefined) {
          const memoryUsedBytes = result.ok ? result.value.memoryUsedBytes : undefined;
          recorder.record({
            label: "sandbox-wasm",
            durationMs: performance.now() - start,
            ...(result.ok ? {} : { error: result.error.message }),
            ...(memoryUsedBytes !== undefined ? { metadata: { memoryUsedBytes } } : {}),
          });
        }
        return result;
      } finally {
        context.dispose();
      }
    } finally {
      runtime.dispose();
    }
  };

  return { execute };
}

// ---------------------------------------------------------------------------
// Context evaluation (extracted to keep execute < 50 lines)
// ---------------------------------------------------------------------------

function evaluateInContext(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  code: string,
  inputJson: string,
  start: number,
): ExecuteResult {
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

  // Evaluate the user code.
  const result = context.evalCode(code);
  if (result.error) {
    const dumped: unknown = context.dump(result.error);
    result.error.dispose();
    return { ok: false, error: classifyError(dumped, performance.now() - start) };
  }

  const output: unknown = context.dump(result.value);
  result.value.dispose();

  // Extract memory usage.
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
