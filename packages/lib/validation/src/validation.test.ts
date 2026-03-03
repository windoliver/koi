import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { validateWith, zodToKoiError } from "./validation.js";

const testSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
  tags: z.array(z.string()).optional(),
});

describe("zodToKoiError", () => {
  test("converts Zod error to KoiError with VALIDATION code", () => {
    const result = testSchema.safeParse({ name: "", age: -1 });
    if (result.success) throw new Error("Expected validation to fail");

    const koiError = zodToKoiError(result.error);

    expect(koiError.code).toBe("VALIDATION");
    expect(koiError.retryable).toBe(false);
    expect(koiError.message).toContain("Validation failed");
    expect(koiError.context).toBeDefined();
  });

  test("uses custom prefix in error message", () => {
    const result = testSchema.safeParse({ name: 123 });
    if (result.success) throw new Error("Expected validation to fail");

    const koiError = zodToKoiError(result.error, "Router config invalid");

    expect(koiError.message).toStartWith("Router config invalid:");
    expect(koiError.message).not.toContain("Validation failed");
  });

  test("preserves issue paths for nested errors", () => {
    const nested = z.object({
      config: z.object({
        timeout: z.number().positive(),
      }),
    });

    const result = nested.safeParse({ config: { timeout: -5 } });
    if (result.success) throw new Error("Expected validation to fail");

    const koiError = zodToKoiError(result.error);

    expect(koiError.message).toContain("config.timeout");
  });

  test("handles root-level errors with empty path", () => {
    const result = z.string().safeParse(42);
    if (result.success) throw new Error("Expected validation to fail");

    const koiError = zodToKoiError(result.error);

    expect(koiError.message).toContain("root:");
  });

  test("includes all issues in context", () => {
    const result = testSchema.safeParse({ name: "", age: -1 });
    if (result.success) throw new Error("Expected validation to fail");

    const koiError = zodToKoiError(result.error);
    const issues = (koiError.context as { readonly issues: readonly unknown[] })?.issues;

    expect(issues).toBeDefined();
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validateWith", () => {
  test("returns ok result for valid input", () => {
    const result = validateWith(testSchema, { name: "alice", age: 30 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.name).toBe("alice");
    expect(result.value.age).toBe(30);
  });

  test("returns ok result with optional fields", () => {
    const result = validateWith(testSchema, {
      name: "bob",
      age: 25,
      tags: ["admin", "user"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.tags).toEqual(["admin", "user"]);
  });

  test("returns error result for invalid input", () => {
    const result = validateWith(testSchema, { name: "", age: "not-a-number" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.retryable).toBe(false);
  });

  test("uses custom prefix in error message", () => {
    const result = validateWith(testSchema, null, "MCP config validation failed");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toStartWith("MCP config validation failed:");
  });

  test("returns error for null input", () => {
    const result = validateWith(testSchema, null);

    expect(result.ok).toBe(false);
  });

  test("returns error for undefined input", () => {
    const result = validateWith(testSchema, undefined);

    expect(result.ok).toBe(false);
  });
});
