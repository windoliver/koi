import { describe, expect, test } from "bun:test";
import type { CollectiveMemory, CollectiveMemoryEntry } from "@koi/core";
import { DEFAULT_COLLECTIVE_MEMORY } from "@koi/core";
import {
  compactEntries,
  computeMemoryPriority,
  deduplicateEntries,
  pruneStaleEntries,
  selectEntriesWithinBudget,
} from "./collective-memory.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function createEntry(overrides: Partial<CollectiveMemoryEntry> = {}): CollectiveMemoryEntry {
  return {
    id: overrides.id ?? "e1",
    content: overrides.content ?? "test learning content",
    category: overrides.category ?? "heuristic",
    source: overrides.source ?? { agentId: "agent-1", runId: "run-1", timestamp: NOW },
    createdAt: overrides.createdAt ?? NOW,
    accessCount: overrides.accessCount ?? 1,
    lastAccessedAt: overrides.lastAccessedAt ?? NOW,
  };
}

// ---------------------------------------------------------------------------
// computeMemoryPriority
// ---------------------------------------------------------------------------

describe("computeMemoryPriority", () => {
  test("returns positive score for a fresh entry", () => {
    const entry = createEntry({ accessCount: 5, lastAccessedAt: NOW });
    const score = computeMemoryPriority(entry, NOW);
    expect(score).toBeCloseTo(5, 5);
  });

  test("decays score over time", () => {
    const entry = createEntry({ accessCount: 5, lastAccessedAt: NOW - 7 * MS_PER_DAY });
    const score = computeMemoryPriority(entry, NOW, 7);
    // After one half-life, score should be approximately accessCount / 2
    expect(score).toBeCloseTo(2.5, 1);
  });

  test("uses base weight of 1 for entries with accessCount 0", () => {
    const entry = createEntry({ accessCount: 0, lastAccessedAt: NOW });
    const score = computeMemoryPriority(entry, NOW);
    expect(score).toBeCloseTo(1, 5);
  });

  test("returns higher score for more-accessed entries", () => {
    const lowAccess = createEntry({ accessCount: 1, lastAccessedAt: NOW });
    const highAccess = createEntry({ accessCount: 10, lastAccessedAt: NOW });
    expect(computeMemoryPriority(highAccess, NOW)).toBeGreaterThan(
      computeMemoryPriority(lowAccess, NOW),
    );
  });

  test("handles future lastAccessedAt gracefully (clamps elapsed to 0)", () => {
    const entry = createEntry({ accessCount: 3, lastAccessedAt: NOW + MS_PER_DAY });
    const score = computeMemoryPriority(entry, NOW);
    expect(score).toBeCloseTo(3, 5);
  });
});

// ---------------------------------------------------------------------------
// deduplicateEntries
// ---------------------------------------------------------------------------

