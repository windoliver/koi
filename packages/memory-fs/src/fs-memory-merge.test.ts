/**
 * Tests for merge strategy and namespace filtering in createFsMemory.
 *
 * Split from fs-memory.test.ts to stay under the 800-line file limit.
 */
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
    `koi-fs-memory-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  mem = await createFsMemory({ baseDir: testDir });
});

afterEach(async () => {
  await mem.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("merge strategy", () => {
  test("merge triggered in [mergeThreshold, dedupThreshold) range", async () => {
    const mergeDir = join(testDir, "merge");
    mkdirSync(mergeDir, { recursive: true });
    const mergeMem = await createFsMemory({
      baseDir: mergeDir,
      dedupThreshold: 0.7,
      mergeThreshold: 0.3,
      mergeHandler: async (existing, incoming) => `${existing} + ${incoming}`,
    });

    await mergeMem.component.store("Alice likes cats and dogs", {
      relatedEntities: ["alice"],
      category: "preference",
    });
    // Similar enough to fall in merge zone but not dedup zone
    await mergeMem.component.store("Alice likes cats and birds", {
      relatedEntities: ["alice"],
      category: "preference",
    });

    const results = await mergeMem.component.recall("Alice likes");
    // Only one active fact (old superseded, merged stored)
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("+");
    await mergeMem.close();
  });

  test("handler returns merged text → old superseded, merged stored", async () => {
    const mergeDir = join(testDir, "merge2");
    mkdirSync(mergeDir, { recursive: true });
    const mergeMem = await createFsMemory({
      baseDir: mergeDir,
      dedupThreshold: 0.9,
      mergeThreshold: 0.1,
      mergeHandler: async (existing, incoming) => `MERGED: ${existing} | ${incoming}`,
    });

    await mergeMem.component.store("User prefers dark mode", {
      relatedEntities: ["user"],
      category: "preference",
    });
    await mergeMem.component.store("User prefers dark mode and large fonts", {
      relatedEntities: ["user"],
      category: "preference",
    });

    const results = await mergeMem.component.recall("preference");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("MERGED:");
    await mergeMem.close();
  });

  test("handler returns undefined → falls through to supersede", async () => {
    const mergeDir = join(testDir, "merge3");
    mkdirSync(mergeDir, { recursive: true });
    const mergeMem = await createFsMemory({
      baseDir: mergeDir,
      dedupThreshold: 0.9,
      mergeThreshold: 0.1,
      mergeHandler: async (_existing, _incoming) => undefined,
    });

    await mergeMem.component.store("fact one about topic", {
      relatedEntities: ["entity"],
      category: "context",
    });
    await mergeMem.component.store("fact one about topic expanded", {
      relatedEntities: ["entity"],
      category: "context",
    });

    const results = await mergeMem.component.recall("topic");
    // Handler returned undefined → supersede path took over (same entities)
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("fact one about topic expanded");
    await mergeMem.close();
  });

  test("handler returns empty string → treated as undefined", async () => {
    const mergeDir = join(testDir, "merge4");
    mkdirSync(mergeDir, { recursive: true });
    const mergeMem = await createFsMemory({
      baseDir: mergeDir,
      dedupThreshold: 0.9,
      mergeThreshold: 0.1,
      mergeHandler: async (_existing, _incoming) => "",
    });

    await mergeMem.component.store("original fact about X", {
      relatedEntities: ["x"],
      category: "context",
    });
    await mergeMem.component.store("original fact about X with more detail", {
      relatedEntities: ["x"],
      category: "context",
    });

    const results = await mergeMem.component.recall("fact");
    // Empty string treated as undefined → supersede path
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("original fact about X with more detail");
    await mergeMem.close();
  });

  test("handler not provided → existing behavior unchanged", async () => {
    // Default mem has no mergeHandler
    await mem.component.store("basic fact about cats", {
      relatedEntities: ["test"],
      category: "context",
    });
    await mem.component.store("basic fact about cats and dogs", {
      relatedEntities: ["test"],
      category: "context",
    });

    const results = await mem.component.recall("fact");
    // Without merge handler, supersede logic applies (same entities)
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("basic fact about cats and dogs");
  });

  test("handler throws → error caught, original fact not lost", async () => {
    const mergeDir = join(testDir, "merge5");
    mkdirSync(mergeDir, { recursive: true });
    const mergeMem = await createFsMemory({
      baseDir: mergeDir,
      dedupThreshold: 0.9,
      mergeThreshold: 0.1,
      mergeHandler: async () => {
        throw new Error("LLM API timeout");
      },
    });

    await mergeMem.component.store("important fact about security", {
      relatedEntities: ["security"],
      category: "context",
    });
    await mergeMem.component.store("important fact about security policies", {
      relatedEntities: ["security"],
      category: "context",
    });

    const results = await mergeMem.component.recall("security");
    // Handler threw → fell through to supersede (same entities), new fact stored
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("important fact about security policies");
    await mergeMem.close();
  });

  test("causal parents preserved from both facts during merge", async () => {
    const mergeDir = join(testDir, "merge6");
    mkdirSync(mergeDir, { recursive: true });
    const mergeMem = await createFsMemory({
      baseDir: mergeDir,
      dedupThreshold: 0.9,
      mergeThreshold: 0.1,
      mergeHandler: async (existing, incoming) => `${existing} + ${incoming}`,
    });

    // Store parent facts
    await mergeMem.component.store("parent A", {
      relatedEntities: ["test"],
      category: "parent-a",
    });
    const parentAResults = await mergeMem.component.recall("parent A", { limit: 10 });
    const parentAFact = parentAResults.find((r) => r.content === "parent A");
    const parentAId = (parentAFact?.metadata as Record<string, unknown>)?.id as string;

    await mergeMem.component.store("parent B", {
      relatedEntities: ["test"],
      category: "parent-b",
    });
    const parentBResults = await mergeMem.component.recall("parent B", { limit: 10 });
    const parentBFact = parentBResults.find((r) => r.content === "parent B");
    const parentBId = (parentBFact?.metadata as Record<string, unknown>)?.id as string;

    // Store first fact with parent A
    await mergeMem.component.store("fact about topic with context from A", {
      relatedEntities: ["test"],
      category: "derived",
      causalParents: [parentAId],
    });

    // Store related fact (merge zone) with parent B
    await mergeMem.component.store("fact about topic with context from A and B", {
      relatedEntities: ["test"],
      category: "derived",
      causalParents: [parentBId],
    });

    const results = await mergeMem.component.recall("topic");
    const merged = results.find((r) => r.content.includes("+"));
    expect(merged).toBeDefined();
    // Combined parents should include both A and B
    expect(merged?.causalParents).toBeDefined();
    expect(merged?.causalParents?.length).toBe(2);
    expect(merged?.causalParents).toContain(parentAId);
    expect(merged?.causalParents).toContain(parentBId);
    await mergeMem.close();
  });

  test("throws when mergeThreshold >= dedupThreshold", async () => {
    expect(
      createFsMemory({
        baseDir: testDir,
        mergeThreshold: 0.8,
        dedupThreshold: 0.7,
        mergeHandler: async (a, b) => `${a} + ${b}`,
      }),
    ).rejects.toThrow("mergeThreshold");
  });
});

describe("namespace filtering", () => {
  test("store with namespace A, recall with namespace A → returns facts", async () => {
    await mem.component.store("namespaced fact for project alpha", {
      namespace: "project-alpha",
      category: "context",
    });

    const results = await mem.component.recall("namespaced fact", {
      namespace: "project-alpha",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toBe("namespaced fact for project alpha");
  });

  test("store with namespace A, recall with namespace B → returns empty", async () => {
    await mem.component.store("fact for namespace A only", {
      namespace: "ns-a",
      category: "context",
    });

    const results = await mem.component.recall("fact", {
      namespace: "ns-b",
    });
    expect(results).toHaveLength(0);
  });

  test("recall without namespace → returns all (backward compat)", async () => {
    await mem.component.store("fact in namespace X", {
      namespace: "ns-x",
      category: "context",
    });
    await mem.component.store("fact in namespace Y", {
      namespace: "ns-y",
      category: "context",
    });

    const results = await mem.component.recall("fact");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});
