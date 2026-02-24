/**
 * Reusable contract test suite for ForgeStore implementations.
 *
 * Accepts a factory that returns a ForgeStore (sync or async).
 * Each test creates a fresh store instance for isolation.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeStore, SkillArtifact, ToolArtifact } from "@koi/core";

function createBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function createSkillBrick(overrides?: Partial<SkillArtifact>): SkillArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "skill",
    name: "test-skill",
    description: "A test skill",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    content: "# Test Skill",
    ...overrides,
  };
}

/**
 * Run the ForgeStore contract test suite against any implementation.
 *
 * The factory can be sync or async — async factories are useful for
 * filesystem/database stores that need setup (e.g., temp directory creation).
 */
export function runForgeStoreContractTests(
  createStore: () => ForgeStore | Promise<ForgeStore>,
): void {
  describe("ForgeStore contract", () => {
    test("save and load round-trip", async () => {
      const store = await createStore();
      const brick = createBrick({ id: "brick_rt" });
      const saveResult = await store.save(brick);
      expect(saveResult.ok).toBe(true);

      const loadResult = await store.load("brick_rt");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.id).toBe("brick_rt");
        expect(loadResult.value.name).toBe("test-brick");
      }
    });

    test("load returns NOT_FOUND for missing id", async () => {
      const store = await createStore();
      const result = await store.load("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("search with empty query returns all", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1" }));
      await store.save(createBrick({ id: "b2" }));

      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    test("search filters by kind", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1" }));
      await store.save(createSkillBrick({ id: "b2" }));

      const result = await store.search({ kind: "tool" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.kind).toBe("tool");
      }
    });

    test("search filters by scope", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1", scope: "agent" }));
      await store.save(createBrick({ id: "b2", scope: "global" }));

      const result = await store.search({ scope: "global" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.scope).toBe("global");
      }
    });

    test("search filters by tags (AND match)", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1", tags: ["math", "calc"] }));
      await store.save(createBrick({ id: "b2", tags: ["math"] }));
      await store.save(createBrick({ id: "b3", tags: ["text"] }));

      const result = await store.search({ tags: ["math", "calc"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe("b1");
      }
    });

    test("search respects limit", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1" }));
      await store.save(createBrick({ id: "b2" }));
      await store.save(createBrick({ id: "b3" }));

      const result = await store.search({ limit: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    test("remove deletes from results", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1" }));
      await store.remove("b1");

      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    test("remove returns NOT_FOUND for missing", async () => {
      const store = await createStore();
      const result = await store.remove("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("update modifies specific fields", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1", lifecycle: "active", usageCount: 0 }));

      const updateResult = await store.update("b1", { lifecycle: "deprecated", usageCount: 5 });
      expect(updateResult.ok).toBe(true);

      const loadResult = await store.load("b1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.lifecycle).toBe("deprecated");
        expect(loadResult.value.usageCount).toBe(5);
        expect(loadResult.value.name).toBe("test-brick"); // unchanged
      }
    });

    test("update modifies tags", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1", tags: ["original"] }));

      const updateResult = await store.update("b1", { tags: ["original", "zone:team-a"] });
      expect(updateResult.ok).toBe(true);

      const loadResult = await store.load("b1");
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.tags).toContain("original");
        expect(loadResult.value.tags).toContain("zone:team-a");
        expect(loadResult.value.tags.length).toBe(2);
      }
    });

    test("update returns NOT_FOUND for missing id", async () => {
      const store = await createStore();
      const result = await store.update("nonexistent", { usageCount: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("exists returns true for saved brick", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1" }));

      const result = await store.exists("b1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    test("exists returns false for missing id", async () => {
      const store = await createStore();
      const result = await store.exists("nonexistent");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    test("save with existing id overwrites", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: "b1", name: "original" }));
      await store.save(createBrick({ id: "b1", name: "updated" }));

      const result = await store.load("b1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("updated");
      }
    });
  });
}
