/**
 * End-to-end validation of the forge search -> install -> list -> resolve workflow.
 *
 * Exercises the programmatic forge APIs (not CLI subprocesses) for:
 * - Store save/load with content-hash integrity
 * - Tampered content detection
 * - Registry listing by kind
 * - Registry resolution by name and alias
 * - Optimistic locking on update
 * - Descriptor resolution through the manifest registry
 *
 * No external network calls — uses in-memory stores and registries.
 *
 * Run:
 *   bun test tests/e2e/e2e-forge-workflow.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { BrickArtifact, ToolArtifact } from "@koi/core";
import { createInMemoryForgeStore, descriptor } from "@koi/forge-tools";
import { computeBrickId } from "@koi/hash";
import type { BrickDescriptor } from "@koi/resolve";
import { createRegistry } from "@koi/resolve";
import { createTestSkillArtifact, createTestToolArtifact } from "@koi/test-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a tool brick whose content-addressed ID matches its implementation. */
function validToolBrick(
  overrides?: Partial<Parameters<typeof createTestToolArtifact>[0]>,
): ToolArtifact {
  const impl = overrides?.implementation ?? "return 1;";
  const id = overrides?.id ?? computeBrickId("tool", impl);
  return createTestToolArtifact({ ...overrides, id, implementation: impl });
}

// ---------------------------------------------------------------------------
// 1. Store save + load with integrity
// ---------------------------------------------------------------------------

