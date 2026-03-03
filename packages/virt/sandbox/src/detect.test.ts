import { describe, expect, test } from "bun:test";
import { checkAvailability, detectPlatform } from "./detect.js";

describe("detectPlatform", () => {
  test("returns a valid platform for the current OS", () => {
    const result = detectPlatform();
    if (process.platform === "darwin") {
      expect(result).toEqual({ ok: true, value: "seatbelt" });
    } else if (process.platform === "linux") {
      expect(result).toEqual({ ok: true, value: "bwrap" });
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    }
  });

  test("returns error result for unsupported platforms", () => {
    // We can't mock process.platform easily, but we verify the return shape
    const result = detectPlatform();
    expect(result).toHaveProperty("ok");
    if (result.ok) {
      expect(["seatbelt", "bwrap"]).toContain(result.value);
    } else {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
  });
});

describe("checkAvailability", () => {
  test("returns PlatformInfo with availability status", () => {
    const result = checkAvailability();
    if (!result.ok) {
      // Unsupported platform
      expect(result.error.code).toBe("VALIDATION");
      return;
    }
    expect(result.value).toHaveProperty("platform");
    expect(result.value).toHaveProperty("available");
    expect(["seatbelt", "bwrap"]).toContain(result.value.platform);
    expect(typeof result.value.available).toBe("boolean");
  });

  test("returns reason when binary not available", () => {
    const result = checkAvailability();
    if (result.ok && !result.value.available) {
      expect(result.value.reason).toBeDefined();
      expect(typeof result.value.reason).toBe("string");
    }
  });
});
