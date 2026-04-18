import { describe, expect, test } from "bun:test";
import { validatePlanPersistConfig } from "./config.js";

describe("validatePlanPersistConfig", () => {
  test("accepts undefined", () => {
    const r = validatePlanPersistConfig(undefined);
    expect(r.ok).toBe(true);
  });

  test("accepts an empty object", () => {
    const r = validatePlanPersistConfig({});
    expect(r.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    expect(validatePlanPersistConfig(42).ok).toBe(false);
    expect(validatePlanPersistConfig("baseDir").ok).toBe(false);
  });

  test.each([
    ["baseDir", { baseDir: 1 }],
    ["cwd", { cwd: 1 }],
    ["fs", { fs: "node:fs" }],
    ["now", { now: 0 }],
    ["rand", { rand: 1 }],
  ])("rejects wrong-typed %s", (_label, input) => {
    const r = validatePlanPersistConfig(input);
    expect(r.ok).toBe(false);
  });

  test("accepts an fs object literal", () => {
    const r = validatePlanPersistConfig({ fs: { mkdir: () => Promise.resolve() } });
    expect(r.ok).toBe(true);
  });
});
