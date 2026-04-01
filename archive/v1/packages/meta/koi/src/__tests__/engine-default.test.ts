/**
 * Engine default tests — verify engine-pi is the default when no engine specified.
 */

import { describe, expect, test } from "bun:test";
import type { LoadedManifest } from "@koi/manifest";
import { getEngineName } from "@koi/manifest";

function stubManifest(engine?: unknown): LoadedManifest {
  return {
    name: "test-agent",
    version: "0.1.0",
    model: { name: "anthropic:claude-sonnet-4-5-20250929" },
    middleware: [],
    tools: [],
    engine,
  } as unknown as LoadedManifest;
}

describe("engine default", () => {
  test("getEngineName returns 'pi' when no engine specified", () => {
    expect(getEngineName(stubManifest())).toBe("pi");
  });

  test("getEngineName returns 'pi' when engine is undefined", () => {
    expect(getEngineName(stubManifest(undefined))).toBe("pi");
  });

  test("getEngineName returns specified engine name", () => {
    expect(getEngineName(stubManifest("loop"))).toBe("loop");
  });

  test("getEngineName extracts name from engine object", () => {
    expect(getEngineName(stubManifest({ name: "pi", options: {} }))).toBe("pi");
  });
});
