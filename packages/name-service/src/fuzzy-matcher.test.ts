import { describe, expect, test } from "bun:test";
import type { AgentId, NameRecord } from "@koi/core";
import { compositeKey } from "./composite-key.js";
import { computeSuggestions } from "./fuzzy-matcher.js";

const DEFAULT_CONFIG = {
  maxSuggestionDistance: 3,
  maxSuggestions: 5,
} as const;

function makeRecord(
  name: string,
  scope: NameRecord["scope"] = "agent",
  aliases: readonly string[] = [],
): NameRecord {
  return {
    name,
    binding: { kind: "agent", agentId: `agent-${name}` as AgentId },
    scope,
    aliases,
    registeredAt: Date.now(),
    expiresAt: 0,
    registeredBy: "test",
  };
}

function makeRecordsMap(records: readonly NameRecord[]): Map<string, NameRecord> {
  return new Map(records.map((r) => [compositeKey(r.scope, r.name), r]));
}

describe("computeSuggestions", () => {
  test("returns suggestions sorted by distance", () => {
    const records = makeRecordsMap([
      makeRecord("reviewer"),
      makeRecord("reviwer"), // distance 1 from "reviewer"
      makeRecord("coder"), // distance 4+ from "reviewer"
    ]);

    const suggestions = computeSuggestions("reviewr", undefined, records, DEFAULT_CONFIG);
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions[0]?.name).toBe("reviewer");
  });

  test("includes alias matches", () => {
    const records = makeRecordsMap([makeRecord("code-reviewer", "agent", ["cr"])]);

    const suggestions = computeSuggestions("c", undefined, records, DEFAULT_CONFIG);
    expect(suggestions.some((s) => s.name === "cr")).toBe(true);
  });

  test("filters by scope when provided", () => {
    const records = makeRecordsMap([
      makeRecord("reviewer", "agent"),
      makeRecord("reviewer", "global"),
    ]);

    const suggestions = computeSuggestions("reviewr", "agent", records, DEFAULT_CONFIG);
    expect(suggestions.every((s) => s.scope === "agent")).toBe(true);
  });

  test("respects maxSuggestions limit", () => {
    const records = makeRecordsMap([
      makeRecord("aaa"),
      makeRecord("aab"),
      makeRecord("aac"),
      makeRecord("aad"),
      makeRecord("aae"),
      makeRecord("aaf"),
    ]);

    const suggestions = computeSuggestions("aag", undefined, records, {
      ...DEFAULT_CONFIG,
      maxSuggestions: 3,
    });
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  test("returns empty array when no matches within distance", () => {
    const records = makeRecordsMap([makeRecord("completely-different-name")]);

    const suggestions = computeSuggestions("x", undefined, records, DEFAULT_CONFIG);
    expect(suggestions).toEqual([]);
  });

  test("skips expired records", () => {
    const record = {
      ...makeRecord("reviewer"),
      expiresAt: Date.now() - 1000,
    };
    const records = makeRecordsMap([record]);

    const suggestions = computeSuggestions("reviewr", undefined, records, DEFAULT_CONFIG);
    expect(suggestions).toEqual([]);
  });

  test("returns frozen array", () => {
    const records = makeRecordsMap([makeRecord("reviewer")]);
    const suggestions = computeSuggestions("reviewr", undefined, records, DEFAULT_CONFIG);
    expect(Object.isFrozen(suggestions)).toBe(true);
  });

  test("exact match returns distance 0", () => {
    const records = makeRecordsMap([makeRecord("reviewer")]);
    const suggestions = computeSuggestions("reviewer", undefined, records, DEFAULT_CONFIG);
    expect(suggestions[0]?.distance).toBe(0);
  });
});
