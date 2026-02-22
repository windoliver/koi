import { describe, expect, test } from "bun:test";
import { validateRouterConfig } from "./config.js";

const validTarget = {
  provider: "openai",
  model: "gpt-4o",
  adapterConfig: { apiKey: "sk-test-123" },
};

describe("validateRouterConfig", () => {
  test("valid config returns resolved result", () => {
    const result = validateRouterConfig({
      targets: [validTarget],
      strategy: "fallback",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.targets).toHaveLength(1);
    expect(result.value.strategy).toBe("fallback");
  });

  test("applies default weight and enabled to targets", () => {
    const result = validateRouterConfig({
      targets: [validTarget],
      strategy: "fallback",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.targets[0]?.weight).toBe(1);
    expect(result.value.targets[0]?.enabled).toBe(true);
  });

  test("preserves explicit weight and enabled", () => {
    const result = validateRouterConfig({
      targets: [{ ...validTarget, weight: 0.5, enabled: false }],
      strategy: "weighted",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.targets[0]?.weight).toBe(0.5);
    expect(result.value.targets[0]?.enabled).toBe(false);
  });

  test("applies default retry config", () => {
    const result = validateRouterConfig({
      targets: [validTarget],
      strategy: "fallback",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.retry.maxRetries).toBe(3);
    expect(result.value.retry.backoffMultiplier).toBe(2);
    expect(result.value.retry.jitter).toBe(true);
  });

  test("overrides retry config partially", () => {
    const result = validateRouterConfig({
      targets: [validTarget],
      strategy: "fallback",
      retry: { maxRetries: 5 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.retry.maxRetries).toBe(5);
    expect(result.value.retry.backoffMultiplier).toBe(2); // default
  });

  test("applies default circuit breaker config", () => {
    const result = validateRouterConfig({
      targets: [validTarget],
      strategy: "fallback",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.circuitBreaker.failureThreshold).toBe(5);
    expect(result.value.circuitBreaker.cooldownMs).toBe(60_000);
  });

  test("accepts all three routing strategies", () => {
    for (const strategy of ["fallback", "round-robin", "weighted"] as const) {
      const result = validateRouterConfig({
        targets: [validTarget],
        strategy,
      });
      expect(result.ok).toBe(true);
    }
  });

  // Error cases

  test("rejects empty targets", () => {
    const result = validateRouterConfig({
      targets: [],
      strategy: "fallback",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects missing targets", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
    });

    expect(result.ok).toBe(false);
  });

  test("rejects missing strategy", () => {
    const result = validateRouterConfig({
      targets: [validTarget],
    });

    expect(result.ok).toBe(false);
  });

  test("rejects invalid strategy", () => {
    const result = validateRouterConfig({
      targets: [validTarget],
      strategy: "random",
    });

    expect(result.ok).toBe(false);
  });

  test("rejects target without apiKey", () => {
    const result = validateRouterConfig({
      targets: [{ provider: "openai", model: "gpt-4o", adapterConfig: {} }],
      strategy: "fallback",
    });

    expect(result.ok).toBe(false);
  });

  test("rejects null input", () => {
    const result = validateRouterConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects weight > 1", () => {
    const result = validateRouterConfig({
      targets: [{ ...validTarget, weight: 1.5 }],
      strategy: "fallback",
    });

    expect(result.ok).toBe(false);
  });

  test("rejects negative weight", () => {
    const result = validateRouterConfig({
      targets: [{ ...validTarget, weight: -0.5 }],
      strategy: "fallback",
    });

    expect(result.ok).toBe(false);
  });

  test("rejects retry maxRetries > 10", () => {
    const result = validateRouterConfig({
      targets: [validTarget],
      strategy: "fallback",
      retry: { maxRetries: 20 },
    });

    expect(result.ok).toBe(false);
  });

  test("error message includes prefix", () => {
    const result = validateRouterConfig(null);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("Model router config validation failed");
  });
});
