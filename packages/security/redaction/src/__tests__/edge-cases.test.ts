import { describe, expect, test } from "bun:test";
import { createRedactor } from "../redactor.js";

describe("edge cases", () => {
  const r = createRedactor();

  test("circular references produce [Circular] placeholder", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj.self = obj;
    const result = r.redactObject(obj);
    expect(result.changed).toBe(true);
    expect((result.value as Record<string, unknown>).self).toBe("[Circular]");
    expect((result.value as Record<string, unknown>).name).toBe("test");
  });

  test("prototype pollution keys are skipped", () => {
    const obj = Object.create(null) as Record<string, string>;
    obj.safe = "ok";
    // biome-ignore lint/complexity/useLiteralKeys: testing __proto__ key specifically
    obj["__proto__"] = "password=secret";
    // biome-ignore lint/complexity/useLiteralKeys: testing constructor key specifically
    obj["constructor"] = "should-not-walk";
    const result = r.redactObject(obj);
    // __proto__ and constructor values are preserved but not recursed into
    expect((result.value as Record<string, string>).safe).toBe("ok");
  });

  test("deep nesting beyond maxDepth is replaced with placeholder (fail-closed)", () => {
    const r2 = createRedactor({ maxDepth: 2 });
    const deep = { a: { b: { c: { password: "secret" } } } };
    const result = r2.redactObject(deep);
    // depth 0 -> root, depth 1 -> a, depth 2 -> b, depth 3 -> c exceeds maxDepth=2
    const innerB = (result.value as Record<string, Record<string, Record<string, unknown>>>).a?.b;
    expect(innerB?.c).toBe("[DEPTH_EXCEEDED]"); // Fail-closed — subtree replaced
    expect(result.changed).toBe(true);
  });

  test("overlapping patterns resolve to longest match", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123";
    const text = `Bearer ${jwt}`;
    const result = r.redactString(text);
    expect(result.changed).toBe(true);
    // Should be one redaction, not two
    expect(result.matchCount).toBe(1);
  });

  test("empty string returns unchanged", () => {
    const result = r.redactString("");
    expect(result.changed).toBe(false);
    expect(result.text).toBe("");
  });

  test("null and undefined pass through unchanged", () => {
    const resultNull = r.redactObject(null);
    expect(resultNull.changed).toBe(false);
    expect(resultNull.value).toBe(null);

    const resultUndefined = r.redactObject(undefined);
    expect(resultUndefined.changed).toBe(false);
    expect(resultUndefined.value).toBe(undefined);
  });

  test("partial pattern match does not produce false positives", () => {
    // "AKIA" prefix but not enough chars after
    const result = r.redactString("AKIA1234");
    expect(result.changed).toBe(false);
  });

  test("unicode in values is handled correctly", () => {
    const obj = { password: "geheim\u00e9\u{1F512}", name: "\u{1F600} hello" };
    const result = r.redactObject(obj);
    expect(result.changed).toBe(true);
    expect((result.value as Record<string, string>).password).toBe("[REDACTED]");
    expect((result.value as Record<string, string>).name).toBe("\u{1F600} hello");
  });

  test("large string exceeding maxStringLength is redacted", () => {
    const r2 = createRedactor({ maxStringLength: 100 });
    const longString = "a".repeat(200);
    const result = r2.redactString(longString);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("[REDACTED_OVERSIZED]");
  });

  test("ReDoS resistance — built-in patterns complete quickly on adversarial input", () => {
    const adversarial = "a".repeat(10_000);
    const start = performance.now();
    r.redactString(adversarial);
    const elapsed = performance.now() - start;
    // Should complete in well under 100ms even on slow hardware
    expect(elapsed).toBeLessThan(100);
  });

  test("mixed field-name and value-pattern on same object", () => {
    const obj = {
      token: "my-token-value", // field-name match
      data: "AKIAIOSFODNN7EXAMPLE", // value-pattern match
    };
    const result = r.redactObject(obj);
    expect(result.changed).toBe(true);
    const v = result.value as Record<string, string>;
    expect(v.token).toBe("[REDACTED]"); // field-name match
    expect(v.data).toContain("[REDACTED]"); // value-pattern match
    expect(result.fieldCount).toBe(1);
    expect(result.secretCount).toBe(1);
  });
});
