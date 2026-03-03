import { describe, expect, it } from "bun:test";
import { validateNexusSearchConfig } from "./validate-config.js";

const VALID_CONFIG = {
  baseUrl: "http://localhost:2026",
  apiKey: "sk-test",
} as const;

describe("validateNexusSearchConfig", () => {
  it("returns ok for valid config", () => {
    const result = validateNexusSearchConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
  });

  it("returns ok when all optional fields are undefined", () => {
    const result = validateNexusSearchConfig({
      ...VALID_CONFIG,
      timeoutMs: undefined,
      defaultLimit: undefined,
      minScore: undefined,
      maxBatchSize: undefined,
    });
    expect(result.ok).toBe(true);
  });

  it("returns error for empty baseUrl", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, baseUrl: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("baseUrl");
  });

  it("returns error for whitespace-only baseUrl", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, baseUrl: "  " });
    expect(result.ok).toBe(false);
  });

  it("returns error for invalid URL format", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, baseUrl: "not-a-url" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("valid URL");
  });

  it("returns error for empty apiKey", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, apiKey: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("apiKey");
  });

  it("returns error for negative timeoutMs", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, timeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("timeoutMs");
  });

  it("returns error for zero timeoutMs", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, timeoutMs: 0 });
    expect(result.ok).toBe(false);
  });

  it("returns error for zero defaultLimit", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, defaultLimit: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("defaultLimit");
  });

  it("returns error for negative defaultLimit", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, defaultLimit: -5 });
    expect(result.ok).toBe(false);
  });

  it("returns error for minScore greater than 1", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, minScore: 1.5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("minScore");
  });

  it("returns error for negative minScore", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, minScore: -0.1 });
    expect(result.ok).toBe(false);
  });

  it("returns ok for minScore at boundaries (0 and 1)", () => {
    expect(validateNexusSearchConfig({ ...VALID_CONFIG, minScore: 0 }).ok).toBe(true);
    expect(validateNexusSearchConfig({ ...VALID_CONFIG, minScore: 1 }).ok).toBe(true);
  });

  it("returns error for zero maxBatchSize", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, maxBatchSize: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("maxBatchSize");
  });

  it("returns error for negative maxBatchSize", () => {
    const result = validateNexusSearchConfig({ ...VALID_CONFIG, maxBatchSize: -10 });
    expect(result.ok).toBe(false);
  });
});
