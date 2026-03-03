import { describe, expect, test } from "bun:test";
import { validateOrchestratorConfig } from "./config.js";

const validSpawn = async () => ({ ok: true as const, output: "done" });

describe("validateOrchestratorConfig", () => {
  test("returns ok for valid minimal config", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn });
    expect(result.ok).toBe(true);
  });

  test("returns ok for valid full config", () => {
    const result = validateOrchestratorConfig({
      spawn: validSpawn,
      verify: async () => ({ verdict: "accept" as const }),
      maxConcurrency: 10,
      maxRetries: 5,
      maxOutputPerTask: 2000,
      maxDurationMs: 600_000,
    });
    expect(result.ok).toBe(true);
  });

  test("returns error for non-object input", () => {
    const result = validateOrchestratorConfig("not an object");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error for null input", () => {
    const result = validateOrchestratorConfig(null);
    expect(result.ok).toBe(false);
  });

  test("returns error when spawn is missing", () => {
    const result = validateOrchestratorConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("spawn");
  });

  test("returns error when spawn is not a function", () => {
    const result = validateOrchestratorConfig({ spawn: "not-a-fn" });
    expect(result.ok).toBe(false);
  });

  test("returns error when verify is not a function", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn, verify: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("verify");
  });

  test("returns error for non-positive maxConcurrency", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn, maxConcurrency: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("maxConcurrency");
  });

  test("returns error for non-integer maxConcurrency", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn, maxConcurrency: 1.5 });
    expect(result.ok).toBe(false);
  });

  test("returns error for negative maxRetries", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn, maxRetries: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("maxRetries");
  });

  test("allows zero maxRetries", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn, maxRetries: 0 });
    expect(result.ok).toBe(true);
  });

  test("returns error for non-positive maxOutputPerTask", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn, maxOutputPerTask: 0 });
    expect(result.ok).toBe(false);
  });

  test("returns error for non-positive maxDurationMs", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn, maxDurationMs: -100 });
    expect(result.ok).toBe(false);
  });

  test("defaults are applied correctly when accessing the validated config", () => {
    const result = validateOrchestratorConfig({ spawn: validSpawn });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Optional fields should remain undefined — defaults are applied at runtime
    expect(result.value.maxConcurrency).toBeUndefined();
    expect(result.value.maxRetries).toBeUndefined();
  });
});
