import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLearning, readLearnings } from "./learnings.js";
import type { LearningsEntry } from "./types.js";

function makeLearning(iteration: number): LearningsEntry {
  return {
    iteration,
    timestamp: new Date().toISOString(),
    itemId: `item-${iteration}`,
    discovered: [`discovery-${iteration}`],
    failed: [],
    context: `Context for iteration ${iteration}`,
  };
}

let tmpDir: string;
let learningsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ralph-learn-"));
  learningsPath = join(tmpDir, "learnings.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readLearnings", () => {
  test("returns empty array for missing file", async () => {
    const result = await readLearnings(join(tmpDir, "nonexistent.json"));
    expect(result).toEqual([]);
  });

  test("returns empty array for malformed JSON", async () => {
    await Bun.write(learningsPath, "not json at all");
    const result = await readLearnings(learningsPath);
    expect(result).toEqual([]);
  });

  test("returns empty array for missing entries field", async () => {
    await Bun.write(learningsPath, JSON.stringify({ data: [] }));
    const result = await readLearnings(learningsPath);
    expect(result).toEqual([]);
  });

  test("reads valid learnings file", async () => {
    const entries = [makeLearning(1), makeLearning(2)];
    await Bun.write(learningsPath, JSON.stringify({ entries }, null, 2));
    const result = await readLearnings(learningsPath);
    expect(result).toHaveLength(2);
    expect(result[0]?.iteration).toBe(1);
  });
});

describe("appendLearning", () => {
  test("creates file if missing", async () => {
    await appendLearning(learningsPath, makeLearning(1), 50);

    const result = await readLearnings(learningsPath);
    expect(result).toHaveLength(1);
    expect(result[0]?.iteration).toBe(1);
  });

  test("appends to existing entries", async () => {
    await appendLearning(learningsPath, makeLearning(1), 50);
    await appendLearning(learningsPath, makeLearning(2), 50);

    const result = await readLearnings(learningsPath);
    expect(result).toHaveLength(2);
    expect(result[1]?.iteration).toBe(2);
  });

  test("respects maxEntries rolling window", async () => {
    const maxEntries = 3;
    for (let i = 1; i <= 5; i++) {
      await appendLearning(learningsPath, makeLearning(i), maxEntries);
    }

    const result = await readLearnings(learningsPath);
    expect(result).toHaveLength(3);
    // Should keep last 3: iterations 3, 4, 5
    expect(result[0]?.iteration).toBe(3);
    expect(result[1]?.iteration).toBe(4);
    expect(result[2]?.iteration).toBe(5);
  });

  test("tmp file does not persist after write", async () => {
    await appendLearning(learningsPath, makeLearning(1), 50);
    const tmpExists = await Bun.file(`${learningsPath}.tmp`).exists();
    expect(tmpExists).toBe(false);
  });
});
