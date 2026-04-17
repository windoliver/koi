import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STRICT_AGENTIC_CONFIG,
  resolveStrictAgenticConfig,
  validateStrictAgenticConfig,
} from "./config.js";

describe("validateStrictAgenticConfig", () => {
  test("accepts empty object and returns defaults applied", () => {
    const result = validateStrictAgenticConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enabled).toBe(true);
    expect(result.value.maxFillerRetries).toBe(3);
  });

  test("accepts full config", () => {
    const result = validateStrictAgenticConfig({
      enabled: false,
      maxFillerRetries: 10,
      feedbackMessage: "custom",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enabled).toBe(false);
    expect(result.value.maxFillerRetries).toBe(10);
    expect(result.value.feedbackMessage).toBe("custom");
  });

  test("rejects negative maxFillerRetries", () => {
    const result = validateStrictAgenticConfig({ maxFillerRetries: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects non-boolean enabled", () => {
    const result = validateStrictAgenticConfig({ enabled: "yes" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer maxFillerRetries", () => {
    const result = validateStrictAgenticConfig({ maxFillerRetries: 2.5 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-object input", () => {
    expect(validateStrictAgenticConfig(null).ok).toBe(false);
    expect(validateStrictAgenticConfig("string").ok).toBe(false);
    expect(validateStrictAgenticConfig(42).ok).toBe(false);
  });

  test("rejects non-function isUserQuestion", () => {
    const result = validateStrictAgenticConfig({ isUserQuestion: "not-a-function" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects non-function isExplicitDone", () => {
    const result = validateStrictAgenticConfig({ isExplicitDone: 42 });
    expect(result.ok).toBe(false);
  });
});

describe("resolveStrictAgenticConfig", () => {
  test("fills unspecified fields with defaults", () => {
    const resolved = resolveStrictAgenticConfig({});
    expect(resolved.enabled).toBe(DEFAULT_STRICT_AGENTIC_CONFIG.enabled);
    expect(resolved.maxFillerRetries).toBe(DEFAULT_STRICT_AGENTIC_CONFIG.maxFillerRetries);
    expect(typeof resolved.isUserQuestion).toBe("function");
    expect(typeof resolved.isExplicitDone).toBe("function");
  });

  test("default isUserQuestion matches trimmed trailing ?", () => {
    const { isUserQuestion } = resolveStrictAgenticConfig({});
    expect(isUserQuestion("Should I proceed?")).toBe(true);
    expect(isUserQuestion("Should I proceed?   ")).toBe(true);
    expect(isUserQuestion("I will proceed.")).toBe(false);
    expect(isUserQuestion("")).toBe(false);
  });

  test("default isExplicitDone matches done/completed/finished", () => {
    const { isExplicitDone } = resolveStrictAgenticConfig({});
    expect(isExplicitDone("All tests pass — done.")).toBe(true);
    expect(isExplicitDone("Task completed successfully.")).toBe(true);
    expect(isExplicitDone("The feature is finished.")).toBe(true);
    expect(isExplicitDone("No further action required.")).toBe(true);
    expect(isExplicitDone("I will proceed.")).toBe(false);
  });

  test("default isUserQuestion rejects whitespace-only input", () => {
    const { isUserQuestion } = resolveStrictAgenticConfig({});
    expect(isUserQuestion("   ")).toBe(false);
    expect(isUserQuestion("\t\n")).toBe(false);
  });

  test("custom predicates override defaults", () => {
    const resolved = resolveStrictAgenticConfig({
      isUserQuestion: () => true,
      isExplicitDone: () => false,
    });
    expect(resolved.isUserQuestion("anything")).toBe(true);
    expect(resolved.isExplicitDone("done.")).toBe(false);
  });
});
