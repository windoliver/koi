import { describe, expect, test } from "bun:test";
import { createEntityIndex } from "./entity-index.js";
import type { FactStore, MemoryFact } from "./types.js";

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

/** Stub FactStore backed by a simple Map. */
function createStubFactStore(data: ReadonlyMap<string, readonly MemoryFact[]>): FactStore {
  return {
    readFacts: async (entity: string) => data.get(entity) ?? [],
    appendFact: async () => {},
    updateFact: async () => {},
    listEntities: async () => [...data.keys()],
    close: async () => {},
  };
}

describe("createEntityIndex", () => {
  test("isBuilt returns false before build, true after", async () => {
    const idx = createEntityIndex();
    expect(idx.isBuilt()).toBe(false);

    const store = createStubFactStore(new Map());
    await idx.build(store);
    expect(idx.isBuilt()).toBe(true);
  });

  test("build from empty factStore returns empty index", async () => {
    const idx = createEntityIndex();
    const store = createStubFactStore(new Map());
    await idx.build(store);

    expect(idx.lookup("anything")).toEqual([]);
  });

  test("build indexes multi-entity fact under all non-source entities", async () => {
    const fact = makeFact({
      id: "f1",
      relatedEntities: ["alice", "project-alpha"],
    });

    const store = createStubFactStore(new Map([["alice", [fact]]]));

    const idx = createEntityIndex();
    await idx.build(store);

    // Fact stored under "alice", so cross-entity entry is under "project-alpha"
    const projectRefs = idx.lookup("project-alpha");
    expect(projectRefs).toHaveLength(1);
    expect(projectRefs[0]).toEqual({ factId: "f1", sourceEntity: "alice" });

    // No cross-entity entry under "alice" (that's the source entity)
    const aliceRefs = idx.lookup("alice");
    expect(aliceRefs).toHaveLength(0);
  });

  test("addFact incrementally updates index", () => {
    const idx = createEntityIndex();

    const fact = makeFact({
      id: "f2",
      relatedEntities: ["bob", "team-x"],
    });
    idx.addFact(fact, "bob");

    const teamRefs = idx.lookup("team-x");
    expect(teamRefs).toHaveLength(1);
    expect(teamRefs[0]).toEqual({ factId: "f2", sourceEntity: "bob" });
  });

  test("lookup returns correct sourceEntity and factId for multiple facts", async () => {
    const fact1 = makeFact({
      id: "f1",
      relatedEntities: ["alice", "project-alpha"],
    });
    const fact2 = makeFact({
      id: "f2",
      relatedEntities: ["bob", "project-alpha"],
    });

    const store = createStubFactStore(
      new Map([
        ["alice", [fact1]],
        ["bob", [fact2]],
      ]),
    );

    const idx = createEntityIndex();
    await idx.build(store);

    const refs = idx.lookup("project-alpha");
    expect(refs).toHaveLength(2);

    const factIds = refs.map((r) => r.factId).sort();
    expect(factIds).toEqual(["f1", "f2"]);

    const sources = refs.map((r) => r.sourceEntity).sort();
    expect(sources).toEqual(["alice", "bob"]);
  });

  test("skips facts with empty relatedEntities", async () => {
    const fact = makeFact({ id: "f1", relatedEntities: [] });

    const store = createStubFactStore(new Map([["alice", [fact]]]));

    const idx = createEntityIndex();
    await idx.build(store);

    expect(idx.lookup("alice")).toHaveLength(0);
  });

  test("skips self-referencing entries (entity === sourceEntity)", () => {
    const idx = createEntityIndex();

    const fact = makeFact({
      id: "f1",
      relatedEntities: ["alice"],
    });
    idx.addFact(fact, "alice");

    // Only entity in relatedEntities is the source entity itself
    expect(idx.lookup("alice")).toHaveLength(0);
  });

  test("handles facts with single relatedEntity same as source — no cross-entity entry", async () => {
    const fact = makeFact({
      id: "f1",
      relatedEntities: ["bob"],
    });

    const store = createStubFactStore(new Map([["bob", [fact]]]));

    const idx = createEntityIndex();
    await idx.build(store);

    expect(idx.lookup("bob")).toHaveLength(0);
  });

  test("build is idempotent (calling twice does not duplicate entries)", async () => {
    const fact = makeFact({
      id: "f1",
      relatedEntities: ["alice", "project-alpha"],
    });

    const store = createStubFactStore(new Map([["alice", [fact]]]));

    const idx = createEntityIndex();
    await idx.build(store);
    await idx.build(store); // second call should be no-op

    const refs = idx.lookup("project-alpha");
    expect(refs).toHaveLength(1);
  });

  test("addFact does not create duplicate entries for same fact+source", () => {
    const idx = createEntityIndex();

    const fact = makeFact({
      id: "f1",
      relatedEntities: ["alice", "project-alpha"],
    });

    idx.addFact(fact, "alice");
    idx.addFact(fact, "alice"); // duplicate

    const refs = idx.lookup("project-alpha");
    expect(refs).toHaveLength(1);
  });

  test("indexes fact with multiple non-source entities", () => {
    const idx = createEntityIndex();

    const fact = makeFact({
      id: "f1",
      relatedEntities: ["alice", "project-alpha", "team-x"],
    });
    idx.addFact(fact, "alice");

    expect(idx.lookup("project-alpha")).toHaveLength(1);
    expect(idx.lookup("team-x")).toHaveLength(1);
    expect(idx.lookup("alice")).toHaveLength(0); // source entity
  });
});
