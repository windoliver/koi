import { describe, expect, test } from "bun:test";
import {
  isModelChunk,
  isProcessState,
  validateNonEmpty,
  validateSessionIdSyntax,
} from "./validation-utils.js";

describe("isModelChunk", () => {
  test("accepts all valid chunk kinds", () => {
    expect(isModelChunk({ kind: "text_delta", delta: "hi" })).toBe(true);
    expect(isModelChunk({ kind: "thinking_delta", delta: "hmm" })).toBe(true);
    expect(isModelChunk({ kind: "tool_call_start", toolName: "read", callId: "tc1" })).toBe(true);
    expect(isModelChunk({ kind: "tool_call_delta", callId: "tc1", delta: "{}" })).toBe(true);
    expect(isModelChunk({ kind: "tool_call_end", callId: "tc1" })).toBe(true);
    expect(isModelChunk({ kind: "usage", inputTokens: 5, outputTokens: 3 })).toBe(true);
    expect(isModelChunk({ kind: "error", message: "oops" })).toBe(true);
    expect(isModelChunk({ kind: "done", response: { content: "ok", model: "m" } })).toBe(true);
  });

  test("rejects unknown kind", () => {
    expect(isModelChunk({ kind: "invented" })).toBe(false);
  });

  test("rejects missing required field", () => {
    expect(isModelChunk({ kind: "text_delta" })).toBe(false); // missing delta
    expect(isModelChunk({ kind: "tool_call_start", toolName: "read" })).toBe(false); // missing callId
    expect(isModelChunk({ kind: "usage", inputTokens: 5 })).toBe(false); // missing outputTokens
    expect(isModelChunk({ kind: "done", response: { model: "m" } })).toBe(false); // missing content
  });

  test("rejects non-object inputs", () => {
    expect(isModelChunk(null)).toBe(false);
    expect(isModelChunk("text_delta")).toBe(false);
    expect(isModelChunk(42)).toBe(false);
    expect(isModelChunk(undefined)).toBe(false);
  });

  test("permits unknown extra fields (forward-compatible)", () => {
    // Extra fields on known kinds should not cause rejection
    expect(isModelChunk({ kind: "text_delta", delta: "x", extraField: true })).toBe(true);
    expect(isModelChunk({ kind: "error", message: "x", code: "TIMEOUT", retryable: true })).toBe(
      true,
    );
  });
});

describe("validateSessionIdSyntax", () => {
  test("accepts valid alphanumeric session IDs", () => {
    expect(validateSessionIdSyntax("abc-123_XYZ").ok).toBe(true);
  });

  test("rejects empty string", () => {
    const result = validateSessionIdSyntax("");
    expect(result.ok).toBe(false);
  });

  test("rejects ID with invalid characters", () => {
    const result = validateSessionIdSyntax("has spaces");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});

describe("isProcessState", () => {
  test("returns true for all valid process states", () => {
    for (const state of ["created", "running", "waiting", "suspended", "idle", "terminated"]) {
      expect(isProcessState(state)).toBe(true);
    }
  });

  test("returns false for invalid strings", () => {
    expect(isProcessState("")).toBe(false);
    expect(isProcessState("RUNNING")).toBe(false);
    expect(isProcessState("unknown")).toBe(false);
    expect(isProcessState("paused")).toBe(false);
  });
});

describe("validateNonEmpty", () => {
  test("returns ok for non-empty strings", () => {
    const result = validateNonEmpty("hello", "Test");
    expect(result.ok).toBe(true);
  });

  test("returns VALIDATION error for empty string", () => {
    const result = validateNonEmpty("", "Field");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toBe("Field must not be empty");
    }
  });

  test("includes name in error message", () => {
    const result = validateNonEmpty("", "Agent ID");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Agent ID");
    }
  });
});
