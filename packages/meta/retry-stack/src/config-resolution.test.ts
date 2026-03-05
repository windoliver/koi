/**
 * Unit tests for retry-stack config resolution.
 */

import { describe, expect, test } from "bun:test";
import { resolveRetryStackConfig } from "./config-resolution.js";

describe("resolveRetryStackConfig", () => {
  test("defaults to standard preset", () => {
    const resolved = resolveRetryStackConfig({});
    expect(resolved.preset).toBe("standard");
  });

  test("light preset sets maxRetries to 1", () => {
    const resolved = resolveRetryStackConfig({ preset: "light" });
    expect(resolved.semanticRetry.maxRetries).toBe(1);
  });

  test("standard preset sets maxRetries to 3 and enables guidedRetry", () => {
    const resolved = resolveRetryStackConfig({ preset: "standard" });
    expect(resolved.semanticRetry.maxRetries).toBe(3);
    expect(resolved.guidedRetry).toBeDefined();
  });

  test("aggressive preset sets maxRetries to 5", () => {
    const resolved = resolveRetryStackConfig({ preset: "aggressive" });
    expect(resolved.semanticRetry.maxRetries).toBe(5);
    expect(resolved.guidedRetry).toBeDefined();
  });

  test("user overrides win over preset defaults", () => {
    const resolved = resolveRetryStackConfig({
      preset: "light",
      semanticRetry: { maxRetries: 10 },
    });
    expect(resolved.semanticRetry.maxRetries).toBe(10);
  });

  test("user guidedRetry override replaces preset default", () => {
    const resolved = resolveRetryStackConfig({
      preset: "standard",
      guidedRetry: {
        initialConstraint: {
          reason: { kind: "manual", message: "user constraint", timestamp: Date.now() },
          maxInjections: 5,
        },
      },
    });
    expect(resolved.guidedRetry?.initialConstraint?.reason.message).toBe("user constraint");
  });
});
