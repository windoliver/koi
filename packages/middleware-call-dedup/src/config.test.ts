import { describe, expect, test } from "bun:test";
import { validateCallDedupConfig } from "./config.js";

describe("validateCallDedupConfig", () => {
  test("valid: empty config (all defaults)", () => {
    const result = validateCallDedupConfig({});
    expect(result.ok).toBe(true);
  });

  test("valid: full config with all fields", () => {
    const result = validateCallDedupConfig({
      ttlMs: 60_000,
      maxEntries: 50,
      include: ["file_read"],
      exclude: ["my_tool"],
      hashFn: () => "key",
      now: () => Date.now(),
      store: {
        get: () => undefined,
        set: () => {},
        delete: () => false,
        size: () => 0,
        clear: () => {},
      },
      onCacheHit: () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("invalid: null", () => {
    const result = validateCallDedupConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-null object");
  });

  test("invalid: non-object (string)", () => {
    const result = validateCallDedupConfig("bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-null object");
  });

  test("invalid: negative ttlMs", () => {
    const result = validateCallDedupConfig({ ttlMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ttlMs");
  });

  test("invalid: zero ttlMs", () => {
    const result = validateCallDedupConfig({ ttlMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ttlMs");
  });

  test("invalid: non-finite ttlMs (Infinity)", () => {
    const result = validateCallDedupConfig({ ttlMs: Infinity });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ttlMs");
  });

  test("invalid: non-integer maxEntries (1.5)", () => {
    const result = validateCallDedupConfig({ maxEntries: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxEntries");
  });

  test("invalid: non-array include", () => {
    const result = validateCallDedupConfig({ include: "file_read" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("include");
  });

  test("invalid: store missing methods", () => {
    const result = validateCallDedupConfig({ store: { get: () => {} } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("store");
  });
});
