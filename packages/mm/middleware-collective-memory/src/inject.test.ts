import { describe, expect, test } from "bun:test";
import type { CollectiveMemoryEntry } from "@koi/core";
import { formatCollectiveMemory } from "./inject.js";

const NOW = 1_700_000_000_000;

function createEntry(
  content: string,
  category: CollectiveMemoryEntry["category"],
  accessCount = 1,
): CollectiveMemoryEntry {
  return {
    id: `e_${content.slice(0, 8)}`,
    content,
    category,
    source: { agentId: "agent-1", runId: "run-1", timestamp: NOW },
    createdAt: NOW,
    accessCount,
    lastAccessedAt: NOW,
  };
}

describe("formatCollectiveMemory", () => {
  test("returns empty string for empty entries", () => {
    expect(formatCollectiveMemory([], 2000)).toBe("");
  });

  test("returns empty string for zero budget", () => {
    const entries = [createEntry("test", "gotcha")];
    expect(formatCollectiveMemory(entries, 0)).toBe("");
  });

  test("formats single entry with category heading", () => {
    const entries = [createEntry("Always use --frozen-lockfile in CI", "gotcha")];
    const result = formatCollectiveMemory(entries, 2000);
    expect(result).toContain("## Collective Memory");
    expect(result).toContain("### Gotchas");
    expect(result).toContain("- Always use --frozen-lockfile in CI");
  });

  test("groups entries by category", () => {
    const entries = [
      createEntry("Use retry with backoff", "pattern"),
      createEntry("API returns 429 after 100 req/min", "gotcha"),
      createEntry("Start with simple model", "heuristic"),
    ];
    const result = formatCollectiveMemory(entries, 2000);
    expect(result).toContain("### Gotchas");
    expect(result).toContain("### Patterns");
    expect(result).toContain("### Heuristics");
  });

  test("renders categories in display order (gotchas first)", () => {
    const entries = [
      createEntry("Use retry", "pattern"),
      createEntry("Watch out for rate limits", "gotcha"),
    ];
    const result = formatCollectiveMemory(entries, 2000);
    const gotchaIdx = result.indexOf("### Gotchas");
    const patternIdx = result.indexOf("### Patterns");
    expect(gotchaIdx).toBeLessThan(patternIdx);
  });

  test("respects token budget by excluding excess entries", () => {
    // Each entry ~10 chars → ~3 tokens at 4 chars/token
    const entries = Array.from({ length: 100 }, (_, i) =>
      createEntry(`learning ${String(i)}`, "heuristic", 100 - i),
    );
    // Very small budget
    const result = formatCollectiveMemory(entries, 5, 4);
    // Should only include a few entries
    expect(result.length).toBeLessThan(500);
  });
});
