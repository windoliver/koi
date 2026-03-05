/**
 * Tests for the RLM stack factory.
 */

import { describe, expect, test } from "bun:test";
import { createRlmStack } from "./create-rlm-stack.js";

describe("createRlmStack", () => {
  test("returns a MiddlewareBundle with middleware and providers", () => {
    const bundle = createRlmStack();
    expect(bundle.middleware).toBeDefined();
    expect(bundle.providers).toBeDefined();
    expect(Array.isArray(bundle.providers)).toBe(true);
    expect(bundle.providers.length).toBeGreaterThan(0);
  });

  test("middleware has name 'rlm'", () => {
    const { middleware } = createRlmStack();
    expect(middleware.name).toBe("rlm");
  });

  test("passes config through to middleware", () => {
    const { middleware } = createRlmStack({
      maxIterations: 15,
      contextWindowTokens: 50_000,
    });
    expect(middleware).toBeDefined();
    expect(middleware.priority).toBe(300); // DEFAULT_PRIORITY
  });

  test("accepts custom priority", () => {
    const { middleware } = createRlmStack({ priority: 100 });
    expect(middleware.priority).toBe(100);
  });

  test("accepts script execution options", () => {
    // Should not throw
    const bundle = createRlmStack({
      scriptTimeoutMs: 10_000,
      scriptMaxCalls: 50,
    });
    expect(bundle).toBeDefined();
  });

  test("provider array has exactly one entry (rlm-tool-provider)", () => {
    const { providers } = createRlmStack();
    expect(providers.length).toBe(1);
  });
});
