/**
 * Tests for the engine section resolver.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, EngineAdapter } from "@koi/core";
import { createRegistry } from "./registry.js";
import { resolveEngine } from "./resolve-engine.js";
import type { BrickDescriptor, ResolutionContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.1.0",
  model: { name: "mock:test-model" },
};

function makeContext(): ResolutionContext {
  return {
    manifestDir: "/tmp/test",
    manifest: MOCK_MANIFEST,
    env: {},
  };
}

/** Minimal mock — tests only verify resolution, not engine behavior. */
const MOCK_ADAPTER: EngineAdapter = {
  engineId: "mock-engine",
  stream() {
    return (async function* () {
      /* empty */
    })();
  },
};

function makeEngineDescriptor(
  name: string,
  aliases?: readonly string[],
): BrickDescriptor<EngineAdapter> {
  return {
    kind: "engine",
    name,
    ...(aliases !== undefined ? { aliases } : {}),
    optionsValidator: (input: unknown) => ({ ok: true as const, value: input }),
    factory: (): EngineAdapter => MOCK_ADAPTER,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveEngine", () => {
  test("returns undefined when config is undefined", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine(undefined, regResult.value, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeUndefined();
  });

  test("returns undefined when config is null", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine(null, regResult.value, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeUndefined();
  });

  test("returns VALIDATION when config is object without name", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine({ options: {} }, regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("name");
  });

  test("returns VALIDATION when config is a number", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine(42, regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
  });

  test("resolves engine descriptor by name", async () => {
    const regResult = createRegistry([makeEngineDescriptor("@koi/engine-external", ["external"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine(
      { name: "@koi/engine-external" },
      regResult.value,
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
    expect(typeof result.value?.stream).toBe("function");
  });

  test("resolves engine descriptor by alias", async () => {
    const regResult = createRegistry([makeEngineDescriptor("@koi/engine-external", ["external"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine({ name: "external" }, regResult.value, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
  });

  test("resolves string shorthand", async () => {
    const regResult = createRegistry([makeEngineDescriptor("@koi/engine-external", ["external"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine("external", regResult.value, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
  });

  test("passes options through to factory", async () => {
    let receivedOptions: unknown;
    const desc: BrickDescriptor<EngineAdapter> = {
      kind: "engine",
      name: "@koi/engine-external",
      aliases: ["external"],
      optionsValidator: (input: unknown) => ({ ok: true as const, value: input }),
      factory: (opts): EngineAdapter => {
        receivedOptions = opts;
        return MOCK_ADAPTER;
      },
    };

    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine(
      { name: "external", options: { command: "echo hello" } },
      regResult.value,
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(receivedOptions).toEqual({ command: "echo hello" });
  });

  test("returns NOT_FOUND for empty string shorthand", async () => {
    const regResult = createRegistry([makeEngineDescriptor("@koi/engine-external", ["external"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine("", regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("returns NOT_FOUND for unknown engine name", async () => {
    const regResult = createRegistry([makeEngineDescriptor("@koi/engine-external", ["external"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveEngine({ name: "nonexistent" }, regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("nonexistent");
  });
});