describe("e2e: forge store saves and loads a brick with integrity", () => {
  test("save stores a brick and load retrieves it with matching content hash", async () => {
    const store = createInMemoryForgeStore();
    const impl = "return input.x + input.y;";
    const id = computeBrickId("tool", impl);
    const brick = validToolBrick({ id, implementation: impl, name: "add-numbers" });

    const saveResult = await store.save(brick);
    expect(saveResult.ok).toBe(true);

    const loadResult = await store.load(id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.id).toBe(id);
      expect(loadResult.value.name).toBe("add-numbers");
      expect(loadResult.value.implementation).toBe(impl);
      // storeVersion is stamped on first save
      expect(loadResult.value.storeVersion).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Tampered content detection
// ---------------------------------------------------------------------------

describe("e2e: forge store content integrity", () => {
  test("load succeeds even with mismatched ID — integrity checked at trust boundaries", async () => {
    const store = createInMemoryForgeStore();
    const originalImpl = "return 42;";
    const id = computeBrickId("tool", originalImpl);

    // Save a brick whose ID was computed from originalImpl but whose content is different.
    // Load still succeeds — integrity verification belongs at trust boundaries
    // (e.g., forge install from remote registry), not on every read.
    const tamperedBrick: BrickArtifact = {
      ...createTestToolArtifact({ id, implementation: "return hacked();" }),
    };
    await store.save(tamperedBrick);

    const loadResult = await store.load(id);
    expect(loadResult.ok).toBe(true);

    // Caller can verify integrity explicitly via computeBrickId comparison
    if (loadResult.ok && loadResult.value.kind === "tool") {
      const recomputed = computeBrickId("tool", loadResult.value.implementation);
      expect(recomputed).not.toBe(id); // content doesn't match — tampered
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Registry lists available bricks by kind
// ---------------------------------------------------------------------------

describe("e2e: forge registry lists available bricks", () => {
  test("search by kind returns expected bricks from the store", async () => {
    const store = createInMemoryForgeStore();

    // Save two tools and one skill
    const tool1 = validToolBrick({ implementation: "return 1;", name: "tool-alpha" });
    const tool2 = validToolBrick({ implementation: "return 2;", name: "tool-beta" });
    const skillContent = "# My Skill\nDo something useful";
    const skillId = computeBrickId("skill", skillContent);
    const skill = createTestSkillArtifact({
      id: skillId,
      content: skillContent,
      name: "skill-gamma",
    });

    await store.save(tool1);
    await store.save(tool2);
    await store.save(skill);

    // Search for tools only
    const toolResult = await store.search({ kind: "tool" });
    expect(toolResult.ok).toBe(true);
    if (toolResult.ok) {
      expect(toolResult.value.length).toBe(2);
      const names = toolResult.value.map((b) => b.name);
      expect(names).toContain("tool-alpha");
      expect(names).toContain("tool-beta");
    }

    // Search for skills only
    const skillResult = await store.search({ kind: "skill" });
    expect(skillResult.ok).toBe(true);
    if (skillResult.ok) {
      expect(skillResult.value.length).toBe(1);
      expect(skillResult.value[0]?.name).toBe("skill-gamma");
    }

    // Search with no filter returns all 3
    const allResult = await store.search({});
    expect(allResult.ok).toBe(true);
    if (allResult.ok) {
      expect(allResult.value.length).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Registry resolves brick by name and alias
// ---------------------------------------------------------------------------

describe("e2e: forge registry resolves brick by name and alias", () => {
  test("descriptor is accessible by canonical name and alias via resolve registry", () => {
    // The @koi/forge descriptor has name "@koi/forge" and aliases ["forge"]
    const result = createRegistry([descriptor as BrickDescriptor<unknown>]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const registry = result.value;

    // Canonical name lookup
    const byName = registry.get("forge", "@koi/forge");
    expect(byName).toBeDefined();
    expect(byName?.name).toBe("@koi/forge");
    expect(byName?.kind).toBe("forge");

    // Alias lookup
    const byAlias = registry.get("forge", "forge");
    expect(byAlias).toBeDefined();
    expect(byAlias?.name).toBe("@koi/forge");

    // Both lookups return the same descriptor
    expect(byName).toBe(byAlias);
  });

  test("list by kind returns all descriptors of that kind", () => {
    // Create a registry with the forge descriptor plus a custom middleware descriptor
    const customMiddleware: BrickDescriptor<unknown> = {
      kind: "middleware",
      name: "@test/audit-middleware",
      aliases: ["audit"],
      optionsValidator: (input: unknown) => ({ ok: true, value: input ?? {} }),
      factory: () => ({ name: "audit" }),
    };

    const result = createRegistry([descriptor as BrickDescriptor<unknown>, customMiddleware]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const registry = result.value;

    // List forge descriptors
    const forgeList = registry.list("forge");
    expect(forgeList.length).toBe(1);
    expect(forgeList[0]?.name).toBe("@koi/forge");

    // List middleware descriptors
    const mwList = registry.list("middleware");
    expect(mwList.length).toBe(1);
    expect(mwList[0]?.name).toBe("@test/audit-middleware");

    // Non-existent kind returns empty
    const emptyList = registry.list("channel");
    expect(emptyList.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Optimistic locking on update
// ---------------------------------------------------------------------------

describe("e2e: forge store update with optimistic locking", () => {
  test("update with correct version succeeds, stale version returns CONFLICT", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick({ implementation: "return 100;", name: "versioned-tool" });
    await store.save(brick);

    // After save, storeVersion is 1. Update with correct version.
    const updateResult = await store.update(brick.id, {
      usageCount: 10,
      expectedVersion: 1,
    });
    expect(updateResult.ok).toBe(true);

    // After update, storeVersion should be 2
    const loadResult = await store.load(brick.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.storeVersion).toBe(2);
      expect(loadResult.value.usageCount).toBe(10);
    }

    // Now try updating with stale version (1) — should fail
    const staleResult = await store.update(brick.id, {
      usageCount: 99,
      expectedVersion: 1,
    });
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(staleResult.error.code).toBe("CONFLICT");
      expect(staleResult.error.message).toContain("version");
    }

    // Confirm the usageCount was NOT changed by the stale update
    const reloadResult = await store.load(brick.id);
    expect(reloadResult.ok).toBe(true);
    if (reloadResult.ok) {
      expect(reloadResult.value.usageCount).toBe(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Installed brick descriptor resolves through manifest
// ---------------------------------------------------------------------------

describe("e2e: installed brick descriptor resolves through manifest", () => {
  test("custom descriptor added to registry is resolvable by name", () => {
    // Simulate an installed brick by creating a descriptor and adding to registry
    const installedBrick: BrickDescriptor<unknown> = {
      kind: "tool",
      name: "@community/string-utils",
      aliases: ["string-utils", "str"],
      description: "String manipulation utilities",
      tags: ["string", "utility"],
      optionsValidator: (input: unknown) => ({ ok: true, value: input ?? {} }),
      factory: () => ({ name: "string-utils" }),
    };

    const result = createRegistry([installedBrick]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const registry = result.value;

    // Resolve by canonical name
    expect(registry.has("tool", "@community/string-utils")).toBe(true);
    const resolved = registry.get("tool", "@community/string-utils");
    expect(resolved).toBeDefined();
    expect(resolved?.description).toBe("String manipulation utilities");
    expect(resolved?.tags).toEqual(["string", "utility"]);

    // Resolve by alias "string-utils"
    expect(registry.has("tool", "string-utils")).toBe(true);
    const byAlias = registry.get("tool", "string-utils");
    expect(byAlias).toBe(resolved);

    // Resolve by short alias "str"
    expect(registry.has("tool", "str")).toBe(true);
    const byShort = registry.get("tool", "str");
    expect(byShort).toBe(resolved);

    // Wrong kind returns undefined
    expect(registry.has("skill", "@community/string-utils")).toBe(false);
    expect(registry.get("skill", "@community/string-utils")).toBeUndefined();
  });

  test("options validator on installed descriptor validates input", () => {
    // Descriptor with a strict validator
    const strictDescriptor: BrickDescriptor<unknown> = {
      kind: "middleware",
      name: "@test/strict-mw",
      optionsValidator: (input: unknown) => {
        if (typeof input !== "object" || input === null) {
          return {
            ok: false,
            error: {
              code: "VALIDATION" as const,
              message: "Options must be an object",
              retryable: false,
            },
          };
        }
        return { ok: true, value: input };
      },
      factory: () => ({ name: "strict" }),
    };

    const registryResult = createRegistry([strictDescriptor]);
    expect(registryResult.ok).toBe(true);
    if (!registryResult.ok) return;

    const desc = registryResult.value.get("middleware", "@test/strict-mw");
    expect(desc).toBeDefined();

    // Valid input passes
    const validResult = desc?.optionsValidator({ maxRetries: 3 });
    expect(validResult?.ok).toBe(true);

    // Invalid input fails
    const invalidResult = desc?.optionsValidator("not-an-object");
    expect(invalidResult?.ok).toBe(false);
    if (invalidResult !== undefined && !invalidResult.ok) {
      expect(invalidResult.error.code).toBe("VALIDATION");
    }
  });
});
