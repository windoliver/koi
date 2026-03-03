import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeywordCategoryInferrer } from "./category-inferrer.js";
import { createFsMemory } from "./fs-memory.js";
import type { FsMemory } from "./types.js";

// let — needed for mutable test directory and memory refs
let testDir: string;

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `koi-fs-memory-cat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("category inference integration", () => {
  // let — reassigned per test
  let mem: FsMemory;

  beforeEach(() => {
    testDir = makeTmpDir();
  });

  afterEach(async () => {
    await mem.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("infers category when options.category is omitted", async () => {
    mem = await createFsMemory({
      baseDir: testDir,
      categoryInferrer: createKeywordCategoryInferrer(),
    });

    await mem.component.store("We decided to use Bun for the runtime", {
      relatedEntities: ["project"],
    });

    const results = await mem.component.recall("Bun");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.metadata?.category).toBe("decision");
  });

  test("explicit category overrides inferrer", async () => {
    mem = await createFsMemory({
      baseDir: testDir,
      categoryInferrer: createKeywordCategoryInferrer(),
    });

    await mem.component.store("We decided to use Bun for the runtime", {
      relatedEntities: ["project"],
      category: "milestone",
    });

    const results = await mem.component.recall("Bun");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.metadata?.category).toBe("milestone");
  });

  test("falls back to 'context' when no inferrer configured", async () => {
    mem = await createFsMemory({ baseDir: testDir });

    await mem.component.store("Some random fact", {
      relatedEntities: ["project"],
    });

    const results = await mem.component.recall("random");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.metadata?.category).toBe("context");
  });

  test("async inferrer works", async () => {
    const asyncInferrer = async (content: string): Promise<string> => {
      // Simulate async (e.g., LLM-backed)
      await Promise.resolve();
      return content.includes("error") ? "error-pattern" : "context";
    };

    mem = await createFsMemory({
      baseDir: testDir,
      categoryInferrer: asyncInferrer,
    });

    await mem.component.store("Got an error in production", {
      relatedEntities: ["infra"],
    });

    const results = await mem.component.recall("error");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.metadata?.category).toBe("error-pattern");
  });

  test("failing inferrer falls back to 'context'", async () => {
    const brokenInferrer = (): string => {
      throw new Error("LLM unavailable");
    };

    mem = await createFsMemory({
      baseDir: testDir,
      categoryInferrer: brokenInferrer,
    });

    await mem.component.store("Some content about the project", {
      relatedEntities: ["project"],
    });

    const results = await mem.component.recall("content");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.metadata?.category).toBe("context");
  });

  test("dedup uses inferred category for same-category matching", async () => {
    mem = await createFsMemory({
      baseDir: testDir,
      categoryInferrer: createKeywordCategoryInferrer(),
    });

    // Both will be inferred as "preference" — dedup should reject duplicate
    await mem.component.store("User prefers dark mode in the editor", {
      relatedEntities: ["user"],
    });
    await mem.component.store("User prefers dark mode in the editor", {
      relatedEntities: ["user"],
    });

    const results = await mem.component.recall("dark mode");
    expect(results).toHaveLength(1);
    expect(results[0]?.metadata?.category).toBe("preference");
  });
});
