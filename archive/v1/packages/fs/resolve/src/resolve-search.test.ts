/**
 * Tests for the search section resolver.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import type { SearchProvider } from "@koi/search-provider";
import { createRegistry } from "./registry.js";
import { resolveSearch } from "./resolve-search.js";
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

/** Minimal mock — tests only verify resolution, not provider behavior. */
const MOCK_PROVIDER: SearchProvider = {
  name: "mock-search",
  async search() {
    return { ok: true, value: [] };
  },
};

function makeSearchDescriptor(
  name: string,
  aliases?: readonly string[],
): BrickDescriptor<SearchProvider> {
  return {
    kind: "search",
    name,
    ...(aliases !== undefined ? { aliases } : {}),
    optionsValidator: (input: unknown) => ({ ok: true as const, value: input }),
    factory: (): SearchProvider => MOCK_PROVIDER,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveSearch", () => {
  test("returns undefined when config is undefined", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch(undefined, regResult.value, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeUndefined();
  });

  test("returns undefined when config is null", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch(null, regResult.value, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeUndefined();
  });

  test("returns VALIDATION when config is object without name", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch({ options: {} }, regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("name");
  });

  test("returns VALIDATION when config is a number", async () => {
    const regResult = createRegistry([]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch(42, regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
  });

  test("resolves search descriptor by name", async () => {
    const regResult = createRegistry([makeSearchDescriptor("@koi/search-brave", ["brave"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch(
      { name: "@koi/search-brave" },
      regResult.value,
      makeContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
    expect(typeof result.value?.search).toBe("function");
  });

  test("resolves search descriptor by alias", async () => {
    const regResult = createRegistry([makeSearchDescriptor("@koi/search-brave", ["brave"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch({ name: "brave" }, regResult.value, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
  });

  test("resolves string shorthand", async () => {
    const regResult = createRegistry([makeSearchDescriptor("@koi/search-brave", ["brave"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch("brave", regResult.value, makeContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value).toBeDefined();
  });

  test("passes options through to factory", async () => {
    let receivedOptions: unknown;
    const desc: BrickDescriptor<SearchProvider> = {
      kind: "search",
      name: "@koi/search-brave",
      aliases: ["brave"],
      optionsValidator: (input: unknown) => ({ ok: true as const, value: input }),
      factory: (opts): SearchProvider => {
        receivedOptions = opts;
        return MOCK_PROVIDER;
      },
    };

    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch(
      { name: "brave", options: { country: "US" } },
      regResult.value,
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(receivedOptions).toEqual({ country: "US" });
  });

  test("returns NOT_FOUND for empty string shorthand", async () => {
    const regResult = createRegistry([makeSearchDescriptor("@koi/search-brave", ["brave"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch("", regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("returns NOT_FOUND for unknown search name", async () => {
    const regResult = createRegistry([makeSearchDescriptor("@koi/search-brave", ["brave"])]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch({ name: "nonexistent" }, regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toContain("nonexistent");
  });

  test("wraps factory throw as INTERNAL error", async () => {
    const desc: BrickDescriptor<SearchProvider> = {
      kind: "search",
      name: "@koi/search-brave",
      aliases: ["brave"],
      optionsValidator: (input: unknown) => ({ ok: true as const, value: input }),
      factory: (): SearchProvider => {
        throw new Error("Missing API key");
      },
    };

    const regResult = createRegistry([desc]);
    if (!regResult.ok) throw new Error("Registry failed");

    const result = await resolveSearch("brave", regResult.value, makeContext());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toContain("Missing API key");
  });
});
