import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { resolveConfig } from "./resolve.js";

const testSchema = z.object({
  name: z.string(),
  count: z.number().int().positive(),
  enabled: z.boolean().optional(),
});

type TestType = z.infer<typeof testSchema>;

const DEFAULTS: TestType = { name: "default", count: 10 };

describe("resolveConfig", () => {
  test("validates and merges with defaults", () => {
    const result = resolveConfig(testSchema, DEFAULTS, { name: "custom", count: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: "custom", count: 5 });
    }
  });

  test("defaults fill gaps for optional fields", () => {
    const result = resolveConfig(testSchema, DEFAULTS, { name: "custom", count: 3, enabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.enabled).toBe(true);
      expect(result.value.name).toBe("custom");
    }
  });

  test("returns error for invalid input", () => {
    const result = resolveConfig(testSchema, DEFAULTS, { name: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("passes prefix to error message", () => {
    const result = resolveConfig(testSchema, DEFAULTS, {}, "MyConfig");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("MyConfig");
    }
  });

  test("validated values override defaults", () => {
    const result = resolveConfig(testSchema, DEFAULTS, { name: "override", count: 99 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("override");
      expect(result.value.count).toBe(99);
    }
  });
});
