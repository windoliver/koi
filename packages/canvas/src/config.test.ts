import { describe, expect, test } from "bun:test";
import { DEFAULT_CANVAS_CONFIG, validateCanvasConfig } from "./config.js";

describe("DEFAULT_CANVAS_CONFIG", () => {
  test("has sensible defaults", () => {
    expect(DEFAULT_CANVAS_CONFIG.maxComponents).toBe(1_000);
    expect(DEFAULT_CANVAS_CONFIG.maxTreeDepth).toBe(50);
    expect(DEFAULT_CANVAS_CONFIG.maxSurfaces).toBe(100);
    expect(DEFAULT_CANVAS_CONFIG.maxSerializedBytes).toBe(1_048_576);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_CANVAS_CONFIG)).toBe(true);
  });
});

describe("validateCanvasConfig", () => {
  test("accepts valid config", () => {
    const result = validateCanvasConfig({
      maxComponents: 500,
      maxTreeDepth: 25,
      maxSurfaces: 50,
      maxSerializedBytes: 512_000,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects invalid config with non-positive values", () => {
    const result = validateCanvasConfig({
      maxComponents: -1,
      maxTreeDepth: 25,
      maxSurfaces: 50,
      maxSerializedBytes: 512_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});
