import { describe, expect, test } from "bun:test";
import { createFieldMatcher } from "./field-match.js";
import { createAWSDetector } from "./patterns/aws.js";
import { createJWTDetector } from "./patterns/jwt.js";
import type { SecretPattern } from "./types.js";
import { walkAndRedact } from "./walk.js";

const patterns: readonly SecretPattern[] = [createJWTDetector(), createAWSDetector()];
const fieldMatcher = createFieldMatcher(["password", "token", "apiKey"]);

const ctx = {
  patterns,
  fieldMatcher,
  censor: "redact" as const,
  fieldCensor: "redact" as const,
  maxDepth: 10,
  maxStringLength: 100_000,
};

describe("walkAndRedact", () => {
  test("passes through primitives unchanged", () => {
    expect(walkAndRedact(42, ctx).changed).toBe(false);
    expect(walkAndRedact(null, ctx).changed).toBe(false);
    expect(walkAndRedact(undefined, ctx).changed).toBe(false);
    expect(walkAndRedact(true, ctx).changed).toBe(false);
  });

  test("passes through clean strings unchanged", () => {
    const result = walkAndRedact("hello world", ctx);
    expect(result.changed).toBe(false);
    expect(result.value).toBe("hello world");
  });

  test("redacts field-name matches in objects", () => {
    const obj = { username: "alice", password: "s3cret!" };
    const result = walkAndRedact(obj, ctx);
    expect(result.changed).toBe(true);
    expect((result.value as Record<string, string>).username).toBe("alice");
    expect((result.value as Record<string, string>).password).toBe("[REDACTED]");
    expect(result.fieldCount).toBe(1);
    expect(result.secretCount).toBe(0);
  });

  test("redacts secrets in string values", () => {
    const obj = { data: "key=AKIAIOSFODNN7EXAMPLE" };
    const result = walkAndRedact(obj, ctx);
    expect(result.changed).toBe(true);
    expect((result.value as Record<string, string>).data).toContain("[REDACTED]");
    expect(result.secretCount).toBe(1);
  });

  test("handles nested objects", () => {
    const obj = { level1: { level2: { token: "secret-value" } } };
    const result = walkAndRedact(obj, ctx);
    expect(result.changed).toBe(true);
    const nested = (result.value as Record<string, Record<string, Record<string, string>>>).level1
      ?.level2;
    expect(nested?.token).toBe("[REDACTED]");
  });

  test("handles arrays", () => {
    const arr = ["clean", "AKIAIOSFODNN7EXAMPLE", "also clean"];
    const result = walkAndRedact(arr, ctx);
    expect(result.changed).toBe(true);
    expect((result.value as string[])[0]).toBe("clean");
    expect((result.value as string[])[1]).toContain("[REDACTED]");
    expect((result.value as string[])[2]).toBe("also clean");
  });

  test("preserves structural identity when unchanged", () => {
    const obj = { name: "alice", count: 42 };
    const result = walkAndRedact(obj, ctx);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(obj); // Same reference
  });

  test("detects circular references", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj.self = obj;
    const result = walkAndRedact(obj, ctx);
    expect(result.changed).toBe(true);
    expect((result.value as Record<string, unknown>).self).toBe("[Circular]");
  });

  test("respects maxDepth", () => {
    const deep = { a: { b: { c: { password: "secret" } } } };
    const shallowCtx = { ...ctx, maxDepth: 2 };
    const result = walkAndRedact(deep, shallowCtx);
    // Depth 0 -> a, depth 1 -> b, depth 2 -> c, depth 3 -> password (exceeds maxDepth=2)
    // The password field at depth 3 should NOT be redacted
    const innerC = (
      result.value as Record<string, Record<string, Record<string, Record<string, string>>>>
    ).a?.b?.c;
    expect(innerC?.password).toBe("secret");
  });

  test("skips __proto__ keys", () => {
    const obj = Object.create(null) as Record<string, string>;
    obj.safe = "ok";
    obj.__proto__ = "malicious";
    const result = walkAndRedact(obj, ctx);
    expect((result.value as Record<string, string>).__proto__).toBe("malicious");
  });
});
