import { describe, expect, test } from "bun:test";

import type { CurationCandidate, Playbook } from "@koi/ace-types";

import { createDefaultConsolidator } from "./consolidator.js";

function candidate(p: Partial<CurationCandidate>): CurationCandidate {
  return {
    identifier: "fs.read",
    kind: "tool_call",
    score: 0.5,
    stats: {
      identifier: "fs.read",
      kind: "tool_call",
      successes: 5,
      failures: 0,
      retries: 0,
      totalDurationMs: 100,
      invocations: 5,
      lastSeenMs: 0,
    },
    ...p,
  };
}

describe("createDefaultConsolidator", () => {
  test("creates a new playbook at version 1 when none exists", () => {
    const consolidate = createDefaultConsolidator({ alpha: 0.5, clock: () => 1000 });
    const out = consolidate([candidate({ score: 0.9 })], []);
    expect(out.length).toBe(1);
    const pb = out[0];
    expect(pb).toBeDefined();
    expect(pb?.id).toBe("ace:tool_call:fs.read");
    expect(pb?.version).toBe(1);
    expect(pb?.confidence).toBeCloseTo(0.9);
    expect(pb?.sessionCount).toBe(1);
    expect(pb?.createdAt).toBe(1000);
    expect(pb?.updatedAt).toBe(1000);
    expect(pb?.source).toBe("curated");
  });

  test("EMA-blends confidence and bumps version when playbook exists", () => {
    const existing: Playbook = {
      id: "ace:tool_call:fs.read",
      title: "Tool: fs.read",
      strategy: "old",
      tags: ["tool_call"],
      confidence: 0.4,
      source: "curated",
      createdAt: 0,
      updatedAt: 0,
      sessionCount: 2,
      version: 3,
    };
    const consolidate = createDefaultConsolidator({ alpha: 0.5, clock: () => 5000 });
    const out = consolidate([candidate({ score: 0.8 })], [existing]);
    const pb = out[0];
    expect(pb?.version).toBe(4);
    // 0.5 * 0.8 + 0.5 * 0.4 = 0.6
    expect(pb?.confidence).toBeCloseTo(0.6);
    expect(pb?.sessionCount).toBe(3);
    expect(pb?.updatedAt).toBe(5000);
    expect(pb?.createdAt).toBe(0);
    expect(pb?.strategy).not.toBe("old");
  });

  test("clamps confidence to [0,1]", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 0 });
    const high = consolidate([candidate({ score: 5 })], []);
    expect(high[0]?.confidence).toBe(1);
    const negative = consolidate([candidate({ score: -1 })], []);
    expect(negative[0]?.confidence).toBe(0);
  });

  test("strategy includes invocation count and success rate", () => {
    const consolidate = createDefaultConsolidator({ clock: () => 0 });
    const out = consolidate(
      [
        candidate({
          identifier: "x",
          stats: {
            identifier: "x",
            kind: "tool_call",
            successes: 3,
            failures: 1,
            retries: 0,
            totalDurationMs: 400,
            invocations: 4,
            lastSeenMs: 0,
          },
        }),
      ],
      [],
    );
    expect(out[0]?.strategy).toContain("75%");
    expect(out[0]?.strategy).toContain("4 calls");
  });
});