describe("deduplicateEntries", () => {
  test("returns empty array for empty input", () => {
    expect(deduplicateEntries([], 0.6, NOW)).toEqual([]);
  });

  test("returns single entry unchanged", () => {
    const entries = [createEntry()];
    expect(deduplicateEntries(entries, 0.6, NOW)).toHaveLength(1);
  });

  test("removes near-duplicate entries", () => {
    const entries = [
      createEntry({ id: "e1", content: "always use frozen lockfile in CI", accessCount: 5 }),
      createEntry({
        id: "e2",
        content: "always use frozen lockfile in CI environments",
        accessCount: 1,
      }),
    ];
    const result = deduplicateEntries(entries, 0.6, NOW);
    expect(result).toHaveLength(1);
    // Keeps the higher-priority one (accessCount: 5)
    expect(result[0]?.id).toBe("e1");
  });

  test("keeps dissimilar entries", () => {
    const entries = [
      createEntry({ id: "e1", content: "always use frozen lockfile in CI" }),
      createEntry({ id: "e2", content: "exponential backoff with jitter for rate limiting" }),
    ];
    const result = deduplicateEntries(entries, 0.6, NOW);
    expect(result).toHaveLength(2);
  });

  test("uses provided threshold", () => {
    const entries = [
      createEntry({ id: "e1", content: "use frozen lockfile", accessCount: 5 }),
      createEntry({ id: "e2", content: "always use frozen lockfile", accessCount: 1 }),
    ];
    // Very high threshold — nothing considered duplicate
    expect(deduplicateEntries(entries, 0.99, NOW)).toHaveLength(2);
    // Very low threshold — almost everything is duplicate
    expect(deduplicateEntries(entries, 0.3, NOW)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// selectEntriesWithinBudget
// ---------------------------------------------------------------------------

describe("selectEntriesWithinBudget", () => {
  test("returns empty array for empty entries", () => {
    expect(selectEntriesWithinBudget([], 1000)).toEqual([]);
  });

  test("returns empty array for zero budget", () => {
    const entries = [createEntry({ content: "some content" })];
    expect(selectEntriesWithinBudget(entries, 0)).toEqual([]);
  });

  test("selects entries within budget", () => {
    // Each entry: 20 chars → 5 tokens at 4 chars/token
    const entries = [
      createEntry({ id: "e1", content: "12345678901234567890", accessCount: 5 }),
      createEntry({ id: "e2", content: "abcdefghijklmnopqrst", accessCount: 3 }),
      createEntry({ id: "e3", content: "ABCDEFGHIJKLMNOPQRST", accessCount: 1 }),
    ];
    // Budget for 2 entries (10 tokens)
    const result = selectEntriesWithinBudget(entries, 10, 4, NOW);
    expect(result).toHaveLength(2);
    // Highest priority first
    expect(result[0]?.id).toBe("e1");
    expect(result[1]?.id).toBe("e2");
  });

  test("skips entries that would exceed remaining budget", () => {
    const entries = [
      createEntry({ id: "e1", content: "short", accessCount: 1 }),
      createEntry({ id: "e2", content: "a".repeat(200), accessCount: 10 }),
    ];
    // Budget: 10 tokens = 40 chars. e2 is 200 chars → 50 tokens, skipped.
    const result = selectEntriesWithinBudget(entries, 10, 4, NOW);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("e1");
  });
});

// ---------------------------------------------------------------------------
// pruneStaleEntries
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  test("keeps entries with accessCount > 0 regardless of age", () => {
    const old = createEntry({
      accessCount: 5,
      createdAt: NOW - 365 * MS_PER_DAY,
    });
    expect(pruneStaleEntries([old], 30, NOW)).toHaveLength(1);
  });

  test("keeps never-accessed entries within cold age", () => {
    const fresh = createEntry({
      accessCount: 0,
      createdAt: NOW - 10 * MS_PER_DAY,
    });
    expect(pruneStaleEntries([fresh], 30, NOW)).toHaveLength(1);
  });

  test("removes never-accessed entries older than cold age", () => {
    const stale = createEntry({
      accessCount: 0,
      createdAt: NOW - 60 * MS_PER_DAY,
    });
    expect(pruneStaleEntries([stale], 30, NOW)).toHaveLength(0);
  });

  test("handles empty array", () => {
    expect(pruneStaleEntries([], 30, NOW)).toEqual([]);
  });

  test("handles mixed entries correctly", () => {
    const entries = [
      createEntry({ id: "kept-accessed", accessCount: 1, createdAt: NOW - 60 * MS_PER_DAY }),
      createEntry({ id: "kept-fresh", accessCount: 0, createdAt: NOW - 5 * MS_PER_DAY }),
      createEntry({ id: "pruned", accessCount: 0, createdAt: NOW - 60 * MS_PER_DAY }),
    ];
    const result = pruneStaleEntries(entries, 30, NOW);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual(["kept-accessed", "kept-fresh"]);
  });
});

// ---------------------------------------------------------------------------
// compactEntries
// ---------------------------------------------------------------------------

describe("compactEntries", () => {
  test("increments generation on compaction", () => {
    const memory: CollectiveMemory = {
      ...DEFAULT_COLLECTIVE_MEMORY,
      entries: [createEntry()],
      generation: 3,
    };
    const result = compactEntries(memory, undefined, NOW);
    expect(result.generation).toBe(4);
  });

  test("sets lastCompactedAt to nowMs", () => {
    const memory: CollectiveMemory = {
      ...DEFAULT_COLLECTIVE_MEMORY,
      entries: [createEntry()],
    };
    const result = compactEntries(memory, undefined, NOW);
    expect(result.lastCompactedAt).toBe(NOW);
  });

  test("prunes stale entries during compaction", () => {
    const memory: CollectiveMemory = {
      ...DEFAULT_COLLECTIVE_MEMORY,
      entries: [
        createEntry({ id: "fresh", accessCount: 0, createdAt: NOW }),
        createEntry({ id: "stale", accessCount: 0, createdAt: NOW - 60 * MS_PER_DAY }),
      ],
    };
    const result = compactEntries(memory, undefined, NOW);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe("fresh");
  });

  test("deduplicates entries during compaction", () => {
    const memory: CollectiveMemory = {
      ...DEFAULT_COLLECTIVE_MEMORY,
      entries: [
        createEntry({ id: "e1", content: "always use frozen lockfile", accessCount: 5 }),
        createEntry({ id: "e2", content: "always use frozen lockfile in CI", accessCount: 1 }),
      ],
    };
    const result = compactEntries(memory, undefined, NOW);
    expect(result.entries).toHaveLength(1);
  });

  test("returns empty entries for empty memory", () => {
    const result = compactEntries(DEFAULT_COLLECTIVE_MEMORY, undefined, NOW);
    expect(result.entries).toEqual([]);
    expect(result.totalTokens).toBe(0);
    expect(result.generation).toBe(1);
  });

  test("updates totalTokens estimate", () => {
    const memory: CollectiveMemory = {
      ...DEFAULT_COLLECTIVE_MEMORY,
      entries: [createEntry({ content: "a".repeat(40) })], // 40 chars → 10 tokens
    };
    const result = compactEntries(memory, undefined, NOW);
    expect(result.totalTokens).toBe(10);
  });

  test("trims to maxEntries when count exceeds threshold", () => {
    const entries: CollectiveMemoryEntry[] = Array.from({ length: 60 }, (_, i) =>
      createEntry({
        id: `e${String(i)}`,
        content: `unique learning number ${String(i)} with extra words to avoid dedup`,
        accessCount: 60 - i,
      }),
    );
    const memory: CollectiveMemory = {
      ...DEFAULT_COLLECTIVE_MEMORY,
      entries,
    };
    const result = compactEntries(memory, { ...COLLECTIVE_MEMORY_DEFAULTS, maxEntries: 50 }, NOW);
    expect(result.entries.length).toBeLessThanOrEqual(50);
  });
});

// Re-import for the constant used in trim test
import { COLLECTIVE_MEMORY_DEFAULTS } from "@koi/core";
