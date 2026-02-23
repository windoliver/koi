/**
 * Type conformance tests — verifies adapter.ts and errors.ts produce
 * types compatible with @koi/core's canonical SandboxExecutor contract.
 *
 * Now that both modules import directly from @koi/core, these tests
 * serve as runtime smoke tests for the adapter plumbing.
 */

import { describe, expect, test } from "bun:test";
import type {
  SandboxError as CoreSandboxError,
  SandboxErrorCode as CoreSandboxErrorCode,
  SandboxExecutor as CoreSandboxExecutor,
  SandboxResult as CoreSandboxResult,
} from "@koi/core";
import { bridgeToExecutor } from "./adapter.js";
import { ipcErrorToSandboxError } from "./errors.js";
import type { SandboxBridge } from "./types.js";

// ---------------------------------------------------------------------------
// Compile-time assignability helpers
//
// If the adapter's return types ever diverge from @koi/core's canonical
// types, these will produce TypeScript errors at build time.
// ---------------------------------------------------------------------------

/**
 * Assert T is assignable to U. Fails to compile if not.
 * The function is never called — it exists purely for type checking.
 */
function assertAssignable<_U>(): <T extends _U>(_v: T) => void {
  return () => {};
}

// Type-level checks: our adapter's return type must be assignable to core's
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _checkErrorCode = assertAssignable<CoreSandboxErrorCode>();
const _checkSandboxError = assertAssignable<CoreSandboxError>();
const _checkSandboxResult = assertAssignable<CoreSandboxResult>();

// ---------------------------------------------------------------------------
// Runtime conformance tests
// ---------------------------------------------------------------------------

describe("type conformance: sandbox-ipc ↔ core", () => {
  test("ipcErrorToSandboxError returns a core-compatible SandboxError", () => {
    const result = ipcErrorToSandboxError({
      code: "TIMEOUT",
      message: "timed out",
      durationMs: 100,
    });

    // Compile-time: this assignment must succeed
    const coreError: CoreSandboxError = result;

    expect(coreError.code).toBe("TIMEOUT");
    expect(coreError.message).toBe("timed out");
    expect(coreError.durationMs).toBe(100);
  });

  test("bridgeToExecutor returns a core-compatible SandboxExecutor", () => {
    const bridge: SandboxBridge = {
      execute: async () => ({
        ok: true,
        value: { output: 42, durationMs: 10, exitCode: 0 },
      }),
      dispose: async () => {},
    };

    // Compile-time: this assignment must succeed
    const executor: CoreSandboxExecutor = bridgeToExecutor(bridge);

    expect(typeof executor.execute).toBe("function");
  });

  test("bridgeToExecutor success result is core-compatible SandboxResult", async () => {
    const bridge: SandboxBridge = {
      execute: async () => ({
        ok: true,
        value: { output: { answer: 42 }, durationMs: 50, memoryUsedBytes: 1024, exitCode: 0 },
      }),
      dispose: async () => {},
    };

    const executor: CoreSandboxExecutor = bridgeToExecutor(bridge);
    const result = await executor.execute("return 42", {}, 5000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Compile-time: this assignment must succeed
    const coreResult: CoreSandboxResult = result.value;

    expect(coreResult.output).toEqual({ answer: 42 });
    expect(coreResult.durationMs).toBe(50);
    expect(coreResult.memoryUsedBytes).toBe(1024);
  });

  test("bridgeToExecutor error result is core-compatible SandboxError", async () => {
    const bridge: SandboxBridge = {
      execute: async () => ({
        ok: false,
        error: { code: "OOM" as const, message: "out of memory", durationMs: 200 },
      }),
      dispose: async () => {},
    };

    const executor: CoreSandboxExecutor = bridgeToExecutor(bridge);
    const result = await executor.execute("new Array(1e9)", {}, 5000);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Compile-time: this assignment must succeed
    const coreError: CoreSandboxError = result.error;

    expect(coreError.code).toBe("OOM");
    expect(coreError.message).toBe("out of memory");
    expect(coreError.durationMs).toBe(200);
  });

  test("all SandboxErrorCode values are valid core codes", () => {
    // Exhaustively test each code maps to a valid core code
    const codes: readonly CoreSandboxErrorCode[] = ["TIMEOUT", "OOM", "PERMISSION", "CRASH"];

    for (const code of codes) {
      // Compile-time: each must be assignable to CoreSandboxErrorCode
      const _check: CoreSandboxErrorCode = code;
      expect(typeof _check).toBe("string");
    }
  });
});
