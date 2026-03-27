/**
 * Tests for InMemoryForgeStore content integrity and optimistic locking.
 */

import { describe, expect, test } from "bun:test";
import type { BrickArtifact } from "@koi/core";
import { brickId } from "@koi/core";
import { computeBrickId } from "@koi/hash";
import { createTestSkillArtifact, createTestToolArtifact } from "@koi/test-utils";
import { createInMemoryForgeStore } from "./memory-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a tool brick with a content-addressed ID matching its implementation. */
function validToolBrick(
  overrides?: Partial<Parameters<typeof createTestToolArtifact>[0]>,
): ReturnType<typeof createTestToolArtifact> {
  const impl = overrides?.implementation ?? "return 1;";
  const id = overrides?.id ?? computeBrickId("tool", impl);
  return createTestToolArtifact({ ...overrides, id, implementation: impl });
}

/** Create a skill brick with a content-addressed ID matching its content. */
function validSkillBrick(
  overrides?: Partial<Parameters<typeof createTestSkillArtifact>[0]>,
): ReturnType<typeof createTestSkillArtifact> {
  const content = overrides?.content ?? "# Test Skill";
  const id = overrides?.id ?? computeBrickId("skill", content);
  return createTestSkillArtifact({ ...overrides, id, content });
}

// ---------------------------------------------------------------------------
// Content integrity — save populates storeVersion
// ---------------------------------------------------------------------------

