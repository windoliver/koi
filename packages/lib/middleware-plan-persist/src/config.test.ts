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

  test("accepts an fs with all required methods", () => {
    const noop = (): Promise<void> => Promise.resolve();
    const noopAny = (): Promise<unknown> => Promise.resolve(undefined);
    const noopStr = (): Promise<string> => Promise.resolve("");
    const r = validatePlanPersistConfig({
      fs: {
        mkdir: noopAny,
        writeFile: noop,
        readFile: noopStr,
        rename: noop,
        stat: noopAny,
        realpath: noopStr,
        unlink: noop,
        link: noop,
      },
    });
    expect(r.ok).toBe(true);
  });

  test("rejects an fs missing required methods (e.g. link added in a later revision)", () => {
    const noop = (): Promise<void> => Promise.resolve();
    const noopAny = (): Promise<unknown> => Promise.resolve(undefined);
    const noopStr = (): Promise<string> => Promise.resolve("");
    const r = validatePlanPersistConfig({
      fs: {
        mkdir: noopAny,
        writeFile: noop,
        readFile: noopStr,
        rename: noop,
        stat: noopAny,
        realpath: noopStr,
        unlink: noop,
        // link intentionally omitted — used to crash on first savePlan
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain("fs.link must be a function");
    }
  });
});
