/**
 * Error creation and adapter tests — covers createIpcError() and mapIpcErrorToKoi().
 */

import { describe, expect, test } from "bun:test";
import type { KoiErrorCode } from "@koi/core";
import { createIpcError, mapIpcErrorToKoi } from "./errors.js";
import type { IpcError, IpcErrorCode } from "./types.js";

// ---------------------------------------------------------------------------
// createIpcError
// ---------------------------------------------------------------------------

describe("createIpcError", () => {
  test("creates error with code and message only", () => {
    const error = createIpcError("CRASH", "process died");
    expect(error.code).toBe("CRASH");
    expect(error.message).toBe("process died");
    expect(error.exitCode).toBeUndefined();
    expect(error.signal).toBeUndefined();
    expect(error.durationMs).toBeUndefined();
  });

  test("includes all optional fields when provided", () => {
    const error = createIpcError("OOM", "out of memory", {
      exitCode: 137,
      signal: "SIGKILL",
      durationMs: 500,
    });
    expect(error.exitCode).toBe(137);
    expect(error.signal).toBe("SIGKILL");
    expect(error.durationMs).toBe(500);
  });

  test("omits undefined optional fields from result", () => {
    const error = createIpcError("TIMEOUT", "timed out", { durationMs: 100 });
    expect(Object.keys(error)).not.toContain("exitCode");
    expect(Object.keys(error)).not.toContain("signal");
    expect(Object.keys(error)).toContain("durationMs");
  });
});

// ---------------------------------------------------------------------------
// mapIpcErrorToKoi — all IpcErrorCode variants
// ---------------------------------------------------------------------------

describe("mapIpcErrorToKoi", () => {
  const expectedMapping: Readonly<
    Record<IpcErrorCode, { koiCode: KoiErrorCode; retryable: boolean }>
  > = {
    TIMEOUT: { koiCode: "TIMEOUT", retryable: true },
    OOM: { koiCode: "EXTERNAL", retryable: false },
    CRASH: { koiCode: "EXTERNAL", retryable: false },
    SPAWN_FAILED: { koiCode: "EXTERNAL", retryable: true },
    DESERIALIZE: { koiCode: "INTERNAL", retryable: false },
    RESULT_TOO_LARGE: { koiCode: "VALIDATION", retryable: false },
    WORKER_ERROR: { koiCode: "EXTERNAL", retryable: false },
    DISPOSED: { koiCode: "INTERNAL", retryable: false },
  };

  const allCodes: readonly IpcErrorCode[] = [
    "TIMEOUT",
    "OOM",
    "CRASH",
    "SPAWN_FAILED",
    "DESERIALIZE",
    "RESULT_TOO_LARGE",
    "WORKER_ERROR",
    "DISPOSED",
  ];

  for (const ipcCode of allCodes) {
    const expected = expectedMapping[ipcCode];

    test(`${ipcCode} maps to KoiError code=${expected.koiCode}, retryable=${expected.retryable}`, () => {
      const ipcError: IpcError = {
        code: ipcCode,
        message: `test ${ipcCode}`,
        durationMs: 42,
      };

      const koiError = mapIpcErrorToKoi(ipcError);

      expect(koiError.code).toBe(expected.koiCode);
      expect(koiError.retryable).toBe(expected.retryable);
    });
  }

  test("message includes IPC error code and original message", () => {
    const ipcError: IpcError = {
      code: "TIMEOUT",
      message: "execution exceeded 5000ms",
    };

    const koiError = mapIpcErrorToKoi(ipcError);

    expect(koiError.message).toContain("TIMEOUT");
    expect(koiError.message).toContain("execution exceeded 5000ms");
  });

  test("message format is 'IPC bridge error [CODE]: original'", () => {
    const ipcError: IpcError = { code: "OOM", message: "out of memory" };
    const koiError = mapIpcErrorToKoi(ipcError);
    expect(koiError.message).toBe("IPC bridge error [OOM]: out of memory");
  });
});
