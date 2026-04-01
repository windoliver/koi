import { describe, expect, test } from "bun:test";
import { getEngineName } from "./engine-name.js";
import type { LoadedManifest } from "./types.js";

/** Minimal manifest stub for testing engine name extraction. */
function stubManifest(engine: unknown): LoadedManifest {
  return {
    name: "test-agent",
    version: "0.1.0",
    model: { name: "anthropic:claude-sonnet-4-5-20250929" },
    middleware: [],
    tools: [],
    engine,
  } as unknown as LoadedManifest;
}

describe("getEngineName", () => {
  test("returns 'pi' when engine is undefined", () => {
    expect(getEngineName(stubManifest(undefined))).toBe("pi");
  });

  test("returns 'pi' when engine is null", () => {
    expect(getEngineName(stubManifest(null))).toBe("pi");
  });

  test("returns engine string directly when engine is a string", () => {
    expect(getEngineName(stubManifest("loop"))).toBe("loop");
  });

  test("returns engine.name when engine is an object", () => {
    expect(getEngineName(stubManifest({ name: "pi", options: { model: "test" } }))).toBe("pi");
  });

  test("returns 'pi' when engine object has no name property", () => {
    expect(getEngineName(stubManifest({ options: {} }))).toBe("pi");
  });
});
