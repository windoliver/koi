import { describe, expect, test } from "bun:test";
import { validatePermissionsConfig } from "../config.js";

const validBackend = { check: () => ({ effect: "allow" as const }) };

describe("validatePermissionsConfig", () => {
  test("accepts minimal valid config", () => {
    const result = validatePermissionsConfig({ backend: validBackend });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validatePermissionsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects non-object config", () => {
    const result = validatePermissionsConfig("string");
    expect(result.ok).toBe(false);
  });

  test("rejects missing backend", () => {
    const result = validatePermissionsConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("backend");
  });

  test("rejects backend without check method", () => {
    const result = validatePermissionsConfig({ backend: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("check");
  });

  test("rejects negative approvalTimeoutMs", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      approvalTimeoutMs: -1,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects zero approvalTimeoutMs", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      approvalTimeoutMs: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("accepts positive approvalTimeoutMs", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      approvalTimeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts Number.POSITIVE_INFINITY approvalTimeoutMs (unbounded approval window, #1759)", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      approvalTimeoutMs: Number.POSITIVE_INFINITY,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.approvalTimeoutMs).toBe(Number.POSITIVE_INFINITY);
      expect(Number.isFinite(result.value.approvalTimeoutMs)).toBe(false);
    }
  });

  // Cache config
  test("accepts cache: true", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      cache: true,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts cache: false", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      cache: false,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts valid cache config object", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      cache: { maxEntries: 512, allowTtlMs: 60_000, denyTtlMs: 5_000 },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects cache.maxEntries <= 0", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      cache: { maxEntries: 0 },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative cache.allowTtlMs", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      cache: { allowTtlMs: -1 },
    });
    expect(result.ok).toBe(false);
  });

  test("accepts zero allowTtlMs (no expiry)", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      cache: { allowTtlMs: 0 },
    });
    expect(result.ok).toBe(true);
  });

  // Approval cache config
  test("accepts approvalCache: true", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      approvalCache: true,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects approvalCache.maxEntries <= 0", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      approvalCache: { maxEntries: -1 },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative approvalCache.ttlMs", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      approvalCache: { ttlMs: -1 },
    });
    expect(result.ok).toBe(false);
  });

  // Audit sink
  test("accepts valid auditSink", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      auditSink: { log: async () => {} },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects auditSink without log", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      auditSink: {},
    });
    expect(result.ok).toBe(false);
  });

  // Circuit breaker
  test("accepts valid circuitBreaker config", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      circuitBreaker: {
        failureThreshold: 3,
        cooldownMs: 30_000,
        failureWindowMs: 60_000,
        failureStatusCodes: [],
      },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects circuitBreaker with non-positive failureThreshold", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      circuitBreaker: {
        failureThreshold: 0,
        cooldownMs: 30_000,
        failureWindowMs: 60_000,
        failureStatusCodes: [],
      },
    });
    expect(result.ok).toBe(false);
  });

  // Denial escalation config
  test("accepts denialEscalation: true", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      denialEscalation: true,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts denialEscalation: false", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      denialEscalation: false,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts valid denialEscalation config object", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      denialEscalation: { threshold: 5 },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts denialEscalation with no threshold (uses default)", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      denialEscalation: {},
    });
    expect(result.ok).toBe(true);
  });

  test("rejects denialEscalation.threshold <= 0", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      denialEscalation: { threshold: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("threshold");
  });

  test("rejects negative denialEscalation.threshold", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      denialEscalation: { threshold: -1 },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-object denialEscalation", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      denialEscalation: "yes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("denialEscalation");
  });

  // onApprovalStep callback
  test("accepts valid onApprovalStep function", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      onApprovalStep: () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("accepts undefined onApprovalStep", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      onApprovalStep: undefined,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects non-function onApprovalStep", () => {
    const result = validatePermissionsConfig({
      backend: validBackend,
      onApprovalStep: "not-a-function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("onApprovalStep");
  });

  test("all validation errors are non-retryable", () => {
    const result = validatePermissionsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});
