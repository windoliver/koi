/**
 * Shared ForgeStore contract test suite.
 *
 * Tests all interface-level behaviors of ForgeStore implementations:
 * save/load roundtrip, search with all filter dimensions, update,
 * remove, exists, watch notifications, concurrent operations, and
 * edge cases. Any store backend (in-memory, filesystem, SQLite)
 * can plug in via the factory parameter.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ForgeProvenance, ForgeStore, StoreChangeEvent } from "@koi/core";
import { brickId } from "@koi/core";
import {
  createTestSkillArtifact,
  createTestToolArtifact,
  DEFAULT_PROVENANCE,
} from "@koi/test-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique brick IDs to avoid collisions across tests. */
let counter = 0;
function nextId(): ReturnType<typeof brickId> {
  counter += 1;
  return brickId(`contract_${counter}_${Math.random().toString(36).slice(2, 8)}`);
}

function toolBrick(
  overrides?: Partial<Parameters<typeof createTestToolArtifact>[0]>,
): ReturnType<typeof createTestToolArtifact> {
  return createTestToolArtifact({ id: nextId(), name: "contract-tool", ...overrides });
}

function skillBrick(
  overrides?: Partial<Parameters<typeof createTestSkillArtifact>[0]>,
): ReturnType<typeof createTestSkillArtifact> {
  return createTestSkillArtifact({ id: nextId(), name: "contract-skill", ...overrides });
}

function provenanceWith(patch: Partial<ForgeProvenance>): ForgeProvenance {
  return { ...DEFAULT_PROVENANCE, ...patch };
}

// ---------------------------------------------------------------------------
// Public contract test factory
// ---------------------------------------------------------------------------

/**
 * Define the full ForgeStore contract test suite under a `describe()` block.
 *
 * @param name    - Display name for the describe block (e.g., "InMemoryForgeStore").
 * @param createStore - Factory that returns a fresh, isolated store instance.
 * @param cleanup - Optional teardown called after each test (e.g., rm temp dirs).
 */
