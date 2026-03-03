/**
 * Reusable contract test suite for ForgeStore implementations.
 *
 * Accepts a factory that returns a ForgeStore (sync or async).
 * Each test creates a fresh store instance for isolation.
 */

import { describe, expect, test } from "bun:test";
import type { BrickFitnessMetrics, ForgeStore, StoreChangeEvent } from "@koi/core";
import { brickId } from "@koi/core";
import { createTestSkillArtifact, createTestToolArtifact } from "./brick-artifacts.js";

function createBrick(overrides?: Partial<Parameters<typeof createTestToolArtifact>[0]>) {
  return createTestToolArtifact({
    id: brickId(`brick_${Math.random().toString(36).slice(2, 10)}`),
    name: "test-brick",
    description: "A test brick",
    ...overrides,
  });
}

function createSkillBrick(overrides?: Partial<Parameters<typeof createTestSkillArtifact>[0]>) {
  return createTestSkillArtifact({
    id: brickId(`brick_${Math.random().toString(36).slice(2, 10)}`),
    ...overrides,
  });
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
      const brick = createBrick({ id: brickId("brick_rt") });
      const saveResult = await store.save(brick);
      expect(saveResult.ok).toBe(true);

      const loadResult = await store.load(brickId("brick_rt"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.id).toBe(brickId("brick_rt"));
        expect(loadResult.value.name).toBe("test-brick");
      }
    });

    test("load returns NOT_FOUND for missing id", async () => {
      const store = await createStore();
      const result = await store.load(brickId("nonexistent"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("search with empty query returns all", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1") }));
      await store.save(createBrick({ id: brickId("b2") }));

      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    test("search filters by kind", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1") }));
      await store.save(createSkillBrick({ id: brickId("b2") }));

      const result = await store.search({ kind: "tool" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.kind).toBe("tool");
      }
    });

    test("search filters by scope", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1"), scope: "agent" }));
      await store.save(createBrick({ id: brickId("b2"), scope: "global" }));

      const result = await store.search({ scope: "global" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.scope).toBe("global");
      }
    });

    test("search filters by tags (AND match)", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1"), tags: ["math", "calc"] }));
      await store.save(createBrick({ id: brickId("b2"), tags: ["math"] }));
      await store.save(createBrick({ id: brickId("b3"), tags: ["text"] }));

      const result = await store.search({ tags: ["math", "calc"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe(brickId("b1"));
      }
    });

    test("search respects limit", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1") }));
      await store.save(createBrick({ id: brickId("b2") }));
      await store.save(createBrick({ id: brickId("b3") }));

      const result = await store.search({ limit: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    test("remove deletes from results", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1") }));
      await store.remove(brickId("b1"));

      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    test("remove returns NOT_FOUND for missing", async () => {
      const store = await createStore();
      const result = await store.remove(brickId("nonexistent"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("update modifies specific fields", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1"), lifecycle: "active", usageCount: 0 }));

      const updateResult = await store.update(brickId("b1"), {
        lifecycle: "deprecated",
        usageCount: 5,
      });
      expect(updateResult.ok).toBe(true);

      const loadResult = await store.load(brickId("b1"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.lifecycle).toBe("deprecated");
        expect(loadResult.value.usageCount).toBe(5);
        expect(loadResult.value.name).toBe("test-brick"); // unchanged
      }
    });

    test("update modifies tags", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1"), tags: ["original"] }));

      const updateResult = await store.update(brickId("b1"), { tags: ["original", "zone:team-a"] });
      expect(updateResult.ok).toBe(true);

      const loadResult = await store.load(brickId("b1"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.tags).toContain("original");
        expect(loadResult.value.tags).toContain("zone:team-a");
        expect(loadResult.value.tags.length).toBe(2);
      }
    });

    test("update returns NOT_FOUND for missing id", async () => {
      const store = await createStore();
      const result = await store.update(brickId("nonexistent"), { usageCount: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("exists returns true for saved brick", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1") }));

      const result = await store.exists(brickId("b1"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    test("exists returns false for missing id", async () => {
      const store = await createStore();
      const result = await store.exists(brickId("nonexistent"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    test("save with existing id overwrites", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b1"), name: "original" }));
      await store.save(createBrick({ id: brickId("b1"), name: "updated" }));

      const result = await store.load(brickId("b1"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("updated");
      }
    });
    test("search respects orderBy: usage", async () => {
      const store = await createStore();
      await store.save(createBrick({ id: brickId("b_u1"), usageCount: 3 }));
      await store.save(createBrick({ id: brickId("b_u2"), usageCount: 10 }));
      await store.save(createBrick({ id: brickId("b_u3"), usageCount: 1 }));

      const result = await store.search({ orderBy: "usage" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        expect(result.value[0]?.id).toBe(brickId("b_u2"));
        expect(result.value[1]?.id).toBe(brickId("b_u1"));
        expect(result.value[2]?.id).toBe(brickId("b_u3"));
      }
    });

    test("search filters by minFitnessScore", async () => {
      const store = await createStore();
      const highFitness: BrickFitnessMetrics = {
        successCount: 90,
        errorCount: 10,
        latency: { samples: [], count: 0, cap: 200 },
        lastUsedAt: Date.now(),
      };
      const lowFitness: BrickFitnessMetrics = {
        successCount: 1,
        errorCount: 99,
        latency: { samples: [], count: 0, cap: 200 },
        lastUsedAt: Date.now() - 86_400_000 * 365,
      };

      await store.save(createBrick({ id: brickId("b_high"), fitness: highFitness }));
      await store.save(createBrick({ id: brickId("b_low"), fitness: lowFitness }));
      await store.save(createBrick({ id: brickId("b_none") })); // no fitness → score 0

      const result = await store.search({ minFitnessScore: 0.3 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe(brickId("b_high"));
      }
    });

    test("dispose does not throw", async () => {
      const store = await createStore();
      const disposeFn = store.dispose;
      if (disposeFn !== undefined) {
        expect(() => {
          disposeFn();
        }).not.toThrow();
      }
    });
  });

  // --- watch contract (optional — skipped if store doesn't implement it) ---

  describe("ForgeStore watch contract", () => {
    test("watch fires once per mutation with correct event", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return; // skip — store doesn't implement watch
      }

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      const testId = brickId("oc_typed");
      await store.save(createBrick({ id: testId, usageCount: 0 }));
      await store.update(testId, { usageCount: 5 });
      await store.remove(testId);

      // Events fire immediately (no debounce)
      await Bun.sleep(10);

      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ kind: "saved", brickId: testId });
      expect(events[1]).toEqual({ kind: "updated", brickId: testId });
      expect(events[2]).toEqual({ kind: "removed", brickId: testId });
    });

    test("watch fires after successful save", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      await store.save(createBrick({ id: brickId("oc_save") }));
      await Bun.sleep(10);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("saved");
    });

    test("watch fires after successful remove", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      await store.save(createBrick({ id: brickId("oc_rm") }));

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      await store.remove(brickId("oc_rm"));
      await Bun.sleep(10);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("removed");
    });

    test("watch fires after successful update", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      await store.save(createBrick({ id: brickId("oc_up"), usageCount: 0 }));

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      await store.update(brickId("oc_up"), { usageCount: 5 });
      await Bun.sleep(10);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("updated");
    });

    test("watch does NOT fire after failed operations", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      // These should fail (NOT_FOUND) and NOT trigger watch
      await store.remove(brickId("nonexistent"));
      await store.update(brickId("nonexistent"), { usageCount: 1 });
      await Bun.sleep(10);
      expect(events).toHaveLength(0);
    });

    test("rapid mutations fire one event each (no debounce)", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      // Rapid-fire 3 saves — each fires immediately
      await store.save(createBrick({ id: brickId("oc_d1") }));
      await store.save(createBrick({ id: brickId("oc_d2") }));
      await store.save(createBrick({ id: brickId("oc_d3") }));

      await Bun.sleep(10);
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.kind === "saved")).toBe(true);
    });

    test("unsubscribe prevents further notifications", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      const events: StoreChangeEvent[] = [];
      const unsub = store.watch((event) => {
        events.push(event);
      });

      await store.save(createBrick({ id: brickId("oc_unsub1") }));
      await Bun.sleep(10);
      expect(events).toHaveLength(1);

      unsub();

      await store.save(createBrick({ id: brickId("oc_unsub2") }));
      await Bun.sleep(10);
      expect(events).toHaveLength(1); // unchanged
    });

    test("multiple listeners all receive notifications", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      const events1: StoreChangeEvent[] = [];
      const events2: StoreChangeEvent[] = [];
      store.watch((event) => {
        events1.push(event);
      });
      store.watch((event) => {
        events2.push(event);
      });

      await store.save(createBrick({ id: brickId("oc_multi") }));
      await Bun.sleep(10);
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------

  describe("concurrency", () => {
    test("parallel save of same BrickId — last write wins", async () => {
      const store = await createStore();
      const id = brickId("conc_same");

      const brickA = createBrick({ id, name: "version-A" });
      const brickB = createBrick({ id, name: "version-B" });

      await Promise.all([store.save(brickA), store.save(brickB)]);

      const result = await store.load(id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Either A or B wins — both are valid, no corruption
        expect(["version-A", "version-B"]).toContain(result.value.name);
      }
    });

    test("parallel search during concurrent saves", async () => {
      const store = await createStore();

      // Seed some initial data
      await store.save(createBrick({ id: brickId("conc_s1") }));
      await store.save(createBrick({ id: brickId("conc_s2") }));

      // Run saves and searches in parallel
      const ops = [
        store.save(createBrick({ id: brickId("conc_s3") })),
        store.search({}),
        store.save(createBrick({ id: brickId("conc_s4") })),
        store.search({}),
      ];

      const results = await Promise.all(ops);
      // All operations should succeed without throwing
      for (const r of results) {
        expect(r.ok).toBe(true);
      }
    });

    test("parallel remove + load race", async () => {
      const store = await createStore();
      const id = brickId("conc_rl");
      await store.save(createBrick({ id }));

      const [removeResult, loadResult] = await Promise.all([store.remove(id), store.load(id)]);

      // Remove should succeed
      expect(removeResult.ok).toBe(true);
      // Load may succeed (before remove) or fail (after remove) — both valid
      if (!loadResult.ok) {
        expect(loadResult.error.code).toBe("NOT_FOUND");
      }
    });
  });
}
