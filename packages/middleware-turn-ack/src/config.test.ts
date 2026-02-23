import { describe, expect, test } from "bun:test";
import { validateConfig } from "./config.js";

describe("validateConfig", () => {
  test("accepts empty config", () => {
    const result = validateConfig({});
    expect(result.ok).toBe(true);
  });

  test("accepts valid debounceMs", () => {
    const result = validateConfig({ debounceMs: 200 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.debounceMs).toBe(200);
    }
  });

  test("accepts zero debounceMs", () => {
    const result = validateConfig({ debounceMs: 0 });
    expect(result.ok).toBe(true);
  });

  test("rejects negative debounceMs", () => {
    const result = validateConfig({ debounceMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("debounceMs");
    }
  });

  test("rejects Infinity debounceMs", () => {
    const result = validateConfig({ debounceMs: Infinity });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects NaN debounceMs", () => {
    const result = validateConfig({ debounceMs: NaN });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("accepts config with onError callback", () => {
    const result = validateConfig({ onError: () => {} });
    expect(result.ok).toBe(true);
  });
});
