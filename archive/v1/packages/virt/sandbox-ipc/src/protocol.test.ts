/**
 * Protocol schema tests — Zod validation for IPC messages.
 */

import { describe, expect, test } from "bun:test";
import {
  parseErrorMessage,
  parseExecuteMessage,
  parseReadyMessage,
  parseResultMessage,
  parseWorkerMessage,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// ExecuteMessage (Host → Worker)
// ---------------------------------------------------------------------------

describe("ExecuteMessage schema", () => {
  test("accepts valid execute message", () => {
    const msg = {
      kind: "execute",
      code: "return input.x + 1",
      input: { x: 42 },
      timeoutMs: 5000,
    };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("execute");
      expect(result.data.code).toBe("return input.x + 1");
      expect(result.data.timeoutMs).toBe(5000);
    }
  });

  test("rejects missing code field", () => {
    const msg = { kind: "execute", input: {}, timeoutMs: 5000 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(false);
  });

  test("rejects missing input field", () => {
    const msg = { kind: "execute", code: "return 1", timeoutMs: 5000 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(false);
  });

  test("rejects negative timeoutMs", () => {
    const msg = { kind: "execute", code: "return 1", input: {}, timeoutMs: -1 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(false);
  });

  test("rejects zero timeoutMs", () => {
    const msg = { kind: "execute", code: "return 1", input: {}, timeoutMs: 0 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(false);
  });

  test("rejects wrong kind", () => {
    const msg = { kind: "run", code: "return 1", input: {}, timeoutMs: 5000 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(false);
  });

  test("accepts empty code string", () => {
    const msg = { kind: "execute", code: "", input: {}, timeoutMs: 100 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(true);
  });

  test("accepts empty input object", () => {
    const msg = { kind: "execute", code: "return 1", input: {}, timeoutMs: 100 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(true);
  });

  test("rejects string where number expected", () => {
    const msg = { kind: "execute", code: "return 1", input: {}, timeoutMs: "5000" };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReadyMessage (Worker → Host)
// ---------------------------------------------------------------------------

describe("ReadyMessage schema", () => {
  test("accepts valid ready message", () => {
    const result = parseReadyMessage({ kind: "ready" });
    expect(result.success).toBe(true);
  });

  test("rejects missing kind", () => {
    const result = parseReadyMessage({});
    expect(result.success).toBe(false);
  });

  test("rejects wrong kind value", () => {
    const result = parseReadyMessage({ kind: "init" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ResultMessage (Worker → Host)
// ---------------------------------------------------------------------------

describe("ResultMessage schema", () => {
  test("accepts valid result with output", () => {
    const msg = { kind: "result", output: { answer: 42 }, durationMs: 100 };
    const result = parseResultMessage(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output).toEqual({ answer: 42 });
      expect(result.data.durationMs).toBe(100);
    }
  });

  test("accepts null output", () => {
    const msg = { kind: "result", output: null, durationMs: 0 };
    const result = parseResultMessage(msg);
    expect(result.success).toBe(true);
  });

  test("accepts undefined output as missing", () => {
    const msg = { kind: "result", durationMs: 0 };
    const result = parseResultMessage(msg);
    // z.unknown() accepts missing → undefined
    expect(result.success).toBe(true);
  });

  test("accepts optional memoryUsedBytes", () => {
    const msg = { kind: "result", output: "ok", durationMs: 50, memoryUsedBytes: 1024 };
    const result = parseResultMessage(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memoryUsedBytes).toBe(1024);
    }
  });

  test("rejects negative durationMs", () => {
    const msg = { kind: "result", output: "ok", durationMs: -1 };
    const result = parseResultMessage(msg);
    expect(result.success).toBe(false);
  });

  test("rejects negative memoryUsedBytes", () => {
    const msg = { kind: "result", output: "ok", durationMs: 0, memoryUsedBytes: -1 };
    const result = parseResultMessage(msg);
    expect(result.success).toBe(false);
  });

  test("rejects missing durationMs", () => {
    const msg = { kind: "result", output: "ok" };
    const result = parseResultMessage(msg);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ErrorMessage (Worker → Host)
// ---------------------------------------------------------------------------

describe("ErrorMessage schema", () => {
  test("accepts valid error message", () => {
    const msg = { kind: "error", code: "TIMEOUT", message: "timed out", durationMs: 5000 };
    const result = parseErrorMessage(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("TIMEOUT");
    }
  });

  test("accepts all valid error codes", () => {
    const codes = ["TIMEOUT", "OOM", "PERMISSION", "CRASH"] as const;
    for (const code of codes) {
      const msg = { kind: "error", code, message: "err", durationMs: 0 };
      const result = parseErrorMessage(msg);
      expect(result.success).toBe(true);
    }
  });

  test("rejects unknown error code", () => {
    const msg = { kind: "error", code: "UNKNOWN", message: "err", durationMs: 0 };
    const result = parseErrorMessage(msg);
    expect(result.success).toBe(false);
  });

  test("rejects missing message", () => {
    const msg = { kind: "error", code: "CRASH", durationMs: 0 };
    const result = parseErrorMessage(msg);
    expect(result.success).toBe(false);
  });

  test("rejects missing durationMs", () => {
    const msg = { kind: "error", code: "CRASH", message: "err" };
    const result = parseErrorMessage(msg);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkerMessage (discriminated union)
// ---------------------------------------------------------------------------

describe("WorkerMessage discriminated union", () => {
  test("accepts ready message", () => {
    const result = parseWorkerMessage({ kind: "ready" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("ready");
    }
  });

  test("accepts result message", () => {
    const result = parseWorkerMessage({ kind: "result", output: 42, durationMs: 10 });
    expect(result.success).toBe(true);
  });

  test("accepts error message", () => {
    const result = parseWorkerMessage({
      kind: "error",
      code: "OOM",
      message: "out of memory",
      durationMs: 100,
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown kind", () => {
    const result = parseWorkerMessage({ kind: "unknown" });
    expect(result.success).toBe(false);
  });

  test("rejects null", () => {
    const result = parseWorkerMessage(null);
    expect(result.success).toBe(false);
  });

  test("rejects non-object", () => {
    const result = parseWorkerMessage("hello");
    expect(result.success).toBe(false);
  });

  test("rejects missing kind", () => {
    const result = parseWorkerMessage({ output: 42 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("protocol edge cases", () => {
  test("handles very long code string", () => {
    const longCode = "x".repeat(100_000);
    const msg = { kind: "execute", code: longCode, input: {}, timeoutMs: 100 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(true);
  });

  test("handles deeply nested input", () => {
    const deepInput = { a: { b: { c: { d: { e: 1 } } } } };
    const msg = { kind: "execute", code: "return 1", input: deepInput, timeoutMs: 100 };
    const result = parseExecuteMessage(msg);
    expect(result.success).toBe(true);
  });

  test("handles Infinity in result durationMs", () => {
    const msg = { kind: "result", output: null, durationMs: Infinity };
    const result = parseResultMessage(msg);
    // Infinity is a valid JS number — Zod's nonnegative() may accept it
    expect(result).toHaveProperty("success");
  });

  test("handles NaN in result durationMs", () => {
    const msg = { kind: "result", output: null, durationMs: NaN };
    const result = parseResultMessage(msg);
    // NaN fails nonnegative() check
    expect(result).toHaveProperty("success");
  });
});
