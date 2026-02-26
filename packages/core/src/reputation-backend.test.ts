import { describe, expect, test } from "bun:test";
import { agentId } from "./ecs.js";
import type {
  FeedbackKind,
  ReputationBackend,
  ReputationFeedback,
  ReputationLevel,
  ReputationQuery,
  ReputationQueryResult,
  ReputationScore,
} from "./reputation-backend.js";
import { DEFAULT_REPUTATION_QUERY_LIMIT, REPUTATION_LEVEL_ORDER } from "./reputation-backend.js";

describe("ReputationFeedback", () => {
  test("conforms to interface shape", () => {
    const feedback = {
      sourceId: agentId("agent-a"),
      targetId: agentId("agent-b"),
      kind: "positive" as FeedbackKind,
      timestamp: 1_000_000,
    } satisfies ReputationFeedback;
    expect(feedback.kind).toBe("positive");
  });

  test("accepts optional context field", () => {
    const feedback = {
      sourceId: agentId("agent-a"),
      targetId: agentId("agent-b"),
      kind: "negative" as FeedbackKind,
      context: { taskId: "t123", domain: "coding" },
      timestamp: 1_000_000,
    } satisfies ReputationFeedback;
    expect(feedback.context?.taskId).toBe("t123");
  });

  test("accepts neutral kind", () => {
    const feedback = {
      sourceId: agentId("agent-a"),
      targetId: agentId("agent-b"),
      kind: "neutral" as FeedbackKind,
      timestamp: 2_000_000,
    } satisfies ReputationFeedback;
    expect(feedback.kind).toBe("neutral");
  });
});

describe("REPUTATION_LEVEL_ORDER", () => {
  test("has 6 ordered levels", () => {
    expect(REPUTATION_LEVEL_ORDER).toHaveLength(6);
  });

  test("starts with unknown and ends with verified", () => {
    expect(REPUTATION_LEVEL_ORDER[0]).toBe("unknown");
    expect(REPUTATION_LEVEL_ORDER[REPUTATION_LEVEL_ORDER.length - 1]).toBe("verified");
  });

  test("is frozen at runtime", () => {
    expect(Object.isFrozen(REPUTATION_LEVEL_ORDER)).toBe(true);
  });

  test("contains all expected levels in order", () => {
    expect(REPUTATION_LEVEL_ORDER).toEqual([
      "unknown",
      "untrusted",
      "low",
      "medium",
      "high",
      "verified",
    ]);
  });

  test("unknown index is lower than verified index", () => {
    const unknownIdx = REPUTATION_LEVEL_ORDER.indexOf("unknown");
    const verifiedIdx = REPUTATION_LEVEL_ORDER.indexOf("verified");
    expect(unknownIdx).toBeLessThan(verifiedIdx);
  });
});

describe("ReputationLevel", () => {
  test("all values are present in REPUTATION_LEVEL_ORDER", () => {
    const levels: readonly ReputationLevel[] = [
      "unknown",
      "untrusted",
      "low",
      "medium",
      "high",
      "verified",
    ];
    for (const level of levels) {
      expect(REPUTATION_LEVEL_ORDER).toContain(level);
    }
  });

  test("ReputationScore accepts each level", () => {
    const levels: readonly ReputationLevel[] = REPUTATION_LEVEL_ORDER;
    for (const level of levels) {
      const score = {
        agentId: agentId("agent-b"),
        score: 0.5,
        level,
        feedbackCount: 1,
        computedAt: 1_000_000,
      } satisfies ReputationScore;
      expect(score.level).toBe(level);
    }
  });
});

describe("DEFAULT_REPUTATION_QUERY_LIMIT", () => {
  test("is a positive integer", () => {
    expect(DEFAULT_REPUTATION_QUERY_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_REPUTATION_QUERY_LIMIT)).toBe(true);
  });
});

describe("ReputationQuery", () => {
  test("all fields are optional", () => {
    const emptyQuery = {} satisfies ReputationQuery;
    expect(emptyQuery).toBeDefined();
  });

  test("supports full filter shape", () => {
    const fullQuery = {
      targetId: agentId("agent-b"),
      sourceId: agentId("agent-a"),
      kinds: ["positive", "negative"] as readonly FeedbackKind[],
      after: 1_000_000,
      before: 2_000_000,
      limit: 50,
    } satisfies ReputationQuery;
    expect(fullQuery.limit).toBe(50);
  });

  test("supports partial filter", () => {
    const partialQuery: ReputationQuery = {
      targetId: agentId("agent-b"),
      limit: 10,
    };
    expect(partialQuery.targetId).toBe(agentId("agent-b"));
    expect(partialQuery.sourceId).toBeUndefined();
  });
});

describe("ReputationScore", () => {
  test("conforms to interface shape", () => {
    const score = {
      agentId: agentId("agent-b"),
      score: 0.75,
      level: "high",
      feedbackCount: 42,
      computedAt: 1_000_000,
    } satisfies ReputationScore;
    expect(score.score).toBe(0.75);
    expect(score.level).toBe("high");
  });
});

describe("ReputationQueryResult", () => {
  test("conforms to interface shape with hasMore", () => {
    const result = {
      entries: [],
      hasMore: false,
    } satisfies ReputationQueryResult;
    expect(result.hasMore).toBe(false);
  });
});

describe("ReputationBackend interface", () => {
  test("type-compatible minimal implementation compiles", () => {
    // Type-conformance only — verify the interface shape is structurally correct
    const backend = {
      record: (_feedback: ReputationFeedback) => ({ ok: true as const, value: undefined }),
      getScore: (_targetId: ReturnType<typeof agentId>) => ({
        ok: true as const,
        value: undefined,
      }),
      query: (_filter: ReputationQuery) => ({
        ok: true as const,
        value: { entries: [], hasMore: false } satisfies ReputationQueryResult,
      }),
    } satisfies ReputationBackend;
    expect(backend.record).toBeDefined();
    expect(backend.getScore).toBeDefined();
    expect(backend.query).toBeDefined();
  });

  test("optional methods are not required", () => {
    // Verify getScores and dispose are truly optional
    const minimalBackend: ReputationBackend = {
      record: (_feedback: ReputationFeedback) => ({ ok: true as const, value: undefined }),
      getScore: (_targetId: ReturnType<typeof agentId>) => ({
        ok: true as const,
        value: undefined,
      }),
      query: (_filter: ReputationQuery) => ({
        ok: true as const,
        value: { entries: [], hasMore: false } satisfies ReputationQueryResult,
      }),
    };
    expect(minimalBackend.getScores).toBeUndefined();
    expect(minimalBackend.dispose).toBeUndefined();
  });
});
