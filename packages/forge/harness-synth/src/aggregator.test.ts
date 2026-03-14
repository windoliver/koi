import { describe, expect, test } from "bun:test";
import {
  aggregateFailures,
  clusterByErrorPattern,
  deduplicateFailures,
  filterRecursive,
  filterStale,
} from "./aggregator.js";
import type { AggregatorConfig, ToolFailureRecord } from "./types.js";
import { DEFAULT_AGGREGATOR_CONFIG } from "./types.js";

const NOW = 1_700_000_000_000;

function makeFailure(overrides: Partial<ToolFailureRecord> = {}): ToolFailureRecord {
  return {
    timestamp: NOW - 60_000, // 1 minute ago
    toolName: "search",
    errorCode: "TIMEOUT",
    errorMessage: "Request timed out after 30s",
    parameters: { query: "test" },
    ...overrides,
  };
}

describe("filterRecursive", () => {
  test("excludes failures from harness-synthesized middleware", () => {
    const records = [
      makeFailure({ forgedBy: "harness-synth" }),
      makeFailure({ forgedBy: undefined }),
      makeFailure({ forgedBy: "auto-forge-middleware" }),
    ];
    const result = filterRecursive(records, ["harness-synth"]);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.forgedBy !== "harness-synth")).toBe(true);
  });

  test("keeps all failures when exclude list is empty", () => {
    const records = [
      makeFailure({ forgedBy: "harness-synth" }),
      makeFailure({ forgedBy: undefined }),
    ];
    const result = filterRecursive(records, []);
    expect(result).toHaveLength(2);
  });

  test("keeps failures without forgedBy tag", () => {
    const records = [makeFailure(), makeFailure({ forgedBy: undefined })];
    const result = filterRecursive(records, ["harness-synth"]);
    expect(result).toHaveLength(2);
  });

  test("excludes multiple forgedBy tags", () => {
    const records = [
      makeFailure({ forgedBy: "harness-synth" }),
      makeFailure({ forgedBy: "other-synth" }),
      makeFailure({ forgedBy: "safe-source" }),
    ];
    const result = filterRecursive(records, ["harness-synth", "other-synth"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.forgedBy).toBe("safe-source");
  });
});

describe("filterStale", () => {
  test("removes failures older than maxAgeMs", () => {
    const records = [
      makeFailure({ timestamp: NOW - 7_200_000 }), // 2 hours ago
      makeFailure({ timestamp: NOW - 1_800_000 }), // 30 min ago
      makeFailure({ timestamp: NOW - 60_000 }), // 1 min ago
    ];
    const { fresh, staleCount } = filterStale(records, NOW, 3_600_000);
    expect(fresh).toHaveLength(2);
    expect(staleCount).toBe(1);
  });

  test("keeps all when none are stale", () => {
    const records = [
      makeFailure({ timestamp: NOW - 60_000 }),
      makeFailure({ timestamp: NOW - 120_000 }),
    ];
    const { fresh, staleCount } = filterStale(records, NOW, 3_600_000);
    expect(fresh).toHaveLength(2);
    expect(staleCount).toBe(0);
  });

  test("removes all when all are stale", () => {
    const records = [
      makeFailure({ timestamp: NOW - 7_200_000 }),
      makeFailure({ timestamp: NOW - 7_200_001 }),
    ];
    const { fresh, staleCount } = filterStale(records, NOW, 3_600_000);
    expect(fresh).toHaveLength(0);
    expect(staleCount).toBe(2);
  });

  test("boundary: exactly at maxAge is kept", () => {
    const records = [makeFailure({ timestamp: NOW - 3_600_000 })];
    const { fresh } = filterStale(records, NOW, 3_600_000);
    expect(fresh).toHaveLength(1);
  });
});

describe("deduplicateFailures", () => {
  test("keeps most recent failure per (tool, error, params)", () => {
    const records = [
      makeFailure({ timestamp: NOW - 120_000 }),
      makeFailure({ timestamp: NOW - 60_000 }),
      makeFailure({ timestamp: NOW - 180_000 }),
    ];
    const { deduplicated, removedCount } = deduplicateFailures(records);
    expect(deduplicated).toHaveLength(1);
    expect(deduplicated[0]?.timestamp).toBe(NOW - 60_000);
    expect(removedCount).toBe(2);
  });

  test("keeps distinct failures with different error codes", () => {
    const records = [
      makeFailure({ errorCode: "TIMEOUT" }),
      makeFailure({ errorCode: "VALIDATION" }),
    ];
    const { deduplicated, removedCount } = deduplicateFailures(records);
    expect(deduplicated).toHaveLength(2);
    expect(removedCount).toBe(0);
  });

  test("keeps distinct failures with different parameters", () => {
    const records = [
      makeFailure({ parameters: { query: "foo" } }),
      makeFailure({ parameters: { query: "bar" } }),
    ];
    const { deduplicated, removedCount } = deduplicateFailures(records);
    expect(deduplicated).toHaveLength(2);
    expect(removedCount).toBe(0);
  });

  test("keeps distinct failures with different tool names", () => {
    const records = [makeFailure({ toolName: "search" }), makeFailure({ toolName: "write_file" })];
    const { deduplicated } = deduplicateFailures(records);
    expect(deduplicated).toHaveLength(2);
  });

  test("handles empty input", () => {
    const { deduplicated, removedCount } = deduplicateFailures([]);
    expect(deduplicated).toHaveLength(0);
    expect(removedCount).toBe(0);
  });
});

