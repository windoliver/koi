/**
 * Reusable contract test suite for ForgeStore implementations.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeStore } from "../store.js";
import type { BrickArtifact } from "../types.js";

function createBrick(overrides?: Partial<BrickArtifact>): BrickArtifact {
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
    implementation: "return 1;",
    ...overrides,
  };
}

export function runForgeStoreContractTests(createStore: () => ForgeStore): void {
  describe("ForgeStore contract", () => {
    test("save and load round-trip", async () => {
      const store = createStore();
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
      const store = createStore();
      const result = await store.load("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("search with empty query returns all", async () => {
      const store = createStore();
      await store.save(createBrick({ id: "b1" }));
      await store.save(createBrick({ id: "b2" }));

      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    test("search filters by kind", async () => {
      const store = createStore();
      await store.save(createBrick({ id: "b1", kind: "tool" }));
      await store.save(createBrick({ id: "b2", kind: "skill" }));

      const result = await store.search({ kind: "tool" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.kind).toBe("tool");
      }
    });

    test("search filters by scope", async () => {
      const store = createStore();
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
      const store = createStore();
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
      const store = createStore();
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
      const store = createStore();
      await store.save(createBrick({ id: "b1" }));
      await store.remove("b1");

      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    test("remove returns NOT_FOUND for missing", async () => {
      const store = createStore();
      const result = await store.remove("nonexistent");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("update modifies specific fields", async () => {
      const store = createStore();
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

    test("update returns NOT_FOUND for missing id", async () => {
      const store = createStore();
      const result = await store.update("nonexistent", { usageCount: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("save with existing id overwrites", async () => {
      const store = createStore();
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
