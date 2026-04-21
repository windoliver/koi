import { describe, expect, test } from "bun:test";
import type { CollectiveMemory, CollectiveMemoryEntry } from "@koi/core";
import { DEFAULT_COLLECTIVE_MEMORY } from "@koi/core";
import { compactCollectiveMemory, shouldCompact } from "./compact.js";

const NOW = 1_700_000_000_000;

function createEntry(id: string, content: string, accessCount = 1): CollectiveMemoryEntry {
  return {
    id,
    content,
    category: "heuristic",
    source: { agentId: "agent-1", runId: "run-1", timestamp: NOW },
    createdAt: NOW,
    accessCount,
    lastAccessedAt: NOW,
  };
}

describe("shouldCompact", () => {
  test("returns false for empty memory", () => {
    expect(shouldCompact(DEFAULT_COLLECTIVE_MEMORY)).toBe(false);
  });

  test("returns true when entries exceed maxEntries", () => {
    const entries = Array.from({ length: 55 }, (_, i) =>
      createEntry(`e${String(i)}`, `content ${String(i)}`),
    );
    expect(shouldCompact({ ...DEFAULT_COLLECTIVE_MEMORY, entries }, 50)).toBe(true);
  });

  test("returns true when totalTokens exceeds maxTokens", () => {
    const memory: CollectiveMemory = {
      ...DEFAULT_COLLECTIVE_MEMORY,
      entries: [createEntry("e1", "test")],
      totalTokens: 9000,
    };
    expect(shouldCompact(memory, 50, 8000)).toBe(true);
  });

  test("returns false when within both thresholds", () => {
    const memory: CollectiveMemory = {
      ...DEFAULT_COLLECTIVE_MEMORY,
      entries: [createEntry("e1", "test")],
      totalTokens: 100,
    };
    expect(shouldCompact(memory, 50, 8000)).toBe(false);
  });
});

describe("compactCollectiveMemory", () => {
  test("increments generation", () => {
    const memory: CollectiveMemory = {
      entries: [createEntry("e1", "test learning")],
      totalTokens: 100,
      generation: 5,
    };
    const result = compactCollectiveMemory(memory);
    expect(result.generation).toBe(6);
    expect(result.lastCompactedAt).toBeDefined();
  });

  test("respects maxEntries override", () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      createEntry(`e${String(i)}`, `unique content for entry ${String(i)} some words`, 30 - i),
    );
    const memory: CollectiveMemory = { entries, totalTokens: 5000, generation: 0 };
    const result = compactCollectiveMemory(memory, { maxEntries: 10 });
    expect(result.entries.length).toBeLessThanOrEqual(10);
  });
});
