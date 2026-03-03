import { beforeEach, describe, expect, test } from "bun:test";
import type { ReputationBackend, ReputationFeedback } from "@koi/core";
import { agentId } from "@koi/core";

import { createInMemoryReputationBackend } from "./in-memory-backend.js";

const AGENT_A = agentId("agent-a");
const AGENT_B = agentId("agent-b");
const AGENT_C = agentId("agent-c");

function feedback(overrides?: Partial<ReputationFeedback>): ReputationFeedback {
  return {
    sourceId: AGENT_B,
    targetId: AGENT_A,
    kind: "positive",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Narrow undefined away so subsequent expects don't need `!`. */
function assertDefined<T>(value: T | undefined): asserts value is T {
  expect(value).toBeDefined();
}

describe("createInMemoryReputationBackend", () => {
  // let is justified: reset in beforeEach
  let backend: ReputationBackend;

  beforeEach(() => {
    backend = createInMemoryReputationBackend();
  });

  // -- record ----------------------------------------------------------------

  describe("record", () => {
    test("records feedback successfully", async () => {
      const result = await backend.record(feedback());
      expect(result).toEqual({ ok: true, value: undefined });
    });

    test("is idempotent for identical tuples", async () => {
      const fb = feedback({ timestamp: 1000 });
      await backend.record(fb);
      await backend.record(fb);

      const scoreResult = await backend.getScore(AGENT_A);
      expect(scoreResult).toMatchObject({ ok: true });
      if (scoreResult.ok) {
        assertDefined(scoreResult.value);
        expect(scoreResult.value.feedbackCount).toBe(1);
      }
    });

    test("records different feedback from same source", async () => {
      await backend.record(feedback({ kind: "positive", timestamp: 1000 }));
      await backend.record(feedback({ kind: "negative", timestamp: 2000 }));

      const scoreResult = await backend.getScore(AGENT_A);
      expect(scoreResult).toMatchObject({ ok: true });
      if (scoreResult.ok) {
        assertDefined(scoreResult.value);
        expect(scoreResult.value.feedbackCount).toBe(2);
      }
    });
  });

  // -- getScore --------------------------------------------------------------

  describe("getScore", () => {
    test("returns undefined for unknown agent", async () => {
      const result = await backend.getScore(agentId("unknown"));
      expect(result).toEqual({ ok: true, value: undefined });
    });

    test("returns computed score after recording", async () => {
      await backend.record(feedback({ kind: "positive", timestamp: 1 }));
      await backend.record(feedback({ kind: "positive", timestamp: 2 }));

      const result = await backend.getScore(AGENT_A);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        assertDefined(result.value);
        expect(result.value.score).toBe(1.0);
        expect(result.value.level).toBe("high");
        expect(result.value.agentId).toBe(AGENT_A);
      }
    });
  });

  // -- getScores (batch) -----------------------------------------------------

  describe("getScores", () => {
    test("returns scores for multiple agents", async () => {
      await backend.record(feedback({ targetId: AGENT_A, kind: "positive", timestamp: 1 }));
      await backend.record(feedback({ targetId: AGENT_B, kind: "negative", timestamp: 2 }));

      assertDefined(backend.getScores);
      const result = await backend.getScores([AGENT_A, AGENT_B, AGENT_C]);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        const scores = result.value;
        const scoreA = scores.get(AGENT_A);
        assertDefined(scoreA);
        expect(scoreA.level).toBe("high");

        const scoreB = scores.get(AGENT_B);
        assertDefined(scoreB);
        expect(scoreB.level).toBe("untrusted");

        expect(scores.get(AGENT_C)).toBeUndefined();
      }
    });
  });

  // -- query -----------------------------------------------------------------

  describe("query", () => {
    test("returns empty for no matching entries", async () => {
      const result = await backend.query({ targetId: agentId("nonexistent") });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.value.entries).toHaveLength(0);
        expect(result.value.hasMore).toBe(false);
      }
    });

    test("filters by targetId", async () => {
      await backend.record(feedback({ targetId: AGENT_A, timestamp: 1 }));
      await backend.record(feedback({ targetId: AGENT_B, timestamp: 2 }));

      const result = await backend.query({ targetId: AGENT_A });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.value.entries).toHaveLength(1);
        const first = result.value.entries[0];
        assertDefined(first);
        expect(first.targetId).toBe(AGENT_A);
      }
    });

    test("filters by sourceId", async () => {
      await backend.record(feedback({ sourceId: AGENT_B, timestamp: 1 }));
      await backend.record(feedback({ sourceId: AGENT_C, timestamp: 2 }));

      const result = await backend.query({ sourceId: AGENT_C });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.value.entries).toHaveLength(1);
        const first = result.value.entries[0];
        assertDefined(first);
        expect(first.sourceId).toBe(AGENT_C);
      }
    });

    test("filters by kinds", async () => {
      await backend.record(feedback({ kind: "positive", timestamp: 1 }));
      await backend.record(feedback({ kind: "negative", timestamp: 2 }));
      await backend.record(feedback({ kind: "neutral", timestamp: 3 }));

      const result = await backend.query({ kinds: ["positive", "neutral"] });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.value.entries).toHaveLength(2);
      }
    });

    test("filters by time range (after/before)", async () => {
      await backend.record(feedback({ timestamp: 100 }));
      await backend.record(feedback({ timestamp: 200, kind: "neutral" }));
      await backend.record(feedback({ timestamp: 300, kind: "negative" }));

      const result = await backend.query({ after: 150, before: 250 });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.value.entries).toHaveLength(1);
        const first = result.value.entries[0];
        assertDefined(first);
        expect(first.timestamp).toBe(200);
      }
    });

    test("returns entries sorted by timestamp descending", async () => {
      await backend.record(feedback({ timestamp: 100 }));
      await backend.record(feedback({ timestamp: 300, kind: "neutral" }));
      await backend.record(feedback({ timestamp: 200, kind: "negative" }));

      const result = await backend.query({});
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        const timestamps = result.value.entries.map((e: ReputationFeedback) => e.timestamp);
        expect(timestamps).toEqual([300, 200, 100]);
      }
    });

    test("respects limit and reports hasMore", async () => {
      await backend.record(feedback({ timestamp: 1 }));
      await backend.record(feedback({ timestamp: 2, kind: "neutral" }));
      await backend.record(feedback({ timestamp: 3, kind: "negative" }));

      const result = await backend.query({ limit: 2 });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.value.entries).toHaveLength(2);
        expect(result.value.hasMore).toBe(true);
      }
    });
  });

  // -- ring buffer -----------------------------------------------------------

  describe("ring buffer", () => {
    test("evicts oldest entries when capacity is reached", async () => {
      const small = createInMemoryReputationBackend({ maxEntriesPerAgent: 3 });

      await small.record(feedback({ kind: "negative", timestamp: 1 }));
      await small.record(feedback({ kind: "negative", timestamp: 2 }));
      await small.record(feedback({ kind: "negative", timestamp: 3 }));
      // This should evict timestamp=1
      await small.record(feedback({ kind: "positive", timestamp: 4 }));

      const queryResult = await small.query({ targetId: AGENT_A });
      expect(queryResult).toMatchObject({ ok: true });
      if (queryResult.ok) {
        expect(queryResult.value.entries).toHaveLength(3);
        const timestamps = queryResult.value.entries.map((e: ReputationFeedback) => e.timestamp);
        expect(timestamps).toEqual([4, 3, 2]);
      }
    });
  });

  // -- dispose ---------------------------------------------------------------

  describe("dispose", () => {
    test("clears all data", async () => {
      await backend.record(feedback({ timestamp: 1 }));
      assertDefined(backend.dispose);
      await backend.dispose();

      const result = await backend.getScore(AGENT_A);
      expect(result).toMatchObject({ ok: false });
    });

    test("returns error on record after dispose", async () => {
      assertDefined(backend.dispose);
      await backend.dispose();
      const result = await backend.record(feedback());
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.error.code).toBe("INTERNAL");
      }
    });

    test("returns error on query after dispose", async () => {
      assertDefined(backend.dispose);
      await backend.dispose();
      const result = await backend.query({});
      expect(result).toMatchObject({ ok: false });
    });
  });

  // -- custom weights --------------------------------------------------------

  describe("custom weights", () => {
    test("uses custom weights for score computation", async () => {
      const weighted = createInMemoryReputationBackend({
        weights: { positive: 1.0, neutral: 0.8, negative: 0.2 },
      });

      await weighted.record(feedback({ kind: "negative", timestamp: 1 }));
      const result = await weighted.getScore(AGENT_A);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        assertDefined(result.value);
        expect(result.value.score).toBe(0.2);
      }
    });
  });
});
