import { describe, expect, test } from "bun:test";

import type { SandboxAdapterResult } from "@koi/core";

import { normalizeResult } from "./normalize.js";

function makeResult(overrides: Partial<SandboxAdapterResult> = {}): SandboxAdapterResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 123,
    timedOut: false,
    oomKilled: false,
    ...overrides,
  };
}

describe("normalizeResult", () => {
  test("prioritizes TIMEOUT over CRASH", () => {
    const result = normalizeResult(makeResult({ timedOut: true, exitCode: 137 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.context?.durationMs).toBe(123);
    }
  });

  test("maps oomKilled to OOM", () => {
    const result = normalizeResult(makeResult({ oomKilled: true, exitCode: 137 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(String(result.error.context?.sandboxCode)).toBe("OOM");
      expect(result.error.context?.durationMs).toBe(123);
    }
  });

  test("prioritizes TIMEOUT over OOM when both are set", () => {
    const result = normalizeResult(makeResult({ timedOut: true, oomKilled: true, exitCode: 137 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.context?.durationMs).toBe(123);
    }
  });

  test.each([126, 127])("maps exitCode %i to PERMISSION", (exitCode) => {
    const result = normalizeResult(makeResult({ exitCode }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.context?.durationMs).toBe(123);
    }
  });

  test("maps exitCode 1 to CRASH", () => {
    const result = normalizeResult(makeResult({ exitCode: 1 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(String(result.error.context?.sandboxCode)).toBe("CRASH");
      expect(result.error.context?.durationMs).toBe(123);
    }
  });

  test("passes through exitCode 0", () => {
    const base = makeResult({ exitCode: 0 });

    expect(normalizeResult(base)).toEqual({ ok: true, value: base });
  });
});
