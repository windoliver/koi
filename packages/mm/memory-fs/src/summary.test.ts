import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildSummary } from "./summary.js";
import type { MemoryFact } from "./types.js";

const BASE_CONFIG = {
  decayHalfLifeDays: 30,
  freqProtectThreshold: 10,
} as const;

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  const now = new Date().toISOString();
  return {
    id: `f-${Math.random().toString(36).slice(2, 8)}`,
    fact: "test fact",
    category: "context",
    timestamp: now,
    status: "active",
    supersededBy: null,
    relatedEntities: [],
    lastAccessed: now,
    accessCount: 0,
    ...overrides,
  };
}

// let — needed for mutable test directory reference
let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `koi-summary-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("rebuildSummary", () => {
  test("includes hot and warm facts in summary", async () => {
    const now = new Date();
    const hot = makeFact({
      id: "hot1",
      fact: "hot fact",
      lastAccessed: now.toISOString(),
      timestamp: now.toISOString(),
    });
    const warm = makeFact({
      id: "warm1",
      fact: "warm fact",
      lastAccessed: new Date(now.getTime() - 20 * 86_400_000).toISOString(),
      timestamp: new Date(now.getTime() - 20 * 86_400_000).toISOString(),
    });

    await rebuildSummary(testDir, "alice", [hot, warm], 10, BASE_CONFIG);

    const content = readFileSync(join(testDir, "entities", "alice", "summary.md"), "utf-8");
    expect(content).toContain("hot fact");
    expect(content).toContain("warm fact");
  });

  test("excludes cold facts from summary", async () => {
    const now = new Date();
    const cold = makeFact({
      id: "cold1",
      fact: "cold fact",
      lastAccessed: new Date(now.getTime() - 120 * 86_400_000).toISOString(),
      accessCount: 0,
    });

    await rebuildSummary(testDir, "alice", [cold], 10, BASE_CONFIG);

    const content = readFileSync(join(testDir, "entities", "alice", "summary.md"), "utf-8");
    expect(content).toBe("");
  });

  test("excludes superseded facts", async () => {
    const now = new Date();
    const superseded = makeFact({
      id: "s1",
      fact: "old info",
      status: "superseded",
      lastAccessed: now.toISOString(),
    });

    await rebuildSummary(testDir, "alice", [superseded], 10, BASE_CONFIG);

    const content = readFileSync(join(testDir, "entities", "alice", "summary.md"), "utf-8");
    expect(content).toBe("");
  });

  test("caps at maxSummaryFacts", async () => {
    const now = new Date();
    const facts = Array.from({ length: 20 }, (_, i) =>
      makeFact({
        id: `f${i}`,
        fact: `fact ${i}`,
        lastAccessed: now.toISOString(),
        timestamp: new Date(now.getTime() - i * 1000).toISOString(),
      }),
    );

    await rebuildSummary(testDir, "alice", facts, 5, BASE_CONFIG);

    const content = readFileSync(join(testDir, "entities", "alice", "summary.md"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);
  });

  test("sorts by recency (newest first)", async () => {
    const now = new Date();
    const older = makeFact({
      id: "f1",
      fact: "older fact",
      lastAccessed: now.toISOString(),
      timestamp: new Date(now.getTime() - 5000).toISOString(),
    });
    const newer = makeFact({
      id: "f2",
      fact: "newer fact",
      lastAccessed: now.toISOString(),
      timestamp: now.toISOString(),
    });

    await rebuildSummary(testDir, "alice", [older, newer], 10, BASE_CONFIG);

    const content = readFileSync(join(testDir, "entities", "alice", "summary.md"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines[0]).toContain("newer fact");
    expect(lines[1]).toContain("older fact");
  });

  test("writes empty file for empty entity", async () => {
    await rebuildSummary(testDir, "alice", [], 10, BASE_CONFIG);

    const content = readFileSync(join(testDir, "entities", "alice", "summary.md"), "utf-8");
    expect(content).toBe("");
  });

  test("labels tiers correctly in output", async () => {
    const now = new Date();
    const hot = makeFact({
      id: "h1",
      fact: "fresh memory",
      lastAccessed: now.toISOString(),
      timestamp: now.toISOString(),
    });

    await rebuildSummary(testDir, "alice", [hot], 10, BASE_CONFIG);

    const content = readFileSync(join(testDir, "entities", "alice", "summary.md"), "utf-8");
    expect(content).toContain("[hot]");
  });
});
