import { describe, expect, test } from "bun:test";
import { createDefaultConsolidator } from "./consolidator.js";
import type { AggregatedStats, CurationCandidate, Playbook } from "./types.js";

function makeStats(overrides?: Partial<AggregatedStats>): AggregatedStats {
  return {
    identifier: "read-file",
    kind: "tool_call",
    successes: 8,
    failures: 2,
    retries: 0,
    totalDurationMs: 5000,
    invocations: 10,
    lastSeenMs: 1000,
    ...overrides,
  };
}

function makeCandidate(overrides?: Partial<CurationCandidate>): CurationCandidate {
  return {
    identifier: "read-file",
    kind: "tool_call",
    score: 0.7,
    stats: makeStats(),
    ...overrides,
  };
}

function makePlaybook(overrides?: Partial<Playbook>): Playbook {
  return {
    id: "ace:tool_call:read-file",
    title: "Tool: read-file",
    strategy: "old strategy",
    tags: ["tool_call"],
    confidence: 0.5,
    source: "curated",
    createdAt: 500,
    updatedAt: 800,
    sessionCount: 3,
    ...overrides,
  };
}

describe("createDefaultConsolidator", () => {
  test("creates new playbook from candidate", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 2000 });
    const result = consolidate([makeCandidate()], []);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ace:tool_call:read-file");
    expect(result[0]?.title).toBe("Tool: read-file");
    expect(result[0]?.tags).toEqual(["tool_call"]);
    expect(result[0]?.source).toBe("curated");
    expect(result[0]?.sessionCount).toBe(1);
    expect(result[0]?.createdAt).toBe(2000);
    expect(result[0]?.updatedAt).toBe(2000);
  });

  test("creates model_call playbook with Model prefix", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 1000 });
    const candidate = makeCandidate({ kind: "model_call", identifier: "gpt-4" });
    const result = consolidate([candidate], []);

    expect(result[0]?.id).toBe("ace:model_call:gpt-4");
    expect(result[0]?.title).toBe("Model: gpt-4");
  });

  test("generates strategy text with stats", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 1000 });
    const result = consolidate([makeCandidate()], []);

    // 8/10 = 80%, 5000/10 = 500ms avg
    expect(result[0]?.strategy).toBe("read-file: 80% success rate across 10 calls (avg 500ms).");
  });

  test("generates strategy with zero invocations", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 1000 });
    const candidate = makeCandidate({
      stats: makeStats({ invocations: 0, successes: 0, totalDurationMs: 0 }),
    });
    const result = consolidate([candidate], []);

    expect(result[0]?.strategy).toBe("read-file: 0% success rate across 0 calls (avg 0ms).");
  });

  test("updates existing playbook with EMA blending", () => {
    const consolidate = createDefaultConsolidator({ alpha: 0.3, clock: () => 3000 });
    const existing = makePlaybook({ confidence: 0.5 });
    const candidate = makeCandidate({ score: 0.7 });

    const result = consolidate([candidate], [existing]);

    // EMA: 0.3 * 0.7 + 0.7 * 0.5 = 0.21 + 0.35 = 0.56
    expect(result[0]?.confidence).toBeCloseTo(0.56, 10);
  });

  test("increments sessionCount on update", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 3000 });
    const existing = makePlaybook({ sessionCount: 3 });

    const result = consolidate([makeCandidate()], [existing]);
    expect(result[0]?.sessionCount).toBe(4);
  });

  test("preserves existing playbook fields on update", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 3000 });
    const existing = makePlaybook({
      id: "ace:tool_call:read-file",
      tags: ["tool_call", "io"],
      source: "manual",
      createdAt: 500,
    });

    const result = consolidate([makeCandidate()], [existing]);

    expect(result[0]?.id).toBe("ace:tool_call:read-file");
    expect(result[0]?.tags).toEqual(["tool_call", "io"]);
    expect(result[0]?.source).toBe("manual");
    expect(result[0]?.createdAt).toBe(500);
    expect(result[0]?.updatedAt).toBe(3000);
  });

  test("updates strategy text on existing playbook", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 3000 });
    const existing = makePlaybook({ strategy: "old strategy text" });

    const result = consolidate([makeCandidate()], [existing]);
    expect(result[0]?.strategy).not.toBe("old strategy text");
    expect(result[0]?.strategy).toContain("80% success rate");
  });

  test("clamps confidence to 1 when score exceeds 1", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 1000 });
    const candidate = makeCandidate({ score: 1.5 });

    const result = consolidate([candidate], []);
    expect(result[0]?.confidence).toBe(1);
  });

  test("clamps confidence floor to 0", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 1000 });
    const candidate = makeCandidate({ score: -0.5 });

    const result = consolidate([candidate], []);
    expect(result[0]?.confidence).toBe(0);
  });

  test("uses custom alpha", () => {
    const consolidate = createDefaultConsolidator({ alpha: 0.5, clock: () => 3000 });
    const existing = makePlaybook({ confidence: 0.4 });
    const candidate = makeCandidate({ score: 0.8 });

    const result = consolidate([candidate], [existing]);

    // EMA: 0.5 * 0.8 + 0.5 * 0.4 = 0.4 + 0.2 = 0.6
    expect(result[0]?.confidence).toBeCloseTo(0.6, 10);
  });

  test("uses custom clock", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 9999 });
    const result = consolidate([makeCandidate()], []);

    expect(result[0]?.createdAt).toBe(9999);
    expect(result[0]?.updatedAt).toBe(9999);
  });

  test("handles multiple candidates", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 1000 });
    const candidates = [
      makeCandidate({ identifier: "read-file", kind: "tool_call" }),
      makeCandidate({ identifier: "gpt-4", kind: "model_call" }),
      makeCandidate({ identifier: "write-file", kind: "tool_call" }),
    ];

    const result = consolidate(candidates, []);
    expect(result).toHaveLength(3);
    expect(result[0]?.id).toBe("ace:tool_call:read-file");
    expect(result[1]?.id).toBe("ace:model_call:gpt-4");
    expect(result[2]?.id).toBe("ace:tool_call:write-file");
  });

  test("does not mutate input arrays", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 1000 });
    const candidates = Object.freeze([makeCandidate()]);
    const existing = Object.freeze([makePlaybook()]);

    // Should not throw — inputs are not mutated
    const result = consolidate(candidates, existing);
    expect(result).toHaveLength(1);
    expect(candidates).toHaveLength(1);
    expect(existing).toHaveLength(1);
  });
});
