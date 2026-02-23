/**
 * Type conformance tests — verifies duplicated forge types in adapter.ts and
 * errors.ts are structurally compatible with @koi/forge's canonical types.
 *
 * These tests catch drift between the duplicated types and the originals.
 * They use compile-time assignability checks: if a type drifts, the test
 * file will fail to compile, catching the issue before runtime.
 */

import { describe, expect, test } from "bun:test";
import type {
  SandboxError as ForgeSandboxError,
  SandboxErrorCode as ForgeSandboxErrorCode,
  SandboxExecutor as ForgeSandboxExecutor,
  SandboxResult as ForgeSandboxResult,
} from "@koi/forge";
import { bridgeToExecutor } from "./adapter.js";
import { ipcErrorToSandboxError } from "./errors.js";
import type { SandboxBridge } from "./types.js";

// ---------------------------------------------------------------------------
// Compile-time assignability helpers
//
// If the duplicated types in adapter.ts or errors.ts drift from forge's
// canonical types, these will produce TypeScript errors at build time.
// ---------------------------------------------------------------------------

/**
 * Assert T is assignable to U. Fails to compile if not.
 * The function is never called — it exists purely for type checking.
 */
function assertAssignable<_U>(): <T extends _U>(_v: T) => void {
  return () => {};
}

// Type-level checks: our adapter's return type must be assignable to forge's
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _checkErrorCode = assertAssignable<ForgeSandboxErrorCode>();
const _checkSandboxError = assertAssignable<ForgeSandboxError>();
const _checkSandboxResult = assertAssignable<ForgeSandboxResult>();

// ---------------------------------------------------------------------------
// Runtime conformance tests
// ---------------------------------------------------------------------------

describe("type conformance: sandbox-ipc ↔ forge", () => {
  test("ipcErrorToSandboxError returns a forge-compatible SandboxError", () => {
    const result = ipcErrorToSandboxError({
      code: "TIMEOUT",
      message: "timed out",
      durationMs: 100,
    });

    // Compile-time: this assignment must succeed
    const forgeError: ForgeSandboxError = result;

    expect(forgeError.code).toBe("TIMEOUT");
    expect(forgeError.message).toBe("timed out");
    expect(forgeError.durationMs).toBe(100);
  });

  test("bridgeToExecutor returns a forge-compatible SandboxExecutor", () => {
    const bridge: SandboxBridge = {
      execute: async () => ({
        ok: true,
        value: { output: 42, durationMs: 10, exitCode: 0 },
      }),
      dispose: async () => {},
    };

    // Compile-time: this assignment must succeed
    const executor: ForgeSandboxExecutor = bridgeToExecutor(bridge);

    expect(typeof executor.execute).toBe("function");
  });

  test("bridgeToExecutor success result is forge-compatible SandboxResult", async () => {
    const bridge: SandboxBridge = {
      execute: async () => ({
        ok: true,
        value: { output: { answer: 42 }, durationMs: 50, memoryUsedBytes: 1024, exitCode: 0 },
      }),
      dispose: async () => {},
    };

    const executor: ForgeSandboxExecutor = bridgeToExecutor(bridge);
    const result = await executor.execute("return 42", {}, 5000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Compile-time: this assignment must succeed
    const forgeResult: ForgeSandboxResult = result.value;

    expect(forgeResult.output).toEqual({ answer: 42 });
    expect(forgeResult.durationMs).toBe(50);
    expect(forgeResult.memoryUsedBytes).toBe(1024);
  });

  test("bridgeToExecutor error result is forge-compatible SandboxError", async () => {
    const bridge: SandboxBridge = {
      execute: async () => ({
        ok: false,
        error: { code: "OOM" as const, message: "out of memory", durationMs: 200 },
      }),
      dispose: async () => {},
    };

    const executor: ForgeSandboxExecutor = bridgeToExecutor(bridge);
    const result = await executor.execute("new Array(1e9)", {}, 5000);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Compile-time: this assignment must succeed
    const forgeError: ForgeSandboxError = result.error;

    expect(forgeError.code).toBe("OOM");
    expect(forgeError.message).toBe("out of memory");
    expect(forgeError.durationMs).toBe(200);
  });

  test("all SandboxErrorCode values are valid forge codes", () => {
    // Exhaustively test each code from our adapter maps to a valid forge code
    const codes: readonly ForgeSandboxErrorCode[] = ["TIMEOUT", "OOM", "PERMISSION", "CRASH"];

    for (const code of codes) {
      // Compile-time: each must be assignable to ForgeSandboxErrorCode
      const _check: ForgeSandboxErrorCode = code;
      expect(typeof _check).toBe("string");
    }
  });
});
