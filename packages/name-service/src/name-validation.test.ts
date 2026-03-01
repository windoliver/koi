import { describe, expect, test } from "bun:test";
import { validateName } from "./name-validation.js";

describe("validateName", () => {
  test("accepts valid simple names", () => {
    expect(validateName("reviewer")).toEqual({ ok: true, value: "reviewer" });
    expect(validateName("code-reviewer")).toEqual({ ok: true, value: "code-reviewer" });
    expect(validateName("agent1")).toEqual({ ok: true, value: "agent1" });
    expect(validateName("my-agent-v2")).toEqual({ ok: true, value: "my-agent-v2" });
  });

  test("rejects empty name", () => {
    const result = validateName("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("empty");
    }
  });

  test("rejects names starting with a digit", () => {
    const result = validateName("1agent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects names starting with a hyphen", () => {
    const result = validateName("-agent");
    expect(result.ok).toBe(false);
  });

  test("rejects names with uppercase letters", () => {
    const result = validateName("CodeReviewer");
    expect(result.ok).toBe(false);
  });

  test("rejects names with colons", () => {
    const result = validateName("agent:reviewer");
    expect(result.ok).toBe(false);
  });

  test("rejects names with spaces", () => {
    const result = validateName("code reviewer");
    expect(result.ok).toBe(false);
  });

  test("rejects names with underscores", () => {
    const result = validateName("code_reviewer");
    expect(result.ok).toBe(false);
  });

  test("rejects names exceeding max length", () => {
    const longName = `a${"b".repeat(128)}`;
    const result = validateName(longName);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("128");
    }
  });

  test("accepts single-letter name", () => {
    expect(validateName("a")).toEqual({ ok: true, value: "a" });
  });

  test("error is non-retryable", () => {
    const result = validateName("");
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });
});
