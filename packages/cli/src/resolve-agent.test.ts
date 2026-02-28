/**
 * Tests for resolve-agent — verifies that all descriptors are registered.
 */

import { describe, expect, test } from "bun:test";
// We re-import the same descriptors that resolve-agent.ts uses to verify
// the external engine descriptor is present in the registry.
import { descriptor as externalEngineDescriptor } from "@koi/engine-external";
import type { BrickDescriptor } from "@koi/resolve";
import { createRegistry } from "@koi/resolve";

describe("CLI descriptor registration", () => {
  test("external engine descriptor has correct kind and name", () => {
    expect(externalEngineDescriptor.kind).toBe("engine");
    expect(externalEngineDescriptor.name).toBe("@koi/engine-external");
  });

  test("external engine descriptor has 'external' alias", () => {
    expect(externalEngineDescriptor.aliases).toContain("external");
  });

  test("registry resolves engine/external by alias", () => {
    const regResult = createRegistry([externalEngineDescriptor as BrickDescriptor<unknown>]);
    if (!regResult.ok) throw new Error("Registry creation failed");

    const found = regResult.value.get("engine", "external");
    expect(found).toBeDefined();
    expect(found?.name).toBe("@koi/engine-external");
  });
});
