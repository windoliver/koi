import { describe, expect, test } from "bun:test";
import type { SandboxError } from "@koi/core";
import {
  computeRemediation,
  enrichSandboxError,
  extractSnippet,
  sanitizeInput,
} from "./sandbox-error-enrichment.js";

// ---------------------------------------------------------------------------
// extractSnippet
// ---------------------------------------------------------------------------

describe("extractSnippet", () => {
  const impl = ["line1", "line2", "line3", "line4", "line5", "line6", "line7", "line8"].join("\n");

  test("extracts ±3 lines around error line from colon pattern", () => {
    const snippet = extractSnippet(impl, "Error at script:5:10");
    expect(snippet).toBeDefined();
    expect(snippet?.highlightLine).toBe(5);
    expect(snippet?.startLine).toBe(2);
    expect(snippet?.lines).toEqual(["line2", "line3", "line4", "line5", "line6", "line7", "line8"]);
  });

  test("extracts from 'line N' pattern", () => {
    const snippet = extractSnippet(impl, "Error on line 3 of script");
    expect(snippet).toBeDefined();
    expect(snippet?.highlightLine).toBe(3);
    expect(snippet?.startLine).toBe(1);
  });

  test("returns undefined when stack is undefined", () => {
    expect(extractSnippet(impl, undefined)).toBeUndefined();
  });

  test("returns undefined when no line number in stack", () => {
    expect(extractSnippet(impl, "some error without line info")).toBeUndefined();
  });

  test("clamps to start of file when error is on line 1", () => {
    const snippet = extractSnippet(impl, "Error at script:1:1");
    expect(snippet).toBeDefined();
    expect(snippet?.startLine).toBe(1);
    expect(snippet?.lines[0]).toBe("line1");
  });

  test("clamps to end of file when error is on last line", () => {
    const snippet = extractSnippet(impl, "Error at script:8:1");
    expect(snippet).toBeDefined();
    expect(snippet?.highlightLine).toBe(8);
    expect(snippet?.lines[snippet.lines.length - 1]).toBe("line8");
  });
});

// ---------------------------------------------------------------------------
// computeRemediation
// ---------------------------------------------------------------------------

describe("computeRemediation", () => {
  test("returns timeout advice for TIMEOUT", () => {
    expect(computeRemediation("TIMEOUT")).toContain("sandboxTimeoutMs");
  });

  test("returns memory advice for OOM", () => {
    expect(computeRemediation("OOM")).toContain("memory");
  });

  test("returns crash advice for CRASH", () => {
    expect(computeRemediation("CRASH")).toContain("runtime errors");
  });

  test("returns permission advice for PERMISSION", () => {
    expect(computeRemediation("PERMISSION")).toContain("sandbox restricts");
  });
});

// ---------------------------------------------------------------------------
// sanitizeInput
// ---------------------------------------------------------------------------

describe("sanitizeInput", () => {
  test("truncates long strings", () => {
    const long = "a".repeat(300);
    const result = sanitizeInput(long);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeLessThan(300);
    expect((result as string).endsWith("...[truncated]")).toBe(true);
  });

  test("passes short strings through unchanged", () => {
    expect(sanitizeInput("hello")).toBe("hello");
  });

  test("redacts keys matching sensitive pattern", () => {
    const input = { username: "alice", password: "s3cret", apiToken: "tok123" };
    const result = sanitizeInput(input) as Record<string, unknown>;
    expect(result.username).toBe("alice");
    expect(result.password).toBe("[REDACTED]");
    expect(result.apiToken).toBe("[REDACTED]");
  });

  test("handles nested objects up to depth 3", () => {
    const input = { a: { secretKey: "val", b: { authHeader: "bearer" } } };
    const result = sanitizeInput(input) as Record<string, Record<string, unknown>>;
    expect(result.a?.secretKey).toBe("[REDACTED]");
    expect((result.a?.b as Record<string, unknown>)?.authHeader).toBe("[REDACTED]");
  });

  test("returns primitives as-is", () => {
    expect(sanitizeInput(42)).toBe(42);
    expect(sanitizeInput(null)).toBeNull();
    expect(sanitizeInput(true)).toBe(true);
  });

  test("handles arrays", () => {
    const input = ["short", "a".repeat(300)];
    const result = sanitizeInput(input) as readonly string[];
    expect(result[0]).toBe("short");
    expect((result[1] ?? "").endsWith("...[truncated]")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enrichSandboxError (integration)
// ---------------------------------------------------------------------------

describe("enrichSandboxError", () => {
  test("composes all fields into enriched error", () => {
    const error: SandboxError = {
      code: "CRASH",
      message: "null ref",
      durationMs: 55,
      stack: "Error at script:2:5",
    };
    const impl = "const a = 1;\nconst b = null;\nb.foo();";
    const input = { password: "hunter2", data: "safe" };

    const enriched = enrichSandboxError(error, impl, input);

    expect(enriched.code).toBe("CRASH");
    expect(enriched.message).toBe("null ref");
    expect(enriched.durationMs).toBe(55);
    expect(enriched.stack).toBe("Error at script:2:5");
    expect(enriched.snippet).toBeDefined();
    expect(enriched.snippet?.highlightLine).toBe(2);
    expect(enriched.remediation).toContain("runtime errors");
    expect((enriched.sanitizedInput as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((enriched.sanitizedInput as Record<string, unknown>).data).toBe("safe");
  });

  test("omits stack and snippet when not available", () => {
    const error: SandboxError = {
      code: "TIMEOUT",
      message: "exceeded",
      durationMs: 5000,
    };
    const enriched = enrichSandboxError(error, "while(true){}", {});

    expect(enriched.stack).toBeUndefined();
    expect(enriched.snippet).toBeUndefined();
    expect(enriched.remediation).toContain("sandboxTimeoutMs");
  });
});
