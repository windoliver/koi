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
  test("accepts an execute frame", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return input.value + 1;",
      input: { value: 41 },
      timeoutMs: 5_000,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected execute frame");
    expect(parsed.value.code).toBe("return input.value + 1;");
    expect(parsed.value.input).toEqual({ value: 41 });
    expect(parsed.value.timeoutMs).toBe(5_000);
  });

  test("rejects malformed execute input", () => {
    const parsed = parseExecuteMessage({
      kind: "execute",
      code: "return 1;",
      input: { value: 1 },
      timeoutMs: 0,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("timeoutMs");
  });
});

describe("parseResultMessage", () => {
  test("accepts a result frame", () => {
    const parsed = parseResultMessage({
      kind: "result",
      output: { answer: 42 },
      durationMs: 12,
      memoryUsedBytes: 256,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected result frame");
    expect(parsed.value.output).toEqual({ answer: 42 });
    expect(parsed.value.durationMs).toBe(12);
    expect(parsed.value.memoryUsedBytes).toBe(256);
  });

  test("rejects malformed result input", () => {
    const parsed = parseResultMessage({
      kind: "result",
      output: "ok",
      durationMs: -1,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("durationMs");
  });
});

describe("parseErrorMessage", () => {
  test("accepts an error frame", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "TIMEOUT",
      message: "execution timed out",
      durationMs: 5_000,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected error frame");
    expect(parsed.value.code).toBe("TIMEOUT");
    expect(parsed.value.message).toBe("execution timed out");
    expect(parsed.value.durationMs).toBe(5_000);
  });

  test("rejects malformed error input", () => {
    const parsed = parseErrorMessage({
      kind: "error",
      code: "BOOM",
      message: "unsupported",
      durationMs: 1,
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected parse failure");
    expect(parsed.error.message).toContain("code");
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
});
