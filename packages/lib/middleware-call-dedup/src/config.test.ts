import { describe, expect, test } from "bun:test";
import { validateCallDedupConfig } from "./config.js";

describe("validateCallDedupConfig", () => {
  test("rejects null/non-object/array", () => {
    expect(validateCallDedupConfig(null).ok).toBe(false);
    expect(validateCallDedupConfig("x").ok).toBe(false);
    expect(validateCallDedupConfig([]).ok).toBe(false);
  });

  test("accepts empty object", () => {
    expect(validateCallDedupConfig({}).ok).toBe(true);
  });

  test("rejects bad ttlMs", () => {
    expect(validateCallDedupConfig({ ttlMs: 0 }).ok).toBe(false);
    expect(validateCallDedupConfig({ ttlMs: -1 }).ok).toBe(false);
    expect(validateCallDedupConfig({ ttlMs: 1.5 }).ok).toBe(false);
  });

  test("rejects bad maxEntries", () => {
    expect(validateCallDedupConfig({ maxEntries: 0 }).ok).toBe(false);
  });

  test("rejects non-string-array include/exclude", () => {
    expect(validateCallDedupConfig({ include: [1] }).ok).toBe(false);
    expect(validateCallDedupConfig({ exclude: "shell" }).ok).toBe(false);
  });

  test("rejects non-function hashFn/now/onCacheHit", () => {
    expect(validateCallDedupConfig({ hashFn: "x" }).ok).toBe(false);
    expect(validateCallDedupConfig({ now: 1 }).ok).toBe(false);
    expect(validateCallDedupConfig({ onCacheHit: 1 }).ok).toBe(false);
  });

  test("rejects bad store shape", () => {
    expect(validateCallDedupConfig({ store: { get: () => undefined } }).ok).toBe(false);
  });
});
