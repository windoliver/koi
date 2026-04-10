import { describe, expect, test } from "bun:test";
import { validateRouterConfig } from "./config.js";

const baseTarget = {
  provider: "openai",
  model: "gpt-4o",
  adapterConfig: {},
};

describe("validateRouterConfig", () => {
  test("valid fallback config → ok", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
      targets: [baseTarget],
    });
    expect(result.ok).toBe(true);
  });

  test("valid round-robin config → ok", () => {
    const result = validateRouterConfig({
      strategy: "round-robin",
      targets: [
        baseTarget,
        { provider: "anthropic", model: "claude-sonnet-4-6", adapterConfig: {} },
      ],
    });
    expect(result.ok).toBe(true);
  });

  test("valid weighted config → ok", () => {
    const result = validateRouterConfig({
      strategy: "weighted",
      targets: [{ ...baseTarget, weight: 0.7 }],
    });
    expect(result.ok).toBe(true);
  });

  test("missing strategy → validation error", () => {
    const result = validateRouterConfig({ targets: [baseTarget] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe("VALIDATION");
  });

  test("cascade strategy rejected in Phase 2", () => {
    const result = validateRouterConfig({
      strategy: "cascade",
      targets: [baseTarget],
    });
    expect(result.ok).toBe(false);
  });

  test("empty targets array → validation error", () => {
    const result = validateRouterConfig({ strategy: "fallback", targets: [] });
    expect(result.ok).toBe(false);
  });

  test("target missing provider → validation error", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
      targets: [{ model: "gpt-4o", adapterConfig: {} }],
    });
    expect(result.ok).toBe(false);
  });

  test("resolved targets default enabled=true and weight=1", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
      targets: [baseTarget],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.targets[0]?.enabled).toBe(true);
    expect(result.value.targets[0]?.weight).toBe(1);
  });

  test("resolved retry uses DEFAULT_RETRY_CONFIG defaults", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
      targets: [baseTarget],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.retry.maxRetries).toBe(3);
    expect(result.value.retry.jitter).toBe(true);
  });

  test("custom retry.maxRetries overrides default", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
      targets: [baseTarget],
      retry: { maxRetries: 0 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.retry.maxRetries).toBe(0);
  });

  test("circuit breaker defaults applied", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
      targets: [baseTarget],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.circuitBreaker.failureThreshold).toBe(5);
    expect(result.value.circuitBreaker.cooldownMs).toBe(60_000);
  });

  test("healthProbe config preserved when provided", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
      targets: [baseTarget],
      healthProbe: { intervalMs: 15_000 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.healthProbe?.intervalMs).toBe(15_000);
  });

  test("capabilities preserved in resolved target", () => {
    const result = validateRouterConfig({
      strategy: "fallback",
      targets: [{ ...baseTarget, capabilities: { vision: true } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.targets[0]?.capabilities?.vision).toBe(true);
  });

  test("weight out of range [0,1] → validation error", () => {
    const result = validateRouterConfig({
      strategy: "weighted",
      targets: [{ ...baseTarget, weight: 1.5 }],
    });
    expect(result.ok).toBe(false);
  });
});
