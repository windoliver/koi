/**
 * Adapter conformance tests — verifies bridgeToExecutor() maps correctly.
 */

import { describe, expect, test } from "bun:test";
import { bridgeToExecutor } from "./adapter.js";
import { mapIpcErrorToSandbox } from "./errors.js";
import type { IpcError, IpcErrorCode, SandboxBridge } from "./types.js";

// ---------------------------------------------------------------------------
// Mock bridge factory
// ---------------------------------------------------------------------------

function mockBridge(overrides?: Partial<SandboxBridge>): SandboxBridge {
  return {
    execute: async (_code, _input, _options) => ({
      ok: true,
      value: { output: "ok", durationMs: 10, exitCode: 0 },
    }),
    dispose: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Error mapping conformance
// ---------------------------------------------------------------------------

describe("bridgeToExecutor error mapping", () => {
  const errorCodes: readonly IpcErrorCode[] = [
    "TIMEOUT",
    "OOM",
    "CRASH",
    "SPAWN_FAILED",
    "DESERIALIZE",
    "RESULT_TOO_LARGE",
    "WORKER_ERROR",
    "DISPOSED",
  ];

  type SandboxErrorCode = "TIMEOUT" | "OOM" | "PERMISSION" | "CRASH";
  const expectedSandboxCode: Readonly<Record<IpcErrorCode, SandboxErrorCode>> = {
    TIMEOUT: "TIMEOUT",
    OOM: "OOM",
    CRASH: "CRASH",
    SPAWN_FAILED: "CRASH",
    DESERIALIZE: "CRASH",
    RESULT_TOO_LARGE: "CRASH",
    WORKER_ERROR: "CRASH",
    DISPOSED: "CRASH",
  };

  for (const ipcCode of errorCodes) {
    test(`IpcError ${ipcCode} maps to SandboxError ${expectedSandboxCode[ipcCode]}`, async () => {
      const ipcError: IpcError = {
        code: ipcCode,
        message: `test ${ipcCode} error`,
        durationMs: 42,
      };

      const bridge = mockBridge({
        execute: async () => ({ ok: false, error: ipcError }),
      });

      const executor = bridgeToExecutor(bridge);
      const result = await executor.execute("return 1", {}, 5000);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe(expectedSandboxCode[ipcCode]);
      expect(result.error.durationMs).toBe(42);
    });
  }
});

// ---------------------------------------------------------------------------
// Success result mapping
// ---------------------------------------------------------------------------

describe("bridgeToExecutor success mapping", () => {
  test("maps output and durationMs correctly", async () => {
    const bridge = mockBridge({
      execute: async () => ({
        ok: true,
        value: { output: { answer: 42 }, durationMs: 100, exitCode: 0 },
      }),
    });

    const executor = bridgeToExecutor(bridge);
    const result = await executor.execute("return {answer: 42}", {}, 5000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.output).toEqual({ answer: 42 });
    expect(result.value.durationMs).toBe(100);
  });

  test("maps memoryUsedBytes when present", async () => {
    const bridge = mockBridge({
      execute: async () => ({
        ok: true,
        value: { output: "ok", durationMs: 50, memoryUsedBytes: 1024, exitCode: 0 },
      }),
    });

    const executor = bridgeToExecutor(bridge);
    const result = await executor.execute("return 'ok'", {}, 5000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoryUsedBytes).toBe(1024);
  });

  test("handles null output", async () => {
    const bridge = mockBridge({
      execute: async () => ({
        ok: true,
        value: { output: null, durationMs: 0, exitCode: 0 },
      }),
    });

    const executor = bridgeToExecutor(bridge);
    const result = await executor.execute("return null", null, 5000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.output).toBeNull();
  });

  test("coerces non-object input to empty object", async () => {
    let receivedInput: unknown;
    const bridge = mockBridge({
      execute: async (_code, input) => {
        receivedInput = input;
        return { ok: true, value: { output: "ok", durationMs: 0, exitCode: 0 } };
      },
    });

    const executor = bridgeToExecutor(bridge);
    await executor.execute("return 1", "not an object", 5000);

    expect(receivedInput).toEqual({});
  });

  test("passes timeoutMs to bridge options", async () => {
    let receivedOptions: unknown;
    const bridge = mockBridge({
      execute: async (_code, _input, options) => {
        receivedOptions = options;
        return { ok: true, value: { output: "ok", durationMs: 0, exitCode: 0 } };
      },
    });

    const executor = bridgeToExecutor(bridge);
    await executor.execute("return 1", {}, 3000);

    expect(receivedOptions).toEqual({ timeoutMs: 3000 });
  });
});

// ---------------------------------------------------------------------------
// mapIpcErrorToSandbox direct tests
// ---------------------------------------------------------------------------

describe("mapIpcErrorToSandbox", () => {
  test("uses 0 for missing durationMs", () => {
    const error: IpcError = { code: "CRASH", message: "boom" };
    const sandboxError = mapIpcErrorToSandbox(error);
    expect(sandboxError.durationMs).toBe(0);
  });

  test("preserves provided durationMs", () => {
    const error: IpcError = { code: "TIMEOUT", message: "slow", durationMs: 999 };
    const sandboxError = mapIpcErrorToSandbox(error);
    expect(sandboxError.durationMs).toBe(999);
  });
});
