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

  test("replaces depth-exceeded subtrees with placeholder (fail-closed)", () => {
    const deep = { a: { b: { c: { password: "secret" } } } };
    const shallowCtx = { ...ctx, maxDepth: 2 };
    const result = walkAndRedact(deep, shallowCtx);
    // depth 0 -> root, depth 1 -> a, depth 2 -> b, depth 3 -> c (exceeds maxDepth=2)
    // c and everything below it should be replaced with a placeholder
    const innerB = (result.value as Record<string, Record<string, Record<string, unknown>>>).a?.b;
    expect(innerB?.c).toBe("[DEPTH_EXCEEDED]");
    expect(result.changed).toBe(true);
  });

  test("secrets nested beyond maxDepth are not leaked", () => {
    const deep = { a: { b: { c: { secret: "sk-ant-api03-" + "A".repeat(85) } } } };
    const shallowCtx = { ...ctx, maxDepth: 2 };
    const result = walkAndRedact(deep, shallowCtx);
    // Secret must NOT appear in the output
    expect(JSON.stringify(result.value)).not.toContain("sk-ant-api03-");
  });

  test("redacts numeric sensitive fields (e.g., pin, cvv)", () => {
    const numCtx = { ...ctx, fieldMatcher: createFieldMatcher(["pin", "cvv"]) };
    const obj = { pin: 1234, cvv: 567, amount: 100 };
    const result = walkAndRedact(obj, numCtx);
    expect((result.value as Record<string, unknown>).pin).toBe("[REDACTED]");
    expect((result.value as Record<string, unknown>).cvv).toBe("[REDACTED]");
    expect((result.value as Record<string, unknown>).amount).toBe(100);
    expect(result.fieldCount).toBe(2);
  });

  test("redacts object-valued sensitive fields", () => {
    const obj = { credential: { user: "admin", pass: "secret" }, name: "test" };
    const credCtx = { ...ctx, fieldMatcher: createFieldMatcher(["credential"]) };
    const result = walkAndRedact(obj, credCtx);
    expect((result.value as Record<string, unknown>).credential).toBe("[REDACTED]");
    expect((result.value as Record<string, unknown>).name).toBe("test");
  });

  test("preserves shared non-cyclic references instead of marking as Circular", () => {
    const shared = { key: "value" };
    const obj = { a: shared, b: shared };
    const result = walkAndRedact(obj, ctx);
    const v = result.value as Record<string, Record<string, string>>;
    // Both references should be preserved, not replaced with [Circular]
    expect(v.a?.key).toBe("value");
    expect(v.b?.key).toBe("value");
  });

  test("preserves non-secret __proto__ values but does not recurse into them", () => {
    const obj = Object.create(null) as Record<string, string>;
    obj.safe = "ok";
    obj.__proto__ = "malicious";
    const result = walkAndRedact(obj, ctx);
    // Non-secret value passes through scanning unchanged
    expect((result.value as Record<string, string>).__proto__).toBe("malicious");
  });

  test("redacts secrets hidden under __proto__ key", () => {
    const obj = Object.create(null) as Record<string, string>;
    obj.safe = "ok";
    obj.__proto__ =
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = walkAndRedact(obj, ctx);
    expect((result.value as Record<string, string>).__proto__).not.toContain("eyJhbGci");
    expect(result.changed).toBe(true);
    expect(result.secretCount).toBeGreaterThan(0);
  });
});