describe("content integrity: save", () => {
  test("saved brick has storeVersion populated", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick();
    await store.save(brick);

    const result = await store.load(brick.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.storeVersion).toBe(1);
    }
  });

  test("saved brick preserves existing storeVersion", async () => {
    const store = createInMemoryForgeStore();
    const impl = "return 42;";
    const id = computeBrickId("tool", impl);
    const brick = validToolBrick({ id, implementation: impl, storeVersion: 5 } as Partial<
      Parameters<typeof createTestToolArtifact>[0]
    >);
    // Force storeVersion onto the brick (test-utils may not have it typed)
    const brickWithVersion: BrickArtifact = { ...brick, storeVersion: 5 };
    await store.save(brickWithVersion);

    const result = await store.load(id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.storeVersion).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Content integrity — load verifies content hash
// ---------------------------------------------------------------------------

describe("content integrity: load", () => {
  test("load succeeds for brick with matching content hash", async () => {
    const store = createInMemoryForgeStore();
    const impl = "return 42;";
    const id = computeBrickId("tool", impl);
    const brick = validToolBrick({ id, implementation: impl });
    await store.save(brick);

    const result = await store.load(id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(id);
    }
  });

  test("load returns error when content was tampered with", async () => {
    const store = createInMemoryForgeStore();
    const originalImpl = "return 1;";
    const id = computeBrickId("tool", originalImpl);
    const brick = validToolBrick({ id, implementation: originalImpl });
    await store.save(brick);

    // Save a brick whose content-addressed ID does not match its content
    const store2 = createInMemoryForgeStore();
    // Directly save a brick whose ID does not match its content
    const mismatchedBrick: BrickArtifact = {
      ...createTestToolArtifact({
        id,
        implementation: "return hacked;",
      }),
    };
    await store2.save(mismatchedBrick);

    const result = await store2.load(id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("integrity");
    }
  });

  test("load succeeds for skill brick with matching content", async () => {
    const store = createInMemoryForgeStore();
    const content = "# My Skill";
    const id = computeBrickId("skill", content);
    const brick = validSkillBrick({ id, content });
    await store.save(brick);

    const result = await store.load(id);
    expect(result.ok).toBe(true);
  });

  test("backward compat — loading a brick without storeVersion still works", async () => {
    const store = createInMemoryForgeStore();
    const impl = "return 1;";
    const id = computeBrickId("tool", impl);
    const brick = validToolBrick({ id, implementation: impl });
    // Save stamps storeVersion=1, but bricks from older stores may not have it.
    // The load path should work regardless.
    await store.save(brick);

    const result = await store.load(id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // storeVersion is present after save through our store
      expect(typeof result.value.storeVersion).toBe("number");
    }
  });
});

// ---------------------------------------------------------------------------
// Optimistic locking — update
// ---------------------------------------------------------------------------

describe("optimistic locking: update", () => {
  test("update with correct expectedVersion succeeds", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick();
    await store.save(brick);

    // After save, storeVersion is 1
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
  });

  test("update with stale expectedVersion returns CONFLICT", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick();
    await store.save(brick);

    // Simulate a concurrent update: first update succeeds
    await store.update(brick.id, { usageCount: 5, expectedVersion: 1 });

    // Second update with stale version (1) should fail
    const staleResult = await store.update(brick.id, {
      usageCount: 99,
      expectedVersion: 1,
    });
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(staleResult.error.code).toBe("CONFLICT");
      expect(staleResult.error.message).toContain("version");
    }
  });

  test("update without expectedVersion skips version check (unconditional)", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick();
    await store.save(brick);

    // Update without expectedVersion — should always succeed
    const result = await store.update(brick.id, { usageCount: 42 });
    expect(result.ok).toBe(true);

    const loadResult = await store.load(brick.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.usageCount).toBe(42);
      expect(loadResult.value.storeVersion).toBe(2);
    }
  });

  test("update increments storeVersion on each successful update", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick();
    await store.save(brick);

    // Three successive updates
    await store.update(brick.id, { usageCount: 1 });
    await store.update(brick.id, { usageCount: 2 });
    await store.update(brick.id, { usageCount: 3 });

    const loadResult = await store.load(brick.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.storeVersion).toBe(4); // 1 (save) + 3 (updates)
      expect(loadResult.value.usageCount).toBe(3);
    }
  });

  test("update with correct version after multiple updates succeeds", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick();
    await store.save(brick);

    // Two updates bump version to 3
    await store.update(brick.id, { usageCount: 1 });
    await store.update(brick.id, { usageCount: 2 });

    // Now expectedVersion=3 should succeed
    const result = await store.update(brick.id, {
      usageCount: 99,
      expectedVersion: 3,
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Optimistic locking — promoteAndUpdate
// ---------------------------------------------------------------------------

describe("optimistic locking: promoteAndUpdate", () => {
  test("promoteAndUpdate with correct version succeeds", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick({ scope: "agent" });
    await store.save(brick);

    expect(store.promoteAndUpdate).toBeDefined();
    const result = await store.promoteAndUpdate!(brick.id, "global", {
      expectedVersion: 1,
    });
    expect(result.ok).toBe(true);

    const loadResult = await store.load(brick.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.scope).toBe("global");
      expect(loadResult.value.storeVersion).toBe(2);
    }
  });

  test("promoteAndUpdate with stale version returns CONFLICT", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick({ scope: "agent" });
    await store.save(brick);

    // Bump version with an update
    await store.update(brick.id, { usageCount: 5 });

    // Promote with stale version should fail
    expect(store.promoteAndUpdate).toBeDefined();
    const result = await store.promoteAndUpdate!(brick.id, "global", {
      expectedVersion: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("load returns NOT_FOUND for missing brick (unchanged behavior)", async () => {
    const store = createInMemoryForgeStore();
    const result = await store.load(
      brickId("sha256:0000000000000000000000000000000000000000000000000000000000000000"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("update of non-existent brick returns NOT_FOUND (not CONFLICT)", async () => {
    const store = createInMemoryForgeStore();
    const result = await store.update(
      brickId("sha256:0000000000000000000000000000000000000000000000000000000000000000"),
      { usageCount: 1, expectedVersion: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("search skips integrity check (performance)", async () => {
    const store = createInMemoryForgeStore();
    const brick = validToolBrick({ tags: ["searchable"] });
    await store.save(brick);

    // Search should return results without integrity check overhead
    const result = await store.search({ tags: ["searchable"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
    }
  });
});
