import { describe, expect, test } from "bun:test";
import { createAWSDetector } from "./patterns/aws.js";
import { createBearerDetector } from "./patterns/bearer.js";
import { createJWTDetector } from "./patterns/jwt.js";
import { scanSecrets } from "./scan-string.js";
import type { SecretPattern } from "./types.js";

const patterns: readonly SecretPattern[] = [
  createJWTDetector(),
  createAWSDetector(),
  createBearerDetector(),
];

describe("scanSecrets", () => {
  test("returns identity for empty string", () => {
    const result = scanSecrets("", patterns, "redact", 100_000);
    expect(result.changed).toBe(false);
    expect(result.text).toBe("");
    expect(result.matchCount).toBe(0);
  });

  test("returns identity for clean text", () => {
    const result = scanSecrets("Hello, world! No secrets here.", patterns, "redact", 100_000);
    expect(result.changed).toBe(false);
    expect(result.matchCount).toBe(0);
  });

  test("detects and redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123";
    const text = `Authorization: Bearer ${jwt}`;
    const result = scanSecrets(text, [createJWTDetector()], "redact", 100_000);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("eyJ");
    expect(result.matchCount).toBeGreaterThanOrEqual(1);
  });

  test("detects and redacts an AWS key", () => {
    const text = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
    const result = scanSecrets(text, [createAWSDetector()], "redact", 100_000);
    expect(result.changed).toBe(true);
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("handles overlapping patterns — longest match wins", () => {
    // Bearer token contains a JWT — both patterns match, longest wins
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123";
    const text = `Bearer ${jwt}`;
    const result = scanSecrets(text, patterns, "redact", 100_000);
    expect(result.changed).toBe(true);
    // Should produce a single redaction (the longest match)
    expect(result.matchCount).toBe(1);
  });

  test("redacts oversized strings", () => {
    const result = scanSecrets("some text", patterns, "redact", 5);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("[REDACTED_OVERSIZED]");
  });

  test("applies mask censor strategy", () => {
    const text = "key=AKIAIOSFODNN7EXAMPLE";
    const result = scanSecrets(text, [createAWSDetector()], "mask", 100_000);
    expect(result.changed).toBe(true);
    expect(result.text).toContain("AKIA***");
  });
});
