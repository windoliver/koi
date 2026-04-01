import { describe, expect, test } from "bun:test";
import { createRlmStackFromPreset } from "./presets.js";

describe("createRlmStackFromPreset", () => {
  test("'light' returns valid MiddlewareBundle", () => {
    const bundle = createRlmStackFromPreset("light");
    expect(bundle.middleware).toBeDefined();
    expect(bundle.middleware.name).toBe("rlm");
    expect(bundle.providers).toBeDefined();
    expect(Array.isArray(bundle.providers)).toBe(true);
  });

  test("'standard' returns valid MiddlewareBundle", () => {
    const bundle = createRlmStackFromPreset("standard");
    expect(bundle.middleware).toBeDefined();
    expect(bundle.middleware.name).toBe("rlm");
    expect(bundle.providers).toBeDefined();
    expect(Array.isArray(bundle.providers)).toBe(true);
  });

  test("'aggressive' returns valid MiddlewareBundle", () => {
    const bundle = createRlmStackFromPreset("aggressive");
    expect(bundle.middleware).toBeDefined();
    expect(bundle.middleware.name).toBe("rlm");
    expect(bundle.providers).toBeDefined();
    expect(Array.isArray(bundle.providers)).toBe(true);
  });

  test("default tier is 'standard'", () => {
    const defaultBundle = createRlmStackFromPreset();
    const standardBundle = createRlmStackFromPreset("standard");
    // Both should produce middleware with the same priority (default 300)
    expect(defaultBundle.middleware.priority).toBe(standardBundle.middleware.priority);
    expect(defaultBundle.middleware.name).toBe(standardBundle.middleware.name);
  });

  test("overrides applied on top of preset", () => {
    const bundle = createRlmStackFromPreset("light", { priority: 100 });
    expect(bundle.middleware.priority).toBe(100);
  });

  test("bundle has middleware and providers array", () => {
    const bundle = createRlmStackFromPreset("standard");
    expect(typeof bundle.middleware).toBe("object");
    expect(bundle.middleware.name).toBe("rlm");
    expect(Array.isArray(bundle.providers)).toBe(true);
    expect(bundle.providers.length).toBeGreaterThan(0);
  });
});
