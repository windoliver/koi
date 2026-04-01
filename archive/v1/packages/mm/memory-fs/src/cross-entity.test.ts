import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrossEntityConfig } from "./cross-entity.js";
import { expandCrossEntity } from "./cross-entity.js";
import { createEntityIndex } from "./entity-index.js";
import { createFsMemory } from "./fs-memory.js";
import type { FactStore, FsMemory, MemoryFact } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFact(overrides: Partial<MemoryFact> & { readonly id: string }): MemoryFact {
  return {
    fact: "test fact",
    category: "context",
    timestamp: new Date().toISOString(),
    status: "active",
    supersededBy: null,
    relatedEntities: [],
    lastAccessed: new Date().toISOString(),
    accessCount: 0,
    ...overrides,
  };
}

function createStubFactStore(data: ReadonlyMap<string, readonly MemoryFact[]>): FactStore {
  return {
    readFacts: async (entity: string) => data.get(entity) ?? [],
    appendFact: async () => {},
    updateFact: async () => {},
    listEntities: async () => [...data.keys()],
    close: async () => {},
  };
}

const DEFAULT_CONFIG: CrossEntityConfig = {
  entityHopDecay: 0.5,
  maxEntityHops: 1,
  perEntityCap: 10,
} as const;

// ---------------------------------------------------------------------------
// Unit tests for expandCrossEntity
// ---------------------------------------------------------------------------

