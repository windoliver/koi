import { beforeEach, describe, expect, test } from "bun:test";
import {
  createConsensusSelector,
  createFirstWinsSelector,
  createScoredSelector,
} from "./selection.js";
import { mockProposal, resetMockCounter } from "./test-helpers.js";
import type { Proposal, Vote } from "./types.js";
import { proposalId } from "./types.js";

beforeEach(() => {
  resetMockCounter();
});

// ---------------------------------------------------------------------------
// createFirstWinsSelector
// ---------------------------------------------------------------------------

describe("createFirstWinsSelector", () => {
  const selector = createFirstWinsSelector();

  test("has name 'first-wins'", () => {
    expect(selector.name).toBe("first-wins");
  });

  test("picks proposal with lowest submittedAt", async () => {
    const early = mockProposal({ submittedAt: 1000 });
    const late = mockProposal({ submittedAt: 2000 });
    const result = await selector.select([late, early]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(early.id);
  });

  test("breaks ties by highest salience", async () => {
    const a = mockProposal({ submittedAt: 1000, salience: 0.5 });
    const b = mockProposal({ submittedAt: 1000, salience: 0.9 });
    const result = await selector.select([a, b]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(b.id);
  });

  test("breaks salience ties by lexicographic id", async () => {
    const a = mockProposal({ id: "aaa", submittedAt: 1000, salience: 0.5 });
    const b = mockProposal({ id: "bbb", submittedAt: 1000, salience: 0.5 });
    const result = await selector.select([a, b]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(proposalId("aaa"));
  });

  test("handles single proposal", async () => {
    const solo = mockProposal();
    const result = await selector.select([solo]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(solo.id);
  });

  test("returns error for empty proposals", async () => {
    const result = await selector.select([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("treats undefined salience as 0 for tiebreaking", async () => {
    const noSalience = mockProposal({ id: "no-sal", submittedAt: 1000 });
    const withSalience = mockProposal({ id: "has-sal", submittedAt: 1000, salience: 0.1 });
    const result = await selector.select([noSalience, withSalience]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(proposalId("has-sal"));
  });
});

// ---------------------------------------------------------------------------
// createScoredSelector
// ---------------------------------------------------------------------------

describe("createScoredSelector", () => {
  test("has name 'scored'", () => {
    const selector = createScoredSelector();
    expect(selector.name).toBe("scored");
  });

  test("picks proposal with highest default salience", async () => {
    const selector = createScoredSelector();
    const low = mockProposal({ salience: 0.2 });
    const high = mockProposal({ salience: 0.9 });
    const mid = mockProposal({ salience: 0.5 });
    const result = await selector.select([low, high, mid]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(high.id);
  });

  test("uses custom scoreFn when provided", async () => {
    const selector = createScoredSelector((p: Proposal) => p.durationMs);
    const slow = mockProposal({ durationMs: 500 });
    const fast = mockProposal({ durationMs: 50 });
    const result = await selector.select([slow, fast]);
    expect(result.ok).toBe(true);
    // highest score = highest durationMs
    if (result.ok) expect(result.value.id).toBe(slow.id);
  });

  test("treats NaN score as 0", async () => {
    const selector = createScoredSelector(() => Number.NaN);
    const a = mockProposal({ salience: 0.5 });
    const b = mockProposal({ salience: 0.9 });
    // all scores become 0, so first by submittedAt wins (tiebreaker)
    const result = await selector.select([a, b]);
    expect(result.ok).toBe(true);
  });

  test("treats Infinity score as 0", async () => {
    const selector = createScoredSelector(() => Number.POSITIVE_INFINITY);
    const a = mockProposal();
    const result = await selector.select([a]);
    expect(result.ok).toBe(true);
  });

  test("treats -Infinity score as 0", async () => {
    const selector = createScoredSelector(() => Number.NEGATIVE_INFINITY);
    const a = mockProposal();
    const result = await selector.select([a]);
    expect(result.ok).toBe(true);
  });

  test("treats undefined salience as 0 in default scorer", async () => {
    const selector = createScoredSelector();
    const noSalience = mockProposal({ id: "ns" });
    const withSalience = mockProposal({ id: "ws", salience: 0.1 });
    const result = await selector.select([noSalience, withSalience]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(proposalId("ws"));
  });

  test("returns error for empty proposals", async () => {
    const selector = createScoredSelector();
    const result = await selector.select([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("all saliences are 0 — picks first by submittedAt", async () => {
    const selector = createScoredSelector();
    const first = mockProposal({ id: "first", submittedAt: 100, salience: 0 });
    const second = mockProposal({ id: "second", submittedAt: 200, salience: 0 });
    const result = await selector.select([second, first]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(proposalId("first"));
  });
});

// ---------------------------------------------------------------------------
// createConsensusSelector
// ---------------------------------------------------------------------------

describe("createConsensusSelector", () => {
  test("has name 'consensus'", () => {
    const selector = createConsensusSelector({
      threshold: 0.5,
      judge: async () => [],
    });
    expect(selector.name).toBe("consensus");
  });

  test("picks proposal exceeding threshold", async () => {
    const p1 = mockProposal({ id: "p1" });
    const p2 = mockProposal({ id: "p2" });
    const selector = createConsensusSelector({
      threshold: 0.5,
      judge: async (): Promise<readonly Vote[]> => [
        { proposalId: proposalId("p1"), score: 0.8 },
        { proposalId: proposalId("p2"), score: 0.2 },
      ],
    });
    const result = await selector.select([p1, p2]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(proposalId("p1"));
  });

  test("returns error when no proposal exceeds threshold", async () => {
    const p1 = mockProposal({ id: "p1" });
    const p2 = mockProposal({ id: "p2" });
    const selector = createConsensusSelector({
      threshold: 0.9,
      judge: async (): Promise<readonly Vote[]> => [
        { proposalId: proposalId("p1"), score: 0.4 },
        { proposalId: proposalId("p2"), score: 0.4 },
      ],
    });
    const result = await selector.select([p1, p2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("consensus");
    }
  });

  test("accepts proposal at exact threshold boundary", async () => {
    const p1 = mockProposal({ id: "p1" });
    const selector = createConsensusSelector({
      threshold: 0.5,
      judge: async (): Promise<readonly Vote[]> => [{ proposalId: proposalId("p1"), score: 0.5 }],
    });
    const result = await selector.select([p1]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(proposalId("p1"));
  });

  test("returns error for empty proposals", async () => {
    const selector = createConsensusSelector({
      threshold: 0.5,
      judge: async () => [],
    });
    const result = await selector.select([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("ignores votes for unknown proposal IDs", async () => {
    const p1 = mockProposal({ id: "p1" });
    const selector = createConsensusSelector({
      threshold: 0.5,
      judge: async (): Promise<readonly Vote[]> => [
        { proposalId: proposalId("unknown"), score: 1.0 },
        { proposalId: proposalId("p1"), score: 0.6 },
      ],
    });
    const result = await selector.select([p1]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(proposalId("p1"));
  });

  test("aggregates multiple votes for same proposal", async () => {
    const p1 = mockProposal({ id: "p1" });
    const selector = createConsensusSelector({
      threshold: 0.5,
      judge: async (): Promise<readonly Vote[]> => [
        { proposalId: proposalId("p1"), score: 0.3 },
        { proposalId: proposalId("p1"), score: 0.4 },
      ],
    });
    // total score for p1 = 0.7, total all votes = 0.7, fraction = 1.0
    const result = await selector.select([p1]);
    expect(result.ok).toBe(true);
  });

  test("throws RangeError for threshold > 1", () => {
    expect(() => createConsensusSelector({ threshold: 1.5, judge: async () => [] })).toThrow(
      RangeError,
    );
  });

  test("throws RangeError for negative threshold", () => {
    expect(() => createConsensusSelector({ threshold: -0.1, judge: async () => [] })).toThrow(
      RangeError,
    );
  });

  test("accepts threshold at boundary 0", () => {
    expect(() => createConsensusSelector({ threshold: 0, judge: async () => [] })).not.toThrow();
  });

  test("accepts threshold at boundary 1", () => {
    expect(() => createConsensusSelector({ threshold: 1, judge: async () => [] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Table-driven invariants
// ---------------------------------------------------------------------------

describe("selection invariants", () => {
  const strategies = [
    { name: "first-wins", factory: () => createFirstWinsSelector() },
    { name: "scored", factory: () => createScoredSelector() },
  ] as const;

  for (const { name, factory } of strategies) {
    test(`${name}: single proposal always wins`, async () => {
      const selector = factory();
      const solo = mockProposal();
      const result = await selector.select([solo]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.id).toBe(solo.id);
    });

    test(`${name}: winner is always from the input set`, async () => {
      const selector = factory();
      const proposals = [mockProposal(), mockProposal(), mockProposal()];
      const result = await selector.select(proposals);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const winnerInSet = proposals.some((p) => p.id === result.value.id);
        expect(winnerInSet).toBe(true);
      }
    });

    test(`${name}: deterministic — same input yields same winner`, async () => {
      const selector = factory();
      const proposals = [
        mockProposal({ id: "d1", submittedAt: 1000, salience: 0.5 }),
        mockProposal({ id: "d2", submittedAt: 1000, salience: 0.5 }),
      ];
      const r1 = await selector.select(proposals);
      const r2 = await selector.select(proposals);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) expect(r1.value.id).toBe(r2.value.id);
    });
  }
});