export function describeForgeStoreContract(
  name: string,
  createStore: () => ForgeStore | Promise<ForgeStore>,
  cleanup?: () => Promise<void>,
): void {
  describe(`ForgeStore contract: ${name}`, () => {
    if (cleanup !== undefined) {
      afterEach(async () => {
        await cleanup();
      });
    }

    // -----------------------------------------------------------------------
    // save / load roundtrip
    // -----------------------------------------------------------------------

    test("save and load roundtrip preserves all fields", async () => {
      const store = await createStore();
      const brick = toolBrick({
        id: brickId("rt_1"),
        name: "roundtrip-tool",
        description: "roundtrip description",
        scope: "global",
        trustTier: "verified",
        lifecycle: "active",
        tags: ["alpha", "beta"],
        usageCount: 42,
      });

      const saveResult = await store.save(brick);
      expect(saveResult.ok).toBe(true);

      const loadResult = await store.load(brickId("rt_1"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.id).toBe(brickId("rt_1"));
        expect(loadResult.value.name).toBe("roundtrip-tool");
        expect(loadResult.value.description).toBe("roundtrip description");
        expect(loadResult.value.scope).toBe("global");
        expect(loadResult.value.trustTier).toBe("verified");
        expect(loadResult.value.lifecycle).toBe("active");
        expect(loadResult.value.tags).toEqual(["alpha", "beta"]);
        expect(loadResult.value.usageCount).toBe(42);
        expect(loadResult.value.kind).toBe("tool");
      }
    });

    test("save overwrites existing brick with same id", async () => {
      const store = await createStore();
      const id = brickId("overwrite_1");
      await store.save(toolBrick({ id, name: "original" }));
      await store.save(toolBrick({ id, name: "replaced" }));

      const result = await store.load(id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("replaced");
      }
    });

    // -----------------------------------------------------------------------
    // search — filter dimensions
    // -----------------------------------------------------------------------

    test("search with empty query returns all bricks", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("all_1") }));
      await store.save(toolBrick({ id: brickId("all_2") }));
      await store.save(skillBrick({ id: brickId("all_3") }));

      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
      }
    });

    test("search filters by kind", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("kind_1") }));
      await store.save(skillBrick({ id: brickId("kind_2") }));

      const result = await store.search({ kind: "tool" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.kind).toBe("tool");
      }
    });

    test("search filters by scope", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("scope_1"), scope: "agent" }));
      await store.save(toolBrick({ id: brickId("scope_2"), scope: "global" }));
      await store.save(toolBrick({ id: brickId("scope_3"), scope: "zone" }));

      const result = await store.search({ scope: "global" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.scope).toBe("global");
      }
    });

    test("search filters by trustTier", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("tt_1"), trustTier: "sandbox" }));
      await store.save(toolBrick({ id: brickId("tt_2"), trustTier: "verified" }));
      await store.save(toolBrick({ id: brickId("tt_3"), trustTier: "promoted" }));

      const result = await store.search({ trustTier: "verified" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.trustTier).toBe("verified");
      }
    });

    test("search filters by lifecycle", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("lc_1"), lifecycle: "active" }));
      await store.save(toolBrick({ id: brickId("lc_2"), lifecycle: "deprecated" }));

      const result = await store.search({ lifecycle: "deprecated" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.lifecycle).toBe("deprecated");
      }
    });

    test("search filters by tags (AND-subset match)", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("tag_1"), tags: ["math", "calc", "util"] }));
      await store.save(toolBrick({ id: brickId("tag_2"), tags: ["math"] }));
      await store.save(toolBrick({ id: brickId("tag_3"), tags: ["text"] }));

      const result = await store.search({ tags: ["math", "calc"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe(brickId("tag_1"));
      }
    });

    test("search filters by text (case-insensitive substring on name)", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("txt_1"), name: "FetchWeather" }));
      await store.save(toolBrick({ id: brickId("txt_2"), name: "ParseJSON" }));

      const result = await store.search({ text: "weather" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.name).toBe("FetchWeather");
      }
    });

    test("search filters by text matching description", async () => {
      const store = await createStore();
      await store.save(
        toolBrick({ id: brickId("txtd_1"), name: "tool-a", description: "Handles payment flows" }),
      );
      await store.save(
        toolBrick({ id: brickId("txtd_2"), name: "tool-b", description: "Logs metrics" }),
      );

      const result = await store.search({ text: "payment" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe(brickId("txtd_1"));
      }
    });

    test("search filters by createdBy (provenance.metadata.agentId)", async () => {
      const store = await createStore();
      const provenanceA = provenanceWith({
        metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-alpha" },
      });
      const provenanceB = provenanceWith({
        metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-beta" },
      });
      await store.save(toolBrick({ id: brickId("cb_1"), provenance: provenanceA }));
      await store.save(toolBrick({ id: brickId("cb_2"), provenance: provenanceB }));

      const result = await store.search({ createdBy: "agent-alpha" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.provenance.metadata.agentId).toBe("agent-alpha");
      }
    });

    test("search filters by classification", async () => {
      const store = await createStore();
      const publicProv = provenanceWith({ classification: "public" });
      const secretProv = provenanceWith({ classification: "secret" });
      await store.save(toolBrick({ id: brickId("cls_1"), provenance: publicProv }));
      await store.save(toolBrick({ id: brickId("cls_2"), provenance: secretProv }));

      const result = await store.search({ classification: "secret" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.provenance.classification).toBe("secret");
      }
    });

    test("search filters by contentMarkers (AND-subset match)", async () => {
      const store = await createStore();
      const piiProv = provenanceWith({ contentMarkers: ["pii", "credentials"] });
      const payProv = provenanceWith({ contentMarkers: ["payment"] });
      await store.save(toolBrick({ id: brickId("cm_1"), provenance: piiProv }));
      await store.save(toolBrick({ id: brickId("cm_2"), provenance: payProv }));

      const result = await store.search({ contentMarkers: ["pii"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe(brickId("cm_1"));
      }
    });

    test("search respects limit", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("lim_1") }));
      await store.save(toolBrick({ id: brickId("lim_2") }));
      await store.save(toolBrick({ id: brickId("lim_3") }));

      const result = await store.search({ limit: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    test("search with combined filters narrows results", async () => {
      const store = await createStore();
      await store.save(
        toolBrick({
          id: brickId("combo_1"),
          scope: "global",
          lifecycle: "active",
          tags: ["perf"],
        }),
      );
      await store.save(
        toolBrick({
          id: brickId("combo_2"),
          scope: "global",
          lifecycle: "deprecated",
          tags: ["perf"],
        }),
      );
      await store.save(
        toolBrick({
          id: brickId("combo_3"),
          scope: "agent",
          lifecycle: "active",
          tags: ["perf"],
        }),
      );

      const result = await store.search({ scope: "global", lifecycle: "active", tags: ["perf"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.id).toBe(brickId("combo_1"));
      }
    });

    // -----------------------------------------------------------------------
    // update
    // -----------------------------------------------------------------------

    test("update modifies lifecycle", async () => {
      const store = await createStore();
      const id = brickId("up_lc");
      await store.save(toolBrick({ id, lifecycle: "active" }));

      const updateResult = await store.update(id, { lifecycle: "deprecated" });
      expect(updateResult.ok).toBe(true);

      const loadResult = await store.load(id);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.lifecycle).toBe("deprecated");
      }
    });

    test("update modifies trustTier", async () => {
      const store = await createStore();
      const id = brickId("up_tt");
      await store.save(toolBrick({ id, trustTier: "sandbox" }));

      await store.update(id, { trustTier: "verified" });

      const loadResult = await store.load(id);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.trustTier).toBe("verified");
      }
    });

    test("update modifies scope", async () => {
      const store = await createStore();
      const id = brickId("up_scope");
      await store.save(toolBrick({ id, scope: "agent" }));

      await store.update(id, { scope: "global" });

      const loadResult = await store.load(id);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.scope).toBe("global");
      }
    });

    test("update modifies usageCount", async () => {
      const store = await createStore();
      const id = brickId("up_uc");
      await store.save(toolBrick({ id, usageCount: 0 }));

      await store.update(id, { usageCount: 10 });

      const loadResult = await store.load(id);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.usageCount).toBe(10);
      }
    });

    test("update modifies tags", async () => {
      const store = await createStore();
      const id = brickId("up_tags");
      await store.save(toolBrick({ id, tags: ["original"] }));

      await store.update(id, { tags: ["original", "zone:team-a"] });

      const loadResult = await store.load(id);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.tags).toContain("original");
        expect(loadResult.value.tags).toContain("zone:team-a");
        expect(loadResult.value.tags.length).toBe(2);
      }
    });

    test("update modifies lastVerifiedAt", async () => {
      const store = await createStore();
      const id = brickId("up_lva");
      await store.save(toolBrick({ id }));
      const now = Date.now();

      await store.update(id, { lastVerifiedAt: now });

      const loadResult = await store.load(id);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.lastVerifiedAt).toBe(now);
      }
    });

    test("update preserves fields not included in the patch", async () => {
      const store = await createStore();
      const id = brickId("up_preserve");
      await store.save(toolBrick({ id, name: "keep-me", lifecycle: "active", usageCount: 5 }));

      await store.update(id, { lifecycle: "deprecated" });

      const loadResult = await store.load(id);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.lifecycle).toBe("deprecated");
        expect(loadResult.value.name).toBe("keep-me");
        expect(loadResult.value.usageCount).toBe(5);
      }
    });

    // -----------------------------------------------------------------------
    // remove
    // -----------------------------------------------------------------------

    test("remove then load returns NOT_FOUND", async () => {
      const store = await createStore();
      const id = brickId("rm_1");
      await store.save(toolBrick({ id }));

      const removeResult = await store.remove(id);
      expect(removeResult.ok).toBe(true);

      const loadResult = await store.load(id);
      expect(loadResult.ok).toBe(false);
      if (!loadResult.ok) {
        expect(loadResult.error.code).toBe("NOT_FOUND");
      }
    });

    // -----------------------------------------------------------------------
    // exists
    // -----------------------------------------------------------------------

    test("exists returns true for a saved brick", async () => {
      const store = await createStore();
      const id = brickId("ex_1");
      await store.save(toolBrick({ id }));

      const result = await store.exists(id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    test("exists returns false for unknown id", async () => {
      const store = await createStore();
      const result = await store.exists(brickId("ex_unknown"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    // -----------------------------------------------------------------------
    // watch notifications
    // -----------------------------------------------------------------------

    test("watch fires saved event after save", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return; // store does not implement watch — skip
      }

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      const id = brickId("w_save");
      await store.save(toolBrick({ id }));
      await Bun.sleep(10);

      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("saved");
      expect(events[0]?.brickId).toBe(id);
    });

    test("watch fires updated event after update", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      const id = brickId("w_update");
      await store.save(toolBrick({ id, usageCount: 0 }));

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      await store.update(id, { usageCount: 7 });
      await Bun.sleep(10);

      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("updated");
      expect(events[0]?.brickId).toBe(id);
    });

    test("watch fires removed event after remove", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      const id = brickId("w_remove");
      await store.save(toolBrick({ id }));

      const events: StoreChangeEvent[] = [];
      store.watch((event) => {
        events.push(event);
      });

      await store.remove(id);
      await Bun.sleep(10);

      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("removed");
      expect(events[0]?.brickId).toBe(id);
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

      await store.remove(brickId("w_ghost"));
      await store.update(brickId("w_ghost"), { usageCount: 1 });
      await Bun.sleep(10);

      expect(events.length).toBe(0);
    });

    test("unsubscribe prevents further watch notifications", async () => {
      const store = await createStore();
      if (store.watch === undefined) {
        return;
      }

      const events: StoreChangeEvent[] = [];
      const unsub = store.watch((event) => {
        events.push(event);
      });

      await store.save(toolBrick({ id: brickId("w_unsub1") }));
      await Bun.sleep(10);
      expect(events.length).toBe(1);

      unsub();

      await store.save(toolBrick({ id: brickId("w_unsub2") }));
      await Bun.sleep(10);
      expect(events.length).toBe(1); // unchanged
    });

    // -----------------------------------------------------------------------
    // concurrent operations
    // -----------------------------------------------------------------------

    test("concurrent saves are all retrievable", async () => {
      const store = await createStore();
      const idA = brickId("conc_a");
      const idB = brickId("conc_b");

      await Promise.all([
        store.save(toolBrick({ id: idA, name: "brick-a" })),
        store.save(toolBrick({ id: idB, name: "brick-b" })),
      ]);

      const [resultA, resultB] = await Promise.all([store.load(idA), store.load(idB)]);

      expect(resultA.ok).toBe(true);
      expect(resultB.ok).toBe(true);
      if (resultA.ok) {
        expect(resultA.value.name).toBe("brick-a");
      }
      if (resultB.ok) {
        expect(resultB.value.name).toBe("brick-b");
      }
    });

    // -----------------------------------------------------------------------
    // edge cases
    // -----------------------------------------------------------------------

    test("load non-existent id returns NOT_FOUND", async () => {
      const store = await createStore();
      const result = await store.load(brickId("edge_missing"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("remove non-existent id returns NOT_FOUND", async () => {
      const store = await createStore();
      const result = await store.remove(brickId("edge_rm_missing"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("update non-existent id returns NOT_FOUND", async () => {
      const store = await createStore();
      const result = await store.update(brickId("edge_up_missing"), { usageCount: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("search returns empty array when no bricks match", async () => {
      const store = await createStore();
      await store.save(toolBrick({ id: brickId("edge_nomatch"), scope: "agent" }));

      const result = await store.search({ scope: "global" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });
  });
}
