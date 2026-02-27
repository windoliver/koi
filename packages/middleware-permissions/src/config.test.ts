import { describe, expect, test } from "bun:test";
import { validatePermissionsConfig } from "./config.js";
import { createPatternPermissionBackend } from "./engine.js";

describe("validatePermissionsConfig", () => {
  const backend = createPatternPermissionBackend({
    rules: { allow: ["*"], deny: [], ask: [] },
  });

  test("accepts valid config with required fields", () => {
    const result = validatePermissionsConfig({ backend });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.backend).toBe(backend);
    }
  });

  test("rejects null config", () => {
    const result = validatePermissionsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects undefined config", () => {
    const result = validatePermissionsConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects config without backend", () => {
    const result = validatePermissionsConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("backend");
    }
  });

  test("rejects backend without check method", () => {
    const result = validatePermissionsConfig({ backend: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("backend");
    }
  });

  test("rejects backend with non-function check", () => {
    const result = validatePermissionsConfig({ backend: { check: "not a function" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("check");
    }
  });

  test("rejects negative approvalTimeoutMs", () => {
    const result = validatePermissionsConfig({ backend, approvalTimeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("approvalTimeoutMs");
    }
  });

  test("rejects zero approvalTimeoutMs", () => {
    const result = validatePermissionsConfig({ backend, approvalTimeoutMs: 0 });
    expect(result.ok).toBe(false);
  });

  test("accepts positive approvalTimeoutMs", () => {
    const result = validatePermissionsConfig({ backend, approvalTimeoutMs: 5000 });
    expect(result.ok).toBe(true);
  });

  test("applies default values for optional fields", () => {
    const result = validatePermissionsConfig({ backend });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.approvalHandler).toBeUndefined();
      expect(result.value.approvalTimeoutMs).toBeUndefined();
      expect(result.value.cache).toBeUndefined();
    }
  });

  test("accepts cache: true", () => {
    const result = validatePermissionsConfig({ backend, cache: true });
    expect(result.ok).toBe(true);
  });

  test("accepts cache: { maxEntries: 100 }", () => {
    const result = validatePermissionsConfig({ backend, cache: { maxEntries: 100 } });
    expect(result.ok).toBe(true);
  });

  test("rejects cache with negative maxEntries", () => {
    const result = validatePermissionsConfig({ backend, cache: { maxEntries: -1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxEntries");
    }
  });

  test("rejects cache with zero maxEntries", () => {
    const result = validatePermissionsConfig({ backend, cache: { maxEntries: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxEntries");
    }
  });

  test("accepts cache with ttlMs: 0 (TTL disabled)", () => {
    const result = validatePermissionsConfig({ backend, cache: { ttlMs: 0 } });
    expect(result.ok).toBe(true);
  });

  test("accepts cache with positive ttlMs", () => {
    const result = validatePermissionsConfig({ backend, cache: { ttlMs: 60_000 } });
    expect(result.ok).toBe(true);
  });

  test("rejects cache with negative ttlMs", () => {
    const result = validatePermissionsConfig({ backend, cache: { ttlMs: -1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ttlMs");
    }
  });

  test("rejects cache with non-number ttlMs", () => {
    const result = validatePermissionsConfig({
      backend,
      cache: { ttlMs: "fast" as unknown as number },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ttlMs");
    }
  });

  test("accepts cache with both maxEntries and ttlMs", () => {
    const result = validatePermissionsConfig({
      backend,
      cache: { maxEntries: 100, ttlMs: 60_000 },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects cache with negative allowTtlMs", () => {
    const result = validatePermissionsConfig({ backend, cache: { allowTtlMs: -1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("allowTtlMs");
    }
  });

  test("rejects cache with negative denyTtlMs", () => {
    const result = validatePermissionsConfig({ backend, cache: { denyTtlMs: -1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("denyTtlMs");
    }
  });

  test("accepts valid auditSink", () => {
    const sink = { log: async () => {} };
    const result = validatePermissionsConfig({ backend, auditSink: sink });
    expect(result.ok).toBe(true);
  });

  test("rejects auditSink without log method", () => {
    const result = validatePermissionsConfig({ backend, auditSink: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("auditSink");
    }
  });

  test("accepts valid circuitBreaker config", () => {
    const result = validatePermissionsConfig({
      backend,
      circuitBreaker: {
        failureThreshold: 5,
        cooldownMs: 30_000,
        failureWindowMs: 60_000,
        failureStatusCodes: [],
      },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects non-object circuitBreaker", () => {
    const result = validatePermissionsConfig({ backend, circuitBreaker: "invalid" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("circuitBreaker");
    }
  });

  test("rejects circuitBreaker with missing required fields", () => {
    const result = validatePermissionsConfig({ backend, circuitBreaker: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("failureThreshold");
    }
  });

  test("all errors are non-retryable", () => {
    const result = validatePermissionsConfig(null);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });
});
