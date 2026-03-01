import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactStore } from "./fact-store.js";
import type { MemoryFact } from "./types.js";

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: `fact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

// let — needed for mutable test directory reference
let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `koi-fact-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("createFactStore", () => {
  test("readFacts returns empty array for non-existent entity", async () => {
    const store = createFactStore(testDir);
    const facts = await store.readFacts("alice");
    expect(facts).toEqual([]);
    await store.close();
  });

  test("appendFact + readFacts roundtrip", async () => {
    const store = createFactStore(testDir);
    const fact = makeFact({ id: "f1", fact: "Alice likes cats" });
    await store.appendFact("alice", fact);
    const facts = await store.readFacts("alice");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.fact).toBe("Alice likes cats");
    await store.close();
  });

  test("persists to disk", async () => {
    const store = createFactStore(testDir);
    await store.appendFact("bob", makeFact({ id: "f1" }));
    await store.close();

    const filePath = join(testDir, "entities", "bob", "items.json");
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as readonly MemoryFact[];
    expect(parsed).toHaveLength(1);
  });

  test("concurrent Promise.all writes all succeed", async () => {
    const store = createFactStore(testDir);
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.appendFact("entity", makeFact({ id: `f${i}`, fact: `fact ${i}` })),
    );
    await Promise.all(writes);
    const facts = await store.readFacts("entity");
    expect(facts).toHaveLength(10);
    await store.close();
  });

  test("recovers gracefully from corrupted JSON", async () => {
    // Pre-create a corrupted file
    const entityDir = join(testDir, "entities", "corrupt");
    mkdirSync(entityDir, { recursive: true });
    writeFileSync(join(entityDir, "items.json"), "NOT VALID JSON{{{", "utf-8");

    const store = createFactStore(testDir);
    const facts = await store.readFacts("corrupt");
    expect(facts).toEqual([]);
    await store.close();
  });

  test("updateFact modifies a single fact", async () => {
    const store = createFactStore(testDir);
    await store.appendFact("alice", makeFact({ id: "f1", accessCount: 0, status: "active" }));
    await store.updateFact("alice", "f1", {
      accessCount: 5,
      lastAccessed: "2025-06-15T00:00:00Z",
    });
    const facts = await store.readFacts("alice");
    expect(facts[0]?.accessCount).toBe(5);
    expect(facts[0]?.lastAccessed).toBe("2025-06-15T00:00:00Z");
    await store.close();
  });

  test("updateFact preserves other facts", async () => {
    const store = createFactStore(testDir);
    await store.appendFact("alice", makeFact({ id: "f1", fact: "first" }));
    await store.appendFact("alice", makeFact({ id: "f2", fact: "second" }));
    await store.updateFact("alice", "f1", { status: "superseded" });
    const facts = await store.readFacts("alice");
    expect(facts).toHaveLength(2);
    expect(facts[0]?.status).toBe("superseded");
    expect(facts[1]?.status).toBe("active");
    await store.close();
  });

  test("listEntities returns entity directory names", async () => {
    const store = createFactStore(testDir);
    await store.appendFact("alice", makeFact());
    await store.appendFact("bob", makeFact());
    const entities = await store.listEntities();
    expect([...entities].sort()).toEqual(["alice", "bob"]);
    await store.close();
  });

  test("listEntities returns empty when no entities exist", async () => {
    const store = createFactStore(testDir);
    const entities = await store.listEntities();
    expect(entities).toEqual([]);
    await store.close();
  });

  test("cache consistency: second read returns updated data", async () => {
    const store = createFactStore(testDir);
    await store.appendFact("alice", makeFact({ id: "f1" }));
    const first = await store.readFacts("alice");
    expect(first).toHaveLength(1);
    await store.appendFact("alice", makeFact({ id: "f2" }));
    const second = await store.readFacts("alice");
    expect(second).toHaveLength(2);
    await store.close();
  });

  test("drops malformed facts from disk while keeping valid ones", async () => {
    const entityDir = join(testDir, "entities", "mixed");
    mkdirSync(entityDir, { recursive: true });
    const validFact = makeFact({ id: "valid-1", fact: "I am valid" });
    const malformed = { id: 42, garbage: true }; // Missing required fields
    writeFileSync(join(entityDir, "items.json"), JSON.stringify([validFact, malformed]), "utf-8");

    const store = createFactStore(testDir);
    const facts = await store.readFacts("mixed");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.id).toBe("valid-1");
    await store.close();
  });

  test("returns empty for non-array JSON", async () => {
    const entityDir = join(testDir, "entities", "obj");
    mkdirSync(entityDir, { recursive: true });
    writeFileSync(join(entityDir, "items.json"), '{"not": "array"}', "utf-8");

    const store = createFactStore(testDir);
    const facts = await store.readFacts("obj");
    expect(facts).toEqual([]);
    await store.close();
  });

  describe("causal fields backward compat", () => {
    test("old items.json without causal fields loads fine", async () => {
      const entityDir = join(testDir, "entities", "legacy");
      mkdirSync(entityDir, { recursive: true });
      const legacyFact = {
        id: "old-1",
        fact: "legacy fact",
        category: "context",
        timestamp: "2025-01-01T00:00:00Z",
        status: "active",
        supersededBy: null,
        relatedEntities: [],
        lastAccessed: "2025-01-01T00:00:00Z",
        accessCount: 3,
      };
      writeFileSync(join(entityDir, "items.json"), JSON.stringify([legacyFact]), "utf-8");

      const store = createFactStore(testDir);
      const facts = await store.readFacts("legacy");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.id).toBe("old-1");
      expect(facts[0]?.causalParents).toBeUndefined();
      expect(facts[0]?.causalChildren).toBeUndefined();
      await store.close();
    });

    test("isMemoryFact accepts facts with causal fields", async () => {
      const store = createFactStore(testDir);
      const factWithCausal = makeFact({
        id: "causal-1",
        causalParents: ["parent-1"],
        causalChildren: ["child-1"],
      });
      await store.appendFact("causal", factWithCausal);
      const facts = await store.readFacts("causal");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.causalParents).toEqual(["parent-1"]);
      expect(facts[0]?.causalChildren).toEqual(["child-1"]);
      await store.close();
    });

    test("causal fields survive write+read cycle", async () => {
      const store = createFactStore(testDir);
      const fact = makeFact({
        id: "persist-1",
        causalParents: ["p1", "p2"],
        causalChildren: ["c1"],
      });
      await store.appendFact("persist", fact);
      await store.close();

      // Re-open from disk
      const store2 = createFactStore(testDir);
      const facts = await store2.readFacts("persist");
      expect(facts).toHaveLength(1);
      expect(facts[0]?.causalParents).toEqual(["p1", "p2"]);
      expect(facts[0]?.causalChildren).toEqual(["c1"]);
      await store2.close();
    });
  });
});
