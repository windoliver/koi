import { describe, expect, test } from "bun:test";
import { nexusPath } from "@koi/core";
import { validateNexusConfig, validateNexusPath } from "./validate.js";

describe("validateNexusConfig", () => {
  test("returns ok for valid config", () => {
    const result = validateNexusConfig({
      baseUrl: "http://localhost:2026",
      apiKey: "test-key",
    });
    expect(result.ok).toBe(true);
  });

  test("returns error for empty baseUrl", () => {
    const result = validateNexusConfig({ baseUrl: "", apiKey: "key" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("returns error for whitespace-only baseUrl", () => {
    const result = validateNexusConfig({ baseUrl: "  ", apiKey: "key" });
    expect(result.ok).toBe(false);
  });

  test("returns error for empty apiKey", () => {
    const result = validateNexusConfig({ baseUrl: "http://localhost", apiKey: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    }
  });
});

describe("validateNexusPath", () => {
  test("returns branded path for valid input", () => {
    const result = validateNexusPath("agents/a1/bricks/b1.json");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(nexusPath("agents/a1/bricks/b1.json"));
    }
  });

  test("rejects empty string", () => {
    const result = validateNexusPath("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects leading slash", () => {
    const result = validateNexusPath("/agents/a1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("/");
    }
  });

  test("rejects path traversal", () => {
    const result = validateNexusPath("agents/../secrets");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("..");
    }
  });

  test("rejects path exceeding max length", () => {
    const long = "a".repeat(513);
    const result = validateNexusPath(long);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("512");
    }
  });

  test("accepts path at max length", () => {
    const exact = "a".repeat(512);
    const result = validateNexusPath(exact);
    expect(result.ok).toBe(true);
  });
});
