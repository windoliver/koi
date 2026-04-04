import { describe, expect, test } from "bun:test";
import { createRedactor } from "./redactor.js";

describe("createRedactor", () => {
  test("creates a redactor with default config", () => {
    const r = createRedactor();
    expect(r.redactObject).toBeDefined();
    expect(r.redactString).toBeDefined();
  });

  test("throws on invalid config", () => {
    expect(() => createRedactor({ maxDepth: -1 })).toThrow("Invalid redaction config");
  });

  test("redactor is frozen", () => {
    const r = createRedactor();
    expect(Object.isFrozen(r)).toBe(true);
  });

  test("redactString detects JWT", () => {
    const r = createRedactor();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123";
    const result = r.redactString(`token: ${jwt}`);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("eyJ");
  });

  test("redactString returns identity for clean text", () => {
    const r = createRedactor();
    const result = r.redactString("Hello, world!");
    expect(result.changed).toBe(false);
    expect(result.text).toBe("Hello, world!");
  });

  test("redactObject redacts field names", () => {
    const r = createRedactor();
    const result = r.redactObject({ username: "alice", password: "s3cret!" });
    expect(result.changed).toBe(true);
    const v = result.value as Record<string, string>;
    expect(v.username).toBe("alice");
    expect(v.password).toBe("[REDACTED]");
    expect(result.fieldCount).toBe(1);
  });

  test("redactObject redacts secrets in values", () => {
    const r = createRedactor();
    const result = r.redactObject({ data: "key=AKIAIOSFODNN7EXAMPLE" });
    expect(result.changed).toBe(true);
    expect(result.secretCount).toBe(1);
  });

  test("config-time rejection: pattern that throws on probe inputs is rejected", () => {
    // A detector that always throws is rejected at config time (not at runtime).
    // This prevents the trivial bypass: throw on known probe inputs, hang on real traffic.
    const errors: unknown[] = [];
    expect(() =>
      createRedactor({
        onError: (e) => errors.push(e),
        patterns: [
          {
            name: "boom",
            kind: "boom",
            detect() {
              throw new Error("detector crash");
            },
          },
        ],
      }),
    ).toThrow("Invalid redaction config");
    // onError also called with the validation failure
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("fail-closed on redactObject error at runtime (probe-passing but real-input-crashing pattern)", () => {
    // A pattern that passes probes but crashes on actual real-world inputs
    // still triggers fail-closed at redaction time.
    const probeInputs = new Set([
      "a".repeat(50),
      "a]a]a]a]a]a]a]a]a]a]".repeat(5),
      `-----BEGIN a PRIVATE KEY-----${"x".repeat(50)}`,
      `eyJ${".".repeat(50)}`,
    ]);
    const errors: unknown[] = [];
    const r = createRedactor({
      onError: (e) => errors.push(e),
      patterns: [
        {
          name: "runtime-boom",
          kind: "runtime-boom",
          detect(input: string) {
            // Passes probes, crashes on everything else
            if (probeInputs.has(input)) return [];
            throw new Error("runtime crash on real input");
          },
        },
      ],
    });
    const result = r.redactObject({ data: "test" });
    expect(result.changed).toBe(true);
    expect(result.value as unknown).toBe("[REDACTION_FAILED]");
    expect(result.secretCount).toBe(-1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("fail-closed on redactString error at runtime (probe-passing pattern)", () => {
    const probeInputs = new Set([
      "a".repeat(50),
      "a]a]a]a]a]a]a]a]a]a]".repeat(5),
      `-----BEGIN a PRIVATE KEY-----${"x".repeat(50)}`,
      `eyJ${".".repeat(50)}`,
    ]);
    const errors: unknown[] = [];
    const r = createRedactor({
      onError: (e) => errors.push(e),
      patterns: [
        {
          name: "runtime-boom",
          kind: "runtime-boom",
          detect(input: string) {
            if (probeInputs.has(input)) return [];
            throw new Error("runtime crash");
          },
        },
      ],
    });
    const result = r.redactString("actual-secret");
    expect(result.changed).toBe(true);
    expect(result.text).toBe("[REDACTION_FAILED]");
    expect(result.matchCount).toBe(-1);
  });

  test("accepts custom patterns", () => {
    const r = createRedactor({
      customPatterns: [
        {
          name: "custom_secret",
          kind: "custom",
          detect(text) {
            const idx = text.indexOf("SECRET_");
            if (idx < 0) return [];
            return [{ text: text.slice(idx, idx + 20), start: idx, end: idx + 20, kind: "custom" }];
          },
        },
      ],
    });
    const result = r.redactString("data=SECRET_abc123xyzxyz");
    expect(result.changed).toBe(true);
    expect(result.text).toContain("[REDACTED]");
  });

  test("accepts custom censor function", () => {
    const r = createRedactor({
      censor: (match) => `<${match.kind}>`,
    });
    const result = r.redactString("key=AKIAIOSFODNN7EXAMPLE");
    expect(result.changed).toBe(true);
    expect(result.text).toContain("<aws_access_key>");
  });
});
