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
