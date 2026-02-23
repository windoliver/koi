import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { resolveConfig } from "./resolve.js";

// A partial schema where all fields are optional
const partialSchema = z.object({
  name: z.string().min(1).optional(),
  count: z.number().int().positive().optional(),
  nested: z.object({ x: z.number().optional() }).optional(),
});

type TestConfig = {
  readonly name: string;
  readonly count: number;
  readonly nested: { readonly x: number };
};

const DEFAULTS: TestConfig = {
  name: "default",
  count: 10,
  nested: { x: 42 },
};

describe("resolveConfig", () => {
  test("returns defaults when raw is empty object", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(DEFAULTS);
    }
  });

  test("overrides specified fields", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, { name: "custom" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("custom");
      expect(result.value.count).toBe(10);
    }
  });

  test("deep-merges nested objects", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, { nested: { x: 99 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nested.x).toBe(99);
    }
  });

  test("returns validation error for invalid input", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, { name: "" }, "Test prefix");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Test prefix");
    }
  });

  test("returns validation error for wrong types", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, { count: "not-a-number" });
    expect(result.ok).toBe(false);
  });

  test("does not mutate defaults", () => {
    const copy = JSON.parse(JSON.stringify(DEFAULTS));
    resolveConfig(partialSchema, DEFAULTS, { name: "changed" });
    expect(DEFAULTS).toEqual(copy);
  });

  test("returns ok: true with fully overridden config", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, {
      name: "full",
      count: 99,
      nested: { x: 0 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ name: "full", count: 99, nested: { x: 0 } });
    }
  });

  test("rejects non-object input", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, "bad");
    expect(result.ok).toBe(false);
  });

  test("rejects null input", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, null);
    expect(result.ok).toBe(false);
  });

  test("uses default prefix when none provided", () => {
    const result = resolveConfig(partialSchema, DEFAULTS, { count: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Validation failed");
    }
  });
});