describe("clusterByErrorPattern", () => {
  test("groups failures by error code", () => {
    const records = [
      makeFailure({ errorCode: "TIMEOUT" }),
      makeFailure({ errorCode: "TIMEOUT" }),
      makeFailure({ errorCode: "VALIDATION" }),
    ];
    const clusters = clusterByErrorPattern(records);
    expect(clusters.size).toBe(2);
    expect(clusters.get("TIMEOUT")).toHaveLength(2);
    expect(clusters.get("VALIDATION")).toHaveLength(1);
  });

  test("returns empty map for empty input", () => {
    const clusters = clusterByErrorPattern([]);
    expect(clusters.size).toBe(0);
  });
});

describe("aggregateFailures", () => {
  const config: AggregatorConfig = {
    ...DEFAULT_AGGREGATOR_CONFIG,
    minFailures: 3,
    maxAgeMs: 3_600_000,
  };

  test("returns null when insufficient distinct failures", () => {
    const records = [makeFailure(), makeFailure()]; // 2 < minFailures(3), and they dedup to 1
    const result = aggregateFailures(records, NOW, config);
    expect(result).toBeNull();
  });

  test("returns qualified failures when sufficient data", () => {
    const records = [
      makeFailure({ errorCode: "TIMEOUT", parameters: { q: "a" } }),
      makeFailure({ errorCode: "VALIDATION", parameters: { q: "b" } }),
      makeFailure({ errorCode: "RATE_LIMIT", parameters: { q: "c" } }),
    ];
    const result = aggregateFailures(records, NOW, config);
    expect(result).not.toBeNull();
    expect(result?.failures).toHaveLength(3);
    expect(result?.clusterCount).toBe(3);
    expect(result?.rawCount).toBe(3);
  });

  test("excludes harness-synthesized failures", () => {
    const records = [
      makeFailure({ errorCode: "A", parameters: { q: "1" } }),
      makeFailure({ errorCode: "B", parameters: { q: "2" } }),
      makeFailure({ errorCode: "C", parameters: { q: "3" }, forgedBy: "harness-synth" }),
      makeFailure({ errorCode: "D", parameters: { q: "4" } }),
    ];
    const result = aggregateFailures(records, NOW, config);
    expect(result).not.toBeNull();
    expect(result?.failures).toHaveLength(3);
    expect(result?.failures.every((f) => f.forgedBy !== "harness-synth")).toBe(true);
  });

  test("returns null when ALL failures are from synthesized middleware", () => {
    const records = [
      makeFailure({ errorCode: "A", forgedBy: "harness-synth" }),
      makeFailure({ errorCode: "B", forgedBy: "harness-synth" }),
      makeFailure({ errorCode: "C", forgedBy: "harness-synth" }),
    ];
    const result = aggregateFailures(records, NOW, config);
    expect(result).toBeNull();
  });

  test("filters stale failures before dedup", () => {
    const records = [
      makeFailure({ errorCode: "A", parameters: { q: "1" }, timestamp: NOW - 7_200_000 }), // stale
      makeFailure({ errorCode: "B", parameters: { q: "2" } }),
      makeFailure({ errorCode: "C", parameters: { q: "3" } }),
      makeFailure({ errorCode: "D", parameters: { q: "4" } }),
    ];
    const result = aggregateFailures(records, NOW, config);
    expect(result).not.toBeNull();
    expect(result?.staleCount).toBe(1);
    expect(result?.failures).toHaveLength(3);
  });

  test("deduplicates before sufficiency check", () => {
    // 5 records, but all same (tool, error, params) → dedup to 1 → insufficient
    const records = Array.from({ length: 5 }, (_, i) =>
      makeFailure({ timestamp: NOW - (i + 1) * 60_000 }),
    );
    const result = aggregateFailures(records, NOW, config);
    expect(result).toBeNull();
  });

  test("reports accurate counts", () => {
    const records = [
      makeFailure({ errorCode: "A", parameters: { q: "1" } }),
      makeFailure({ errorCode: "A", parameters: { q: "1" }, timestamp: NOW - 30_000 }), // dup
      makeFailure({ errorCode: "B", parameters: { q: "2" } }),
      makeFailure({ errorCode: "C", parameters: { q: "3" } }),
      makeFailure({ errorCode: "D", parameters: { q: "4" }, timestamp: NOW - 7_200_000 }), // stale
    ];
    const result = aggregateFailures(records, NOW, config);
    expect(result).not.toBeNull();
    expect(result?.rawCount).toBe(5);
    expect(result?.staleCount).toBe(1);
    expect(result?.deduplicatedCount).toBe(1);
    expect(result?.failures).toHaveLength(3);
    expect(result?.clusterCount).toBe(3);
  });
});
