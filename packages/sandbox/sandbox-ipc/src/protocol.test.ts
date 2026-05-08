import { describe, expect, test } from "bun:test";
import {
  parseErrorMessage,
  parseExecuteMessage,
  parseReadyMessage,
  parseResultMessage,
  parseWorkerMessage,
} from "./protocol.js";

describe("parseReadyMessage", () => {
  test("accepts a ready frame", () => {
    const parsed = parseReadyMessage({ kind: "ready" });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected ready frame");
    expect(parsed.value).toEqual({ kind: "ready" });
  });

  test("rejects malformed ready input", () => {
    const parsed = parseReadyMessage({ kind: "init" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.name).toBe("SandboxIpcParseError");
    expect(parsed.error.message).toContain("kind");
  });
});

describe("parseExecuteMessage", () => {
  const VALID_NONCE = "n-12345";

  test("accepts an execute frame", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return input.value + 1;",
      input: { value: 41 },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected execute frame");
    expect(parsed.value.code).toBe("return input.value + 1;");
    expect(parsed.value.input).toEqual({ value: 41 });
    expect(parsed.value.timeoutMs).toBe(5_000);
    expect(parsed.value.nonce).toBe(VALID_NONCE);
  });

  test("accepts optional maxResultBytes and serialization", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
      maxResultBytes: 1_024,
      serialization: "json",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected execute frame");
    expect(parsed.value.maxResultBytes).toBe(1_024);
    expect(parsed.value.serialization).toBe("json");
  });

  test("rejects missing nonce", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      timeoutMs: 5_000,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("nonce");
  });

  test("rejects empty nonce", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      timeoutMs: 5_000,
      nonce: "",
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("nonce");
  });

  test("rejects unsupported serialization", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
      serialization: "xml",
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("serialization");
  });

  test("rejects non-positive maxResultBytes", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
      maxResultBytes: 0,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("maxResultBytes");
  });

  test("rejects malformed execute input", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      timeoutMs: 0,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("timeoutMs");
  });

  test("rejects missing code", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      input: { value: 1 },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("code");
  });

  test("rejects missing input", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("input");
  });

  test("rejects missing timeoutMs", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("timeoutMs");
  });

  test("rejects non-string code", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: 42,
      input: { value: 1 },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("code");
  });

  test("rejects non-json input", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { nested: () => 1 },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("input");
  });

  test("rejects non-finite numeric input values", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return input.value;",
      input: { value: Number.NaN },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.path).toBe("input");
    expect(parsed.error.reason).toContain("JSON value");
  });

  test("rejects non-plain object input values", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return input.when;",
      input: { when: new Date("2026-01-01T00:00:00.000Z") },
      timeoutMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.path).toBe("input");
    expect(parsed.error.reason).toContain("JSON value");
  });

  test("rejects string timeoutMs", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      timeoutMs: "500",
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("timeoutMs");
  });
});

describe("parseResultMessage", () => {
  const VALID_NONCE = "n-result";

  test("accepts a result frame", () => {
    const parsed = parseResultMessage({
      kind: "result",
      output: { answer: 42 },
      durationMs: 12,
      memoryUsedBytes: 256,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected result frame");
    expect(parsed.value.output).toEqual({ answer: 42 });
    expect(parsed.value.durationMs).toBe(12);
    expect(parsed.value.memoryUsedBytes).toBe(256);
    expect(parsed.value.nonce).toBe(VALID_NONCE);
  });

  test("rejects missing nonce", () => {
    const parsed = parseResultMessage({
      kind: "result",
      output: 1,
      durationMs: 1,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("nonce");
  });

  test("rejects malformed result input", () => {
    const parsed = parseResultMessage({
      kind: "result",
      output: "ok",
      durationMs: -1,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("durationMs");
  });

  test("rejects missing durationMs", () => {
    const parsed = parseResultMessage({
      kind: "result",
      output: { answer: 42 },
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("durationMs");
  });

  test("rejects string durationMs", () => {
    const parsed = parseResultMessage({
      kind: "result",
      output: { answer: 42 },
      durationMs: "12",
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("durationMs");
  });

  test("rejects string memoryUsedBytes", () => {
    const parsed = parseResultMessage({
      kind: "result",
      output: { answer: 42 },
      durationMs: 12,
      memoryUsedBytes: "256",
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("memoryUsedBytes");
  });
});

describe("parseErrorMessage", () => {
  const VALID_NONCE = "n-error";

  test("accepts an error frame", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "TIMEOUT",
      message: "execution timed out",
      durationMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected error frame");
    expect(parsed.value.code).toBe("TIMEOUT");
    expect(parsed.value.message).toBe("execution timed out");
    expect(parsed.value.durationMs).toBe(5_000);
    expect(parsed.value.nonce).toBe(VALID_NONCE);
  });

  test("accepts an error frame without durationMs", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "TIMEOUT",
      message: "execution timed out",
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected error frame");
    expect(parsed.value.code).toBe("TIMEOUT");
    expect(parsed.value.message).toBe("execution timed out");
    expect(parsed.value.durationMs).toBeUndefined();
  });

  test("rejects missing nonce", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "TIMEOUT",
      message: "execution timed out",
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("nonce");
  });

  test("rejects malformed error input", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "BOOM",
      message: "unsupported",
      durationMs: 1,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("code");
  });

  test("rejects missing code", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      message: "execution timed out",
      durationMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("code");
  });

  test("rejects missing message", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "TIMEOUT",
      durationMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("message");
  });

  test("rejects non-string message", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "TIMEOUT",
      message: 5_000,
      durationMs: 5_000,
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("message");
  });

  test("rejects string durationMs", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "TIMEOUT",
      message: "execution timed out",
      durationMs: "5_000",
      nonce: VALID_NONCE,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("durationMs");
  });
});

describe("parseWorkerMessage", () => {
  test("parses worker-ready frames", () => {
    const parsed = parseWorkerMessage({ kind: "ready" });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected worker frame");
    expect(parsed.value.kind).toBe("ready");
  });

  test("parses worker-result frames", () => {
    const parsed = parseWorkerMessage({
      kind: "result",
      output: { ok: true },
      durationMs: 9,
      nonce: "n-1",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected worker frame");
    expect(parsed.value.kind).toBe("result");
  });

  test("parses worker-error frames", () => {
    const parsed = parseWorkerMessage({
      kind: "error",
      code: "CRASH",
      message: "worker crashed",
      durationMs: 3,
      nonce: "n-1",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected worker frame");
    expect(parsed.value.kind).toBe("error");
  });

  test("rejects malformed worker input", () => {
    const parsed = parseWorkerMessage({ kind: "wat" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("kind");
  });

  test("preserves parser-specific error fields on worker parse failures", () => {
    const parsed = parseWorkerMessage({ kind: "wat" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.name).toBe("SandboxIpcParseError");
    expect(parsed.error.path).toBe("kind");
    expect(parsed.error.reason).toContain("expected one of");
  });
});