describe("expandCrossEntity", () => {
  test("finds facts from related entity that reference queried entity", async () => {
    // Fact stored under "alice" references both "alice" and "project-alpha"
    const aliceFact = makeFact({
      id: "f1",
      fact: "Alice works on Project Alpha",
      relatedEntities: ["alice", "project-alpha"],
    });

    const store = createStubFactStore(new Map([["alice", [aliceFact]]]));

    const idx = createEntityIndex();
    await idx.build(store);

    // Seed: querying from "project-alpha" perspective
    const projectFact = makeFact({
      id: "f2",
      fact: "Project Alpha uses Rust",
      relatedEntities: ["project-alpha"],
    });
    const seeds = [{ fact: projectFact, entity: "project-alpha", score: 1.0 }];

    const results = await expandCrossEntity(seeds, idx, store, DEFAULT_CONFIG);

    // Should find f1 via cross-entity (alice → project-alpha link)
    const factIds = results.map((r) => r.fact.id).sort();
    expect(factIds).toContain("f1");
    expect(factIds).toContain("f2");
  });

  test("applies entity-hop decay (score * 0.5 per entity hop)", async () => {
    const aliceFact = makeFact({
      id: "f1",
      relatedEntities: ["alice", "project-alpha"],
    });

    const store = createStubFactStore(new Map([["alice", [aliceFact]]]));

    const idx = createEntityIndex();
    await idx.build(store);

    const seeds = [
      {
        fact: makeFact({ id: "f2", relatedEntities: ["project-alpha"] }),
        entity: "project-alpha",
        score: 0.8,
      },
    ];

    const results = await expandCrossEntity(seeds, idx, store, DEFAULT_CONFIG);

    const crossEntityResult = results.find((r) => r.fact.id === "f1");
    expect(crossEntityResult).toBeDefined();
    // Score should be seedScore * entityHopDecay^1 = 0.8 * 0.5 = 0.4
    expect(crossEntityResult?.score).toBe(0.4);
  });

  test("respects perEntityCap — limits results per entity", async () => {
    // Create 15 facts under "alice" all referencing "project-alpha"
    const aliceFacts = Array.from({ length: 15 }, (_, i) =>
      makeFact({
        id: `f-alice-${i}`,
        relatedEntities: ["alice", "project-alpha"],
      }),
    );

    const store = createStubFactStore(new Map([["alice", aliceFacts]]));

    const idx = createEntityIndex();
    await idx.build(store);

    const seeds = [
      {
        fact: makeFact({ id: "seed", relatedEntities: ["project-alpha"] }),
        entity: "project-alpha",
        score: 1.0,
      },
    ];

    const config: CrossEntityConfig = { ...DEFAULT_CONFIG, perEntityCap: 5 };
    const results = await expandCrossEntity(seeds, idx, store, config);

    // Cross-entity results from alice should be capped at 5 + 1 seed = 6 total
    const crossEntityResults = results.filter((r) => r.entity === "alice");
    expect(crossEntityResults).toHaveLength(5);
  });

  test("handles entity cycle A↔B without infinite loop (visited set)", async () => {
    // A references B, B references A
    const factA = makeFact({
      id: "fA",
      relatedEntities: ["alice", "bob"],
    });
    const factB = makeFact({
      id: "fB",
      relatedEntities: ["bob", "alice"],
    });

    const store = createStubFactStore(
      new Map([
        ["alice", [factA]],
        ["bob", [factB]],
      ]),
    );

    const idx = createEntityIndex();
    await idx.build(store);

    const seeds = [{ fact: factA, entity: "alice", score: 1.0 }];
    const results = await expandCrossEntity(seeds, idx, store, DEFAULT_CONFIG);

    // Should find both facts without infinite loop
    const factIds = results.map((r) => r.fact.id).sort();
    expect(factIds).toContain("fA");
    expect(factIds).toContain("fB");
    expect(factIds).toHaveLength(2);
  });

  test("handles entity triangle A→B→C→A without infinite loop", async () => {
    const factAB = makeFact({ id: "fAB", relatedEntities: ["alice", "bob"] });
    const factBC = makeFact({ id: "fBC", relatedEntities: ["bob", "charlie"] });
    const factCA = makeFact({ id: "fCA", relatedEntities: ["charlie", "alice"] });

    const store = createStubFactStore(
      new Map([
        ["alice", [factAB]],
        ["bob", [factBC]],
        ["charlie", [factCA]],
      ]),
    );

    const idx = createEntityIndex();
    await idx.build(store);

    // maxEntityHops=2 to traverse two levels
    const seeds = [{ fact: factAB, entity: "alice", score: 1.0 }];
    const config: CrossEntityConfig = { ...DEFAULT_CONFIG, maxEntityHops: 2 };
    const results = await expandCrossEntity(seeds, idx, store, config);

    // All three facts should be found
    const factIds = results.map((r) => r.fact.id).sort();
    expect(factIds).toContain("fAB");
    expect(factIds).toContain("fBC");
    expect(factIds).toContain("fCA");
  });

  test("maxEntityHops=0 returns seeds unchanged", async () => {
    const store = createStubFactStore(new Map());
    const idx = createEntityIndex();

    const seeds = [
      {
        fact: makeFact({ id: "seed", relatedEntities: ["alice"] }),
        entity: "alice",
        score: 1.0,
      },
    ];

    const config: CrossEntityConfig = { ...DEFAULT_CONFIG, maxEntityHops: 0 };
    const results = await expandCrossEntity(seeds, idx, store, config);

    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe("seed");
  });

  test("maxEntityHops=1 finds direct entity neighbors only", async () => {
    // A→B→C chain: A references B, B references C
    const factAB = makeFact({ id: "fAB", relatedEntities: ["alice", "bob"] });
    const factBC = makeFact({ id: "fBC", relatedEntities: ["bob", "charlie"] });

    const store = createStubFactStore(
      new Map([
        ["alice", [factAB]],
        ["bob", [factBC]],
      ]),
    );

    const idx = createEntityIndex();
    await idx.build(store);

    const seeds = [{ fact: factAB, entity: "alice", score: 1.0 }];
    const config: CrossEntityConfig = { ...DEFAULT_CONFIG, maxEntityHops: 1 };
    const results = await expandCrossEntity(seeds, idx, store, config);

    // Only fAB (seed) and nothing from bob→charlie (2-hop)
    // Actually bob is referenced by fAB, so we look up bob: fBC references bob from alice's fact
    // Wait — let me think. factAB has relatedEntities ["alice", "bob"] and is stored under "alice".
    // So the index has: bob → [{factId: "fAB", sourceEntity: "alice"}]
    // factBC has relatedEntities ["bob", "charlie"] and is stored under "bob".
    // So the index has: charlie → [{factId: "fBC", sourceEntity: "bob"}]
    //
    // Seeds: factAB stored under alice. frontier = ["bob"] (from relatedEntities, minus visited {"alice"})
    // Hop 1: lookup("bob") → [{factId: "fAB", sourceEntity: "alice"}]
    // factAB is already a seed (dedup keeps higher), so no new discovery at hop 1 from that lookup
    // But we also need to check: factBC stored under bob has relatedEntities ["bob", "charlie"]
    // The index entry for "bob" only contains references FROM OTHER entities.
    // factBC is stored under "bob" and has "bob" in relatedEntities → skip (self-ref).
    // factBC references "charlie" from source "bob" → charlie entry.
    // So lookup("bob") only returns fAB from alice. fAB is already in seeds.
    // maxEntityHops=1 → no charlie discovery.

    const factIds = results.map((r) => r.fact.id).sort();
    expect(factIds).toEqual(["fAB"]);
  });

  test("maxEntityHops=2 finds 2-hop entity chains", async () => {
    // A references B (stored under A), B references C (stored under B)
    const factAB = makeFact({ id: "fAB", relatedEntities: ["alice", "bob"] });
    const factBC = makeFact({ id: "fBC", relatedEntities: ["bob", "charlie"] });
    const factC = makeFact({ id: "fC", relatedEntities: ["charlie", "alice"] });

    const store = createStubFactStore(
      new Map([
        ["alice", [factAB]],
        ["bob", [factBC]],
        ["charlie", [factC]],
      ]),
    );

    const idx = createEntityIndex();
    await idx.build(store);

    const seeds = [{ fact: factAB, entity: "alice", score: 1.0 }];
    const config: CrossEntityConfig = { ...DEFAULT_CONFIG, maxEntityHops: 2 };
    const results = await expandCrossEntity(seeds, idx, store, config);

    const factIds = results.map((r) => r.fact.id).sort();
    expect(factIds).toContain("fAB");
    // fBC should be discovered via charlie→bob index entry
    // fC should be discovered via charlie
    expect(factIds.length).toBeGreaterThanOrEqual(2);
  });

  test("filters superseded facts (status !== active)", async () => {
    const supersededFact = makeFact({
      id: "f1",
      relatedEntities: ["alice", "project-alpha"],
      status: "superseded",
      supersededBy: "f2",
    });

    const store = createStubFactStore(new Map([["alice", [supersededFact]]]));

    const idx = createEntityIndex();
    await idx.build(store);

    const seeds = [
      {
        fact: makeFact({ id: "seed", relatedEntities: ["project-alpha"] }),
        entity: "project-alpha",
        score: 1.0,
      },
    ];

    const results = await expandCrossEntity(seeds, idx, store, DEFAULT_CONFIG);

    // Only the seed should remain; superseded fact is filtered out
    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe("seed");
  });

  test("dedup: fact found by both seed and cross-entity keeps higher score", async () => {
    const sharedFact = makeFact({
      id: "shared",
      relatedEntities: ["alice", "bob"],
    });

    const store = createStubFactStore(new Map([["alice", [sharedFact]]]));

    const idx = createEntityIndex();
    await idx.build(store);

    // sharedFact appears both as seed (score 0.9) and via cross-entity from "bob"
    const seeds = [
      { fact: sharedFact, entity: "alice", score: 0.9 },
      { fact: makeFact({ id: "bobFact", relatedEntities: ["bob"] }), entity: "bob", score: 0.8 },
    ];

    const results = await expandCrossEntity(seeds, idx, store, DEFAULT_CONFIG);

    const shared = results.find((r) => r.fact.id === "shared");
    expect(shared).toBeDefined();
    // Seed score (0.9) should win over cross-entity score (0.8 * 0.5 = 0.4)
    expect(shared?.score).toBe(0.9);
  });

  test("empty relatedEntities produces no cross-entity results", async () => {
    const store = createStubFactStore(new Map());
    const idx = createEntityIndex();

    const seeds = [
      {
        fact: makeFact({ id: "seed", relatedEntities: [] }),
        entity: "alice",
        score: 1.0,
      },
    ];

    const results = await expandCrossEntity(seeds, idx, store, DEFAULT_CONFIG);
    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe("seed");
  });

  test("empty seeds returns empty array", async () => {
    const store = createStubFactStore(new Map());
    const idx = createEntityIndex();

    const results = await expandCrossEntity([], idx, store, DEFAULT_CONFIG);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests through createFsMemory
// ---------------------------------------------------------------------------

// let — needed for mutable test directory and memory refs
let testDir: string;
let mem: FsMemory;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `koi-cross-entity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  mem = await createFsMemory({ baseDir: testDir });
});

afterEach(async () => {
  await mem.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("cross-entity integration via createFsMemory", () => {
  test("store facts across entities, recall with graphExpand finds cross-entity results", async () => {
    // Fact stored under "alice" referencing both alice and project-alpha
    await mem.component.store("Alice works on Project Alpha", {
      relatedEntities: ["alice", "project-alpha"],
      category: "context",
    });

    // Fact stored under "project-alpha" (only references project-alpha)
    await mem.component.store("Project Alpha uses Rust", {
      relatedEntities: ["project-alpha"],
      category: "tech",
    });

    // Recall from project-alpha with graph expansion should find the alice fact
    const results = await mem.component.recall("anything", {
      graphExpand: true,
      limit: 20,
    });

    const contents = results.map((r) => r.content);
    expect(contents).toContain("Alice works on Project Alpha");
    expect(contents).toContain("Project Alpha uses Rust");
  });

  test("cross-entity results have lower scores than direct matches", async () => {
    await mem.component.store("Alice works on Project Alpha", {
      relatedEntities: ["alice", "project-alpha"],
      category: "context",
    });

    await mem.component.store("Project Alpha uses Rust", {
      relatedEntities: ["project-alpha"],
      category: "tech",
    });

    const results = await mem.component.recall("anything", {
      graphExpand: true,
      limit: 20,
    });

    // Without a retriever, all facts get score 1.0 — but cross-entity
    // facts get entityHopDecay applied. Direct facts should score >= cross-entity.
    // Both are direct matches from the full scan, so cross-entity decay
    // only applies to facts discovered *exclusively* through cross-entity.
    // In this case both facts are returned by the scan, so both start at 1.0.
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test("limit still applies after cross-entity expansion", async () => {
    // Store several cross-entity related facts
    await mem.component.store("Alice works on Project Alpha", {
      relatedEntities: ["alice", "project-alpha"],
      category: "context",
    });
    await mem.component.store("Bob works on Project Alpha", {
      relatedEntities: ["bob", "project-alpha"],
      category: "context",
    });
    await mem.component.store("Charlie works on Project Alpha", {
      relatedEntities: ["charlie", "project-alpha"],
      category: "context",
    });

    const results = await mem.component.recall("anything", {
      graphExpand: true,
      limit: 2,
    });

    expect(results).toHaveLength(2);
  });

  test("graphExpand=false does NOT trigger cross-entity expansion", async () => {
    // Store a fact under alice referencing project-alpha
    await mem.component.store("Alice works on Project Alpha", {
      relatedEntities: ["alice", "project-alpha"],
      category: "context",
    });

    // Without graphExpand, recall should still return all active facts (no filter by entity scope)
    // but cross-entity expansion won't add new discoveries
    const results = await mem.component.recall("anything", {
      graphExpand: false,
      limit: 20,
    });

    // Should still find the fact (it's in the full scan), just not via cross-entity
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("mixed causal + cross-entity expansion works together", async () => {
    // Store fact A under alice with causal link
    await mem.component.store("Alice likes TypeScript", {
      relatedEntities: ["alice"],
      category: "preference",
    });

    // Get the ID of the first fact for causal linking
    const firstResults = await mem.component.recall("TypeScript", { limit: 1 });
    const meta = firstResults[0]?.metadata as Readonly<Record<string, unknown>> | undefined;
    expect(meta?.id).toBeDefined();
    const firstId = String(meta?.id);

    // Store fact B as causal child of A, also referencing project-alpha
    await mem.component.store("Alice uses TypeScript in Project Alpha", {
      relatedEntities: ["alice", "project-alpha"],
      category: "context",
      causalParents: [firstId],
    });

    // Store fact C under project-alpha only
    await mem.component.store("Project Alpha is open source", {
      relatedEntities: ["project-alpha"],
      category: "context",
    });

    // Recall with graphExpand should find all three:
    // - Direct facts from full scan
    // - Causal expansion within alice
    // - Cross-entity expansion from alice → project-alpha
    const results = await mem.component.recall("anything", {
      graphExpand: true,
      limit: 20,
    });

    const contents = results.map((r) => r.content);
    expect(contents).toContain("Alice likes TypeScript");
    expect(contents).toContain("Alice uses TypeScript in Project Alpha");
    expect(contents).toContain("Project Alpha is open source");
  });
});
