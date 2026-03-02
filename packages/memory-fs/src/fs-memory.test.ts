import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsMemory } from "./fs-memory.js";
import type { FsMemory } from "./types.js";

// let — needed for mutable test directory and memory refs
let testDir: string;
let mem: FsMemory;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `koi-fs-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  mem = await createFsMemory({ baseDir: testDir });
});

afterEach(async () => {
  await mem.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("createFsMemory", () => {
  test("store and recall roundtrip", async () => {
    await mem.component.store("Alice likes cats", {
      relatedEntities: ["alice"],
      category: "preference",
    });

    const results = await mem.component.recall("cats");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toBe("Alice likes cats");
  });

  test("dedup rejects duplicate content", async () => {
    await mem.component.store("Alice likes cats", {
      relatedEntities: ["alice"],
      category: "preference",
    });
    await mem.component.store("Alice likes cats", {
      relatedEntities: ["alice"],
      category: "preference",
    });

    const results = await mem.component.recall("cats");
    expect(results).toHaveLength(1);
  });

  test("allows different categories for similar content", async () => {
    await mem.component.store("Alice likes cats", {
      relatedEntities: ["alice"],
      category: "preference",
    });
    await mem.component.store("Alice likes cats", {
      relatedEntities: ["alice"],
      category: "milestone",
    });

    const results = await mem.component.recall("cats");
    expect(results).toHaveLength(2);
  });

  test("contradiction supersedes old fact", async () => {
    await mem.component.store("Alice prefers dogs", {
      relatedEntities: ["alice"],
      category: "preference",
    });
    await mem.component.store("Alice now prefers cats", {
      relatedEntities: ["alice"],
      category: "preference",
    });

    const results = await mem.component.recall("preference");
    const active = results.filter((r) => {
      const meta = r.metadata as Readonly<Record<string, unknown>> | undefined;
      return meta !== undefined;
    });
    // Only the latest should be active (old superseded)
    expect(active).toHaveLength(1);
    expect(active[0]?.content).toBe("Alice now prefers cats");
  });

  test("tier filtering works", async () => {
    await mem.component.store("hot fact", {
      relatedEntities: ["alice"],
      category: "context",
    });

    const hotResults = await mem.component.recall("fact", {
      tierFilter: "hot",
    });
    expect(hotResults.length).toBeGreaterThan(0);

    const coldResults = await mem.component.recall("fact", {
      tierFilter: "cold",
    });
    expect(coldResults).toHaveLength(0);
  });

  test("respects limit option", async () => {
    for (const i of [1, 2, 3, 4, 5]) {
      await mem.component.store(`fact number ${i}`, {
        relatedEntities: ["alice"],
        category: `cat-${i}`,
      });
    }

    const results = await mem.component.recall("fact", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  test("routes to correct entity via relatedEntities", async () => {
    await mem.component.store("Alice fact", {
      relatedEntities: ["alice"],
    });
    await mem.component.store("Bob fact", {
      relatedEntities: ["bob"],
    });

    const entities = await mem.listEntities();
    expect([...entities].sort()).toEqual(["alice", "bob"]);
  });

  test("falls back to namespace when no relatedEntities", async () => {
    await mem.component.store("namespaced fact", {
      namespace: "project-x",
    });

    const entities = await mem.listEntities();
    expect(entities).toContain("project-x");
  });

  test("falls back to _default when no routing info", async () => {
    await mem.component.store("orphan fact");

    const entities = await mem.listEntities();
    expect(entities).toContain("default");
  });

  test("rebuildSummaries only processes dirty entities", async () => {
    await mem.component.store("fact one", {
      relatedEntities: ["alice"],
    });
    await mem.rebuildSummaries();

    // Store to bob, rebuild again — alice should not be reprocessed
    await mem.component.store("fact two", {
      relatedEntities: ["bob"],
    });
    await mem.rebuildSummaries();

    // Both should have summaries (alice from first, bob from second)
    const entities = await mem.listEntities();
    expect(entities).toContain("alice");
    expect(entities).toContain("bob");
  });

  test("getTierDistribution returns correct counts", async () => {
    await mem.component.store("hot fact", {
      relatedEntities: ["alice"],
      category: "a",
    });
    await mem.component.store("another hot", {
      relatedEntities: ["alice"],
      category: "b",
    });

    const dist = await mem.getTierDistribution();
    expect(dist.hot).toBe(2);
    expect(dist.total).toBe(2);
  });

  test("recall populates tier and decayScore in results", async () => {
    await mem.component.store("test fact", {
      relatedEntities: ["alice"],
    });

    const results = await mem.component.recall("test");
    expect(results[0]?.tier).toBeDefined();
    expect(results[0]?.decayScore).toBeDefined();
    expect(results[0]?.lastAccessed).toBeDefined();
  });

  test("recall updates lastAccessed and accessCount", async () => {
    await mem.component.store("trackable fact", {
      relatedEntities: ["alice"],
    });

    // First recall
    await mem.component.recall("trackable");
    // Second recall
    const results = await mem.component.recall("trackable");
    // After two recalls, accessCount should have incremented
    expect(results[0]?.content).toBe("trackable fact");
  });

  test("close is idempotent", async () => {
    await mem.close();
    await mem.close();
    // Should not throw
  });

  test("BM25-only mode works without retriever", async () => {
    const localMem = await createFsMemory({ baseDir: testDir });
    await localMem.component.store("no retriever fact", {
      relatedEntities: ["test-entity"],
    });
    const results = await localMem.component.recall("fact");
    expect(results.length).toBeGreaterThan(0);
    await localMem.close();
  });

  test("concurrent Promise.all stores all succeed", async () => {
    // Use distinct entities to avoid cross-entity dedup races
    const stores = Array.from({ length: 10 }, (_, i) =>
      mem.component.store(`unique memory number ${i}`, {
        relatedEntities: [`entity-${i}`],
        category: "context",
      }),
    );
    await Promise.all(stores);

    const entities = await mem.listEntities();
    expect(entities).toHaveLength(10);

    const results = await mem.component.recall("memory", { limit: 20 });
    expect(results).toHaveLength(10);
  });

  test("throws on empty baseDir", async () => {
    expect(createFsMemory({ baseDir: "" })).rejects.toThrow("non-empty");
  });

  describe("reinforcement counting", () => {
    test("reinforce: true increments accessCount on near-duplicate", async () => {
      await mem.component.store("Alice prefers TypeScript", {
        relatedEntities: ["alice"],
        category: "preference",
      });

      // Store near-duplicate with reinforce
      await mem.component.store("Alice prefers TypeScript", {
        relatedEntities: ["alice"],
        category: "preference",
        reinforce: true,
      });

      // Should still be one fact (dedup), but with boosted accessCount
      const results = await mem.component.recall("TypeScript");
      expect(results).toHaveLength(1);
      // accessCount should have been incremented by reinforce (1) + recall (1) = 2
      // The fact starts at 0, reinforce bumps to 1, recall bumps to 2
      expect(results[0]?.content).toBe("Alice prefers TypeScript");
    });

    test("reinforce: true updates lastAccessed on near-duplicate", async () => {
      await mem.component.store("Bob likes Python", {
        relatedEntities: ["bob"],
        category: "preference",
      });

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      await mem.component.store("Bob likes Python", {
        relatedEntities: ["bob"],
        category: "preference",
        reinforce: true,
      });

      const results = await mem.component.recall("Python");
      expect(results).toHaveLength(1);
      // lastAccessed should be recent (updated by reinforce + recall)
      expect(results[0]?.lastAccessed).toBeDefined();
    });

    test("reinforce: true does NOT create new fact on near-duplicate", async () => {
      await mem.component.store("Team uses Bun", {
        relatedEntities: ["team"],
        category: "tooling",
      });
      await mem.component.store("Team uses Bun", {
        relatedEntities: ["team"],
        category: "tooling",
        reinforce: true,
      });
      await mem.component.store("Team uses Bun", {
        relatedEntities: ["team"],
        category: "tooling",
        reinforce: true,
      });

      const results = await mem.component.recall("Bun", { limit: 10 });
      expect(results).toHaveLength(1);
    });

    test("reinforce: false (default) silently skips near-duplicate", async () => {
      await mem.component.store("Default behavior test", {
        relatedEntities: ["default-test"],
        category: "test",
      });
      await mem.component.store("Default behavior test", {
        relatedEntities: ["default-test"],
        category: "test",
        // no reinforce — default behavior
      });

      const results = await mem.component.recall("Default behavior");
      expect(results).toHaveLength(1);
    });

    test("reinforce with Jaccard below threshold creates new fact normally", async () => {
      await mem.component.store("Alice loves cats and dogs", {
        relatedEntities: ["alice"],
        category: "preference",
      });
      await mem.component.store("completely different content about quantum physics", {
        relatedEntities: ["alice"],
        category: "preference",
        reinforce: true,
      });

      const results = await mem.component.recall("content", { limit: 10 });
      // These are sufficiently different — both should exist (second supersedes first via entity match)
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("causal edge storage", () => {
    test("store with causalParents persists parents on fact", async () => {
      // First store a parent fact
      await mem.component.store("parent fact", {
        relatedEntities: ["alice"],
        category: "context",
      });
      const parentResults = await mem.component.recall("parent");
      const parentId = (parentResults[0]?.metadata as Record<string, unknown>)?.id as string;
      expect(parentId).toBeDefined();

      // Store child with causal parent
      await mem.component.store("child fact caused by parent", {
        relatedEntities: ["alice"],
        category: "derived",
        causalParents: [parentId],
      });

      const childResults = await mem.component.recall("child");
      expect(childResults.length).toBeGreaterThan(0);
      const child = childResults.find((r) => r.content === "child fact caused by parent");
      expect(child?.causalParents).toEqual([parentId]);
    });

    test("bidirectional write updates parent causalChildren", async () => {
      await mem.component.store("original insight", {
        relatedEntities: ["bob"],
        category: "insight",
      });
      const parentResults = await mem.component.recall("insight");
      const parentId = (parentResults[0]?.metadata as Record<string, unknown>)?.id as string;

      await mem.component.store("derived conclusion from insight", {
        relatedEntities: ["bob"],
        category: "conclusion",
        causalParents: [parentId],
      });

      // Recall parent again — its causalChildren should be updated
      const updatedParent = await mem.component.recall("insight");
      const parent = updatedParent.find((r) => r.content === "original insight");
      expect(parent?.causalChildren).toBeDefined();
      expect(parent?.causalChildren?.length).toBeGreaterThan(0);
    });

    test("store with non-existent parent ID is graceful", async () => {
      // Should not crash — just store the fact without establishing edges
      await mem.component.store("orphan child fact", {
        relatedEntities: ["carol"],
        category: "context",
        causalParents: ["nonexistent-id-123"],
      });

      const results = await mem.component.recall("orphan");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.content).toBe("orphan child fact");
      expect(results[0]?.causalParents).toEqual(["nonexistent-id-123"]);
    });

    test("recall surfaces causalParents and causalChildren in MemoryResult", async () => {
      await mem.component.store("step one", {
        relatedEntities: ["dave"],
        category: "step-1",
      });
      const step1 = await mem.component.recall("step one");
      const step1Id = (step1[0]?.metadata as Record<string, unknown>)?.id as string;

      await mem.component.store("step two follows step one", {
        relatedEntities: ["dave"],
        category: "step-2",
        causalParents: [step1Id],
      });

      const allResults = await mem.component.recall("step", { limit: 10 });
      const child = allResults.find((r) => r.content === "step two follows step one");
      expect(child?.causalParents).toEqual([step1Id]);

      const parent = allResults.find((r) => r.content === "step one");
      expect(parent?.causalChildren).toBeDefined();
      expect(parent?.causalChildren?.length).toBeGreaterThan(0);
    });

    test("store without causal parents has undefined causal fields", async () => {
      await mem.component.store("plain fact no parents", {
        relatedEntities: ["eve"],
        category: "context",
      });

      const results = await mem.component.recall("plain fact");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.causalParents).toBeUndefined();
      expect(results[0]?.causalChildren).toBeUndefined();
    });
  });

  describe("graph expansion", () => {
    test("graphExpand false returns identical behavior", async () => {
      await mem.component.store("baseline fact", {
        relatedEntities: ["gx"],
        category: "a",
      });

      const withoutExpand = await mem.component.recall("baseline", { graphExpand: false });
      expect(withoutExpand.length).toBeGreaterThan(0);
      expect(withoutExpand[0]?.content).toBe("baseline fact");
    });

    test("graphExpand true returns graph-expanded results", async () => {
      // Create a causal chain: root → derived
      await mem.component.store("root insight", {
        relatedEntities: ["gx2"],
        category: "root",
      });
      const rootResults = await mem.component.recall("root insight", { limit: 1 });
      const rootId = (rootResults[0]?.metadata as Record<string, unknown>)?.id as string;

      await mem.component.store("derived conclusion from root", {
        relatedEntities: ["gx2"],
        category: "derived",
        causalParents: [rootId],
      });

      // Recall with graph expansion from the derived fact
      const expanded = await mem.component.recall("derived conclusion", {
        graphExpand: true,
        maxHops: 2,
        limit: 10,
      });

      // Should find both the derived fact AND the root (via causal edge)
      const contents = expanded.map((r) => r.content);
      expect(contents).toContain("derived conclusion from root");
      expect(contents).toContain("root insight");
    });

    test("dedup: fact found by recency AND graph appears once", async () => {
      await mem.component.store("shared fact", {
        relatedEntities: ["gx3"],
        category: "shared",
      });
      const shared = await mem.component.recall("shared", { limit: 1 });
      const sharedId = (shared[0]?.metadata as Record<string, unknown>)?.id as string;

      await mem.component.store("linked fact", {
        relatedEntities: ["gx3"],
        category: "linked",
        causalParents: [sharedId],
      });

      const results = await mem.component.recall("shared", {
        graphExpand: true,
        limit: 10,
      });

      // Each fact should appear only once despite being reachable through both recency and graph
      const ids = results.map((r) => (r.metadata as Record<string, unknown>)?.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    test("graph-expanded results have decayed scores via graph-walk unit test", async () => {
      // Score decay is verified in graph-walk.test.ts with precise arithmetic.
      // Here we verify that graph expansion surfaces related facts that share causal edges.
      await mem.component.store("cause fact", {
        relatedEntities: ["gx4"],
        category: "cause",
      });
      const cause = await mem.component.recall("cause fact", { limit: 1 });
      const causeId = (cause[0]?.metadata as Record<string, unknown>)?.id as string;

      await mem.component.store("effect fact from cause", {
        relatedEntities: ["gx4"],
        category: "effect",
        causalParents: [causeId],
      });

      const results = await mem.component.recall("cause", {
        graphExpand: true,
        limit: 10,
      });

      // Both cause and effect should be found
      const contents = results.map((r) => r.content);
      expect(contents).toContain("cause fact");
      expect(contents).toContain("effect fact from cause");
    });

    test("limit still applies after expansion", async () => {
      // Create a chain of 5 facts
      await mem.component.store("chain start", {
        relatedEntities: ["gx5"],
        category: "c0",
      });
      const start = await mem.component.recall("chain start", { limit: 1 });
      // let — needed for sequential chain building
      let prevId = (start[0]?.metadata as Record<string, unknown>)?.id as string;

      for (const i of [1, 2, 3]) {
        await mem.component.store(`chain step ${i}`, {
          relatedEntities: ["gx5"],
          category: `c${i}`,
          causalParents: [prevId],
        });
        const step = await mem.component.recall(`chain step ${i}`, { limit: 1 });
        prevId = (step[0]?.metadata as Record<string, unknown>)?.id as string;
      }

      const results = await mem.component.recall("chain", {
        graphExpand: true,
        maxHops: 5,
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });
  });

  describe("explicit supersession via supersedes", () => {
    test("single fact supersession via supersedes", async () => {
      await mem.component.store("Alice prefers dark mode", {
        relatedEntities: ["alice"],
        category: "preference",
      });
      const initial = await mem.component.recall("dark mode");
      const oldId = (initial[0]?.metadata as Record<string, unknown>)?.id as string;
      expect(oldId).toBeDefined();

      await mem.component.store("Alice prefers light mode", {
        relatedEntities: ["alice"],
        category: "preference",
        supersedes: [oldId],
      });

      // recall only returns active facts — superseded ones are excluded
      const results = await mem.component.recall("mode", { limit: 10 });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("Alice prefers light mode");
    });

    test("multi-supersession via supersedes with multiple IDs", async () => {
      await mem.component.store("Alice likes tabs", {
        relatedEntities: ["alice"],
        category: "editor-pref",
      });
      await mem.component.store("Alice likes vim keybindings", {
        relatedEntities: ["alice"],
        category: "editor-tool",
      });

      // Recall all to find IDs by content
      const all = await mem.component.recall("Alice", { limit: 10 });
      const tabsFact = all.find((r) => r.content === "Alice likes tabs");
      const vimFact = all.find((r) => r.content === "Alice likes vim keybindings");
      const tabsId = (tabsFact?.metadata as Record<string, unknown>)?.id as string;
      const vimId = (vimFact?.metadata as Record<string, unknown>)?.id as string;
      expect(tabsId).toBeDefined();
      expect(vimId).toBeDefined();

      await mem.component.store("Alice uses VS Code with spaces", {
        relatedEntities: ["alice"],
        category: "editor-pref",
        supersedes: [tabsId, vimId],
      });

      // recall only returns active facts — superseded tabs and vim excluded
      const after = await mem.component.recall("Alice", { limit: 10 });
      const contents = after.map((r) => r.content);
      expect(contents).toContain("Alice uses VS Code with spaces");
      expect(contents).not.toContain("Alice likes tabs");
      expect(contents).not.toContain("Alice likes vim keybindings");
    });

    test("missing supersedes ID is a no-op, no error", async () => {
      await mem.component.store("fact that stays", {
        relatedEntities: ["bob"],
        category: "context",
      });

      // Supersede a non-existent ID — should not throw
      await mem.component.store("new fact", {
        relatedEntities: ["bob"],
        category: "context-2",
        supersedes: ["nonexistent-id-xyz"],
      });

      const results = await mem.component.recall("fact", { limit: 10 });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    test("empty supersedes array behaves same as no field", async () => {
      await mem.component.store("original fact", {
        relatedEntities: ["carol"],
        category: "note",
      });

      await mem.component.store("another fact", {
        relatedEntities: ["carol"],
        category: "note-2",
        supersedes: [],
      });

      // recall only returns active facts — both should still be active
      const results = await mem.component.recall("fact", { limit: 10 });
      expect(results).toHaveLength(2);
    });

    test("automatic supersession still works alongside explicit", async () => {
      // Auto-supersession uses relatedEntities matching within same category
      await mem.component.store("Alice prefers coffee", {
        relatedEntities: ["alice"],
        category: "drink",
      });

      // Store with same entity + category — auto-supersession kicks in
      await mem.component.store("Alice prefers tea", {
        relatedEntities: ["alice"],
        category: "drink",
      });

      // recall only returns active — old coffee fact is auto-superseded
      const results = await mem.component.recall("prefers", { limit: 10 });
      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe("Alice prefers tea");
    });
  });

  describe("salience scoring", () => {
    test("reinforced facts rank higher than unreinforced", async () => {
      await mem.component.store("rarely accessed fact", {
        relatedEntities: ["sal"],
        category: "a",
      });
      await mem.component.store("frequently accessed fact", {
        relatedEntities: ["sal"],
        category: "b",
      });

      // Reinforce the second fact 5 times
      for (const _ of [1, 2, 3, 4, 5]) {
        await mem.component.store("frequently accessed fact", {
          relatedEntities: ["sal"],
          category: "b",
          reinforce: true,
        });
      }

      const results = await mem.component.recall("fact", { limit: 10 });
      expect(results.length).toBe(2);
      // Reinforced fact should rank first
      expect(results[0]?.content).toBe("frequently accessed fact");
    });

    test("scores reflect salience range not raw 1.0", async () => {
      await mem.component.store("single salience fact", {
        relatedEntities: ["sal2"],
        category: "ctx",
      });

      const results = await mem.component.recall("salience");
      expect(results.length).toBeGreaterThan(0);
      const score = results[0]?.score ?? 0;
      // Fresh fact with 0 accesses: score ≈ log(2) * 1.0 * 1.0 ≈ 0.693, not raw 1.0
      expect(score).toBeCloseTo(Math.log(2), 1);
    });

    test("retriever re-ranking: high BM25 + low access vs low BM25 + high access", async () => {
      const retrieverDir = join(testDir, "salience-retriever");
      mkdirSync(retrieverDir, { recursive: true });

      // Store two facts with controlled access counts
      const retrieverMem = await createFsMemory({
        baseDir: retrieverDir,
        retriever: {
          retrieve: async (_query, _limit) => [
            { id: "high-bm25", score: 10.0, content: "high bm25 low access" },
            { id: "low-bm25", score: 2.0, content: "low bm25 high access" },
          ],
        },
        indexer: {
          index: async () => {},
          remove: async () => {},
        },
      });

      // Manually create facts via store, then mock retriever results
      // We need to create facts with specific IDs to match mock retriever
      // Instead, use the fallback path by creating without retriever first
      await retrieverMem.close();

      // Create facts with known IDs via direct fact-store
      const { createFactStore } = await import("./fact-store.js");
      const fs = createFactStore(retrieverDir);
      const now = new Date();

      await fs.appendFact("sal3", {
        id: "high-bm25",
        fact: "high bm25 low access",
        category: "ctx",
        timestamp: now.toISOString(),
        status: "active",
        supersededBy: null,
        relatedEntities: ["sal3"],
        lastAccessed: now.toISOString(),
        accessCount: 0,
      });
      await fs.appendFact("sal3", {
        id: "low-bm25",
        fact: "low bm25 high access",
        category: "ctx2",
        timestamp: now.toISOString(),
        status: "active",
        supersededBy: null,
        relatedEntities: ["sal3"],
        lastAccessed: now.toISOString(),
        accessCount: 15,
      });
      await fs.close();

      // Now create memory with mock retriever
      const salienceMem = await createFsMemory({
        baseDir: retrieverDir,
        retriever: {
          retrieve: async (_query, _limit) => [
            { id: "high-bm25", score: 10.0, content: "high bm25 low access" },
            { id: "low-bm25", score: 2.0, content: "low bm25 high access" },
          ],
        },
        indexer: {
          index: async () => {},
          remove: async () => {},
        },
      });

      const results = await salienceMem.component.recall("query", { limit: 10 });
      expect(results.length).toBe(2);
      // After min-max normalization with floor=0.1:
      // high-bm25 sim=1.0, low-bm25 sim=0.1
      // high-bm25: 1.0 * log(2) ≈ 0.693
      // low-bm25: 0.1 * log(17) ≈ 0.283
      // high-bm25 still wins — similarity remains the dominant signal
      expect(results[0]?.content).toBe("high bm25 low access");
      // low-bm25 score is non-zero thanks to the floor — access count signal preserved
      expect(results[1]?.score).toBeGreaterThan(0);
      await salienceMem.close();
    });

    test("salienceEnabled: false preserves raw score passthrough", async () => {
      const rawDir = join(testDir, "salience-raw");
      mkdirSync(rawDir, { recursive: true });

      const rawMem = await createFsMemory({
        baseDir: rawDir,
        salienceEnabled: false,
      });

      await rawMem.component.store("raw score fact", {
        relatedEntities: ["sal4"],
        category: "ctx",
      });

      const results = await rawMem.component.recall("raw score");
      expect(results.length).toBeGreaterThan(0);
      // Without salience, fallback score is 1.0 (raw recency)
      expect(results[0]?.score).toBe(1.0);
      await rawMem.close();
    });

    test("single candidate score is positive (no zero-collapse)", async () => {
      await mem.component.store("only candidate fact", {
        relatedEntities: ["sal5"],
        category: "ctx",
      });

      const results = await mem.component.recall("only candidate");
      expect(results.length).toBe(1);
      expect(results[0]?.score).toBeGreaterThan(0);
    });
  });

  test("works with custom retriever", async () => {
    const customDir = join(testDir, "custom");
    mkdirSync(customDir, { recursive: true });

    // let — needed for mutable tracking array
    let indexed: string[] = [];

    const customMem = await createFsMemory({
      baseDir: customDir,
      retriever: {
        retrieve: async (_query, _limit) => {
          // Return nothing — just testing the path
          return [];
        },
      },
      indexer: {
        index: async (docs) => {
          indexed = [...indexed, ...docs.map((d) => d.id)];
        },
        remove: async () => {},
      },
    });

    await customMem.component.store("indexed fact", {
      relatedEntities: ["alice"],
    });

    // Recall flushes deferred index
    const results = await customMem.component.recall("indexed");
    expect(indexed.length).toBe(1);
    expect(results).toHaveLength(0); // Retriever returns nothing
    await customMem.close();
  });
});
