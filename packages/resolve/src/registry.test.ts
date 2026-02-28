/**
 * Tests for the brick descriptor registry.
 */

import { describe, expect, test } from "bun:test";
import { createRegistry } from "./registry.js";
import type { BrickDescriptor, ResolveKind } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(
  kind: ResolveKind,
  name: string,
  aliases?: readonly string[],
): BrickDescriptor<unknown> {
  const base = {
    kind,
    name,
    optionsValidator: (input: unknown) => ({ ok: true as const, value: input }),
    factory: () => ({ name }),
  };
  // exactOptionalPropertyTypes: only include aliases when defined
  if (aliases !== undefined) {
    return { ...base, aliases };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRegistry", () => {
  test("creates registry with valid descriptors", () => {
    const result = createRegistry([
      makeDescriptor("middleware", "mw-a"),
      makeDescriptor("middleware", "mw-b"),
      makeDescriptor("model", "anthropic"),
    ]);

    expect(result.ok).toBe(true);
  });

  test("get() returns descriptor by exact name", () => {
    const desc = makeDescriptor("middleware", "mw-a");
    const result = createRegistry([desc]);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.get("middleware", "mw-a")).toBe(desc);
  });

  test("get() returns descriptor by alias", () => {
    const desc = makeDescriptor("middleware", "@koi/soul", ["soul", "memory"]);
    const result = createRegistry([desc]);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.get("middleware", "soul")).toBe(desc);
    expect(result.value.get("middleware", "memory")).toBe(desc);
  });

  test("get() returns undefined for missing name", () => {
    const result = createRegistry([makeDescriptor("middleware", "mw-a")]);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.get("middleware", "nonexistent")).toBeUndefined();
  });

  test("get() returns undefined when kind does not match", () => {
    const result = createRegistry([makeDescriptor("middleware", "mw-a")]);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.get("model", "mw-a")).toBeUndefined();
  });

  test("has() returns true for existing name", () => {
    const result = createRegistry([makeDescriptor("middleware", "mw-a")]);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.has("middleware", "mw-a")).toBe(true);
  });

  test("has() returns true for alias", () => {
    const result = createRegistry([makeDescriptor("middleware", "@koi/soul", ["soul"])]);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.has("middleware", "soul")).toBe(true);
  });

  test("has() returns false for missing name", () => {
    const result = createRegistry([makeDescriptor("middleware", "mw-a")]);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.has("middleware", "nope")).toBe(false);
  });

  test("list() returns descriptors of the given kind", () => {
    const mw1 = makeDescriptor("middleware", "mw-a");
    const mw2 = makeDescriptor("middleware", "mw-b");
    const model = makeDescriptor("model", "anthropic");
    const result = createRegistry([mw1, mw2, model]);
    if (!result.ok) throw new Error("Expected ok");

    const middlewares = result.value.list("middleware");
    expect(middlewares).toHaveLength(2);
    expect(middlewares).toContain(mw1);
    expect(middlewares).toContain(mw2);

    const models = result.value.list("model");
    expect(models).toHaveLength(1);
    expect(models).toContain(model);
  });

  test("list() returns empty array for unknown kind", () => {
    const result = createRegistry([makeDescriptor("middleware", "mw-a")]);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.list("channel")).toEqual([]);
  });

  test("rejects duplicate canonical name", () => {
    const result = createRegistry([
      makeDescriptor("middleware", "mw-a"),
      makeDescriptor("middleware", "mw-a"),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Duplicate descriptor");
  });

  test("rejects alias that collides with canonical name", () => {
    const result = createRegistry([
      makeDescriptor("middleware", "soul"),
      makeDescriptor("middleware", "@koi/soul", ["soul"]),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Duplicate alias");
  });

  test("rejects alias that collides with another alias", () => {
    const result = createRegistry([
      makeDescriptor("middleware", "mw-a", ["shared"]),
      makeDescriptor("middleware", "mw-b", ["shared"]),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Duplicate alias");
  });

  test("allows same name in different kinds", () => {
    const result = createRegistry([
      makeDescriptor("middleware", "anthropic"),
      makeDescriptor("model", "anthropic"),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.get("middleware", "anthropic")?.kind).toBe("middleware");
    expect(result.value.get("model", "anthropic")?.kind).toBe("model");
  });

  test("creates empty registry from empty list", () => {
    const result = createRegistry([]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    expect(result.value.list("middleware")).toEqual([]);
    expect(result.value.has("middleware", "anything")).toBe(false);
  });
});
