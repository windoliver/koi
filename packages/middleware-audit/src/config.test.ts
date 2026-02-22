import { describe, expect, test } from "bun:test";
import { validateConfig } from "./config.js";
import { createInMemoryAuditSink } from "./sink.js";

describe("validateConfig", () => {
  const sink = createInMemoryAuditSink();

  test("accepts valid config with required fields", () => {
    const result = validateConfig({ sink });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined config", () => {
    const result = validateConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects config without sink", () => {
    const result = validateConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("sink");
  });

  test("rejects invalid maxEntrySize (zero)", () => {
    const result = validateConfig({ sink, maxEntrySize: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative maxEntrySize", () => {
    const result = validateConfig({ sink, maxEntrySize: -100 });
    expect(result.ok).toBe(false);
  });

  test("accepts positive maxEntrySize", () => {
    const result = validateConfig({ sink, maxEntrySize: 5000 });
    expect(result.ok).toBe(true);
  });

  test("accepts config with redaction rules", () => {
    const result = validateConfig({
      sink,
      redactionRules: [{ pattern: /secret/g, replacement: "[REDACTED]" }],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with all optional fields", () => {
    const result = validateConfig({
      sink,
      redactionRules: [],
      redactRequestBodies: true,
      maxEntrySize: 5000,
      onError: () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("all errors are non-retryable", () => {
    const result = validateConfig(null);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});
