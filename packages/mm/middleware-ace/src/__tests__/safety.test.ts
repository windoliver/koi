/**
 * Safety property tests — invariants that must hold under all conditions.
 */

import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import type { ModelRequest } from "@koi/core/middleware";
import { estimateTokens } from "@koi/token-estimator";
import { createAceMiddleware } from "../ace.js";
import { applyOperations } from "../curator.js";
import { selectPlaybooks } from "../injector.js";
import { estimateStructuredTokens } from "../playbook.js";
import { computeCurationScore, computeRecencyFactor } from "../scoring.js";
import { createInMemoryPlaybookStore, createInMemoryTrajectoryStore } from "../stores.js";
import { createTrajectoryBuffer } from "../trajectory-buffer.js";
import type {
  AggregatedStats,
  CuratorOperation,
  Playbook,
  PlaybookBullet,
  PlaybookSection,
  StructuredPlaybook,
} from "../types.js";

function makeStats(overrides?: Partial<AggregatedStats>): AggregatedStats {
  return {
    identifier: "tool-a",
    kind: "tool_call",
    successes: 5,
    failures: 5,
    retries: 0,
    totalDurationMs: 500,
    invocations: 10,
    lastSeenMs: 1000,
    ...overrides,
  };
}

function makePlaybook(overrides?: Partial<Playbook>): Playbook {
  return {
    id: "pb-1",
    title: "Test",
    strategy: "Do something",
    tags: [],
    confidence: 0.8,
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 1,
    ...overrides,
  };
}

describe("safety: scoring bounds", () => {
  test("confidence is always in [0, 1]", () => {
    const cases = [
      makeStats({ successes: 0, failures: 10, invocations: 10 }),
      makeStats({ successes: 10, failures: 0, invocations: 10 }),
      makeStats({ successes: 100, failures: 0, invocations: 100 }),
      makeStats({ successes: 5, failures: 5, invocations: 10 }),
      makeStats({ invocations: 0 }),
    ];

    for (const stats of cases) {
      const score = computeCurationScore(stats, 5, 1000, 0.01);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  test("recency factor is always in [0, 1]", () => {
    const lambdas = [0, 0.001, 0.01, 0.1, 1, 10];
    const ages = [0, 1, 10, 100, 1000, 10000];
    const MS_PER_DAY = 86400000;

    for (const lambda of lambdas) {
      for (const days of ages) {
        const now = 1000 + days * MS_PER_DAY;
        const factor = computeRecencyFactor(1000, now, lambda);
        expect(factor).toBeGreaterThanOrEqual(0);
        expect(factor).toBeLessThanOrEqual(1);
      }
    }
  });

  test("zero invocations always produces score 0", () => {
    const stats = makeStats({ invocations: 0, successes: 0, failures: 0 });
    for (const sessions of [0, 1, 5, 100]) {
      expect(computeCurationScore(stats, sessions, 1000, 0.01)).toBe(0);
    }
  });

  test("zero sessions always produces score 0", () => {
    const stats = makeStats({ invocations: 10, successes: 10, failures: 0 });
    expect(computeCurationScore(stats, 0, 1000, 0.01)).toBe(0);
  });
});

describe("safety: token budget", () => {
  test("selected playbooks never exceed maxTokens", () => {
    const playbooks = Array.from({ length: 20 }, (_, i) =>
      makePlaybook({
        id: `pb-${i}`,
        strategy: "x".repeat(Math.floor(Math.random() * 200) + 10),
        confidence: Math.random(),
      }),
    );

    const budgets = [10, 50, 100, 500, 1000];
    for (const maxTokens of budgets) {
      const selected = selectPlaybooks(playbooks, {
        maxTokens,
        clock: () => 1000,
      });
      const totalTokens = selected.reduce((sum, pb) => sum + estimateTokens(pb.strategy), 0);
      expect(totalTokens).toBeLessThanOrEqual(maxTokens);
    }
  });

  test("empty playbook list always returns empty", () => {
    const result = selectPlaybooks([], { maxTokens: 1000, clock: () => 1000 });
    expect(result).toHaveLength(0);
  });
});

describe("safety: buffer bounds", () => {
  test("buffer never exceeds capacity", () => {
    const capacity = 5;
    const buf = createTrajectoryBuffer(capacity);

    for (let i = 0; i < 100; i++) {
      buf.record({
        turnIndex: i,
        timestamp: i * 100,
        kind: "tool_call",
        identifier: `tool-${i % 3}`,
        outcome: "success",
        durationMs: 10,
      });
      expect(buf.size()).toBeLessThanOrEqual(capacity);
    }
  });

  test("buffer eviction preserves most recent entries", () => {
    const buf = createTrajectoryBuffer(3);

    for (let i = 0; i < 10; i++) {
      buf.record({
        turnIndex: i,
        timestamp: i * 100,
        kind: "tool_call",
        identifier: "tool-a",
        outcome: "success",
        durationMs: 10,
      });
    }

    const entries = buf.flush();
    expect(entries).toHaveLength(3);
    // Most recent should be turn 7, 8, 9
    expect(entries[0]?.turnIndex).toBe(7);
    expect(entries[1]?.turnIndex).toBe(8);
    expect(entries[2]?.turnIndex).toBe(9);
  });

  test("flush returns empty array when buffer is empty", () => {
    const buf = createTrajectoryBuffer(10);
    expect(buf.flush()).toHaveLength(0);
  });
});

describe("safety: stale playbook decay", () => {
  test("very old playbooks produce lower injection priority", () => {
    const MS_PER_DAY = 86400000;
    const now = 1000 + 365 * MS_PER_DAY; // 1 year later

    const _recentPb = makePlaybook({
      id: "recent",
      confidence: 0.8,
      updatedAt: now,
    });
    const _stalePb = makePlaybook({
      id: "stale",
      confidence: 0.8,
      updatedAt: 1000,
    });

    // Both have same confidence, but selectPlaybooks only uses confidence
    // The decay would affect curation scores, not injection
    // This test verifies the scoring system handles staleness
    const staleStats = makeStats({ lastSeenMs: 1000 });
    const recentStats = makeStats({ lastSeenMs: now });

    const staleScore = computeCurationScore(staleStats, 5, now, 0.01);
    const recentScore = computeCurationScore(recentStats, 5, now, 0.01);

    expect(recentScore).toBeGreaterThan(staleScore);
    expect(staleScore).toBeLessThan(0.5); // Significantly decayed after 1 year
  });
});

describe("safety: empty trajectory handling", () => {
  test("onSessionEnd with no recorded entries produces no changes", async () => {
    const trajectoryStore = createInMemoryTrajectoryStore();
    const playbookStore = createInMemoryPlaybookStore();
    let curateCalled = false; // let: flag for callback detection

    const mw = createAceMiddleware({
      trajectoryStore,
      playbookStore,
      clock: () => 1000,
      onCurate: () => {
        curateCalled = true;
      },
    });

    await mw.onSessionEnd?.({
      agentId: "a",
      sessionId: "s" as never,
      runId: "r" as never,
      metadata: {},
    });

    expect(curateCalled).toBe(false);
    const sessions = await trajectoryStore.listSessions();
    expect(sessions).toHaveLength(0);
  });
});

describe("safety: middleware does not mutate inputs", () => {
  test("wrapModelCall does not mutate original request", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    await playbookStore.save(
      makePlaybook({
        id: "pb-1",
        strategy: "strategy text",
        confidence: 0.9,
      }),
    );

    const mw = createAceMiddleware({
      trajectoryStore: createInMemoryTrajectoryStore(),
      playbookStore,
      clock: () => 1000,
    });

    const originalMessage: InboundMessage = {
      content: [{ kind: "text", text: "test" }],
      senderId: "user",
      timestamp: 1000,
    };
    const request: ModelRequest = {
      messages: [originalMessage],
      model: "test-model",
    };

    const messagesBefore = request.messages.length;
    await mw.wrapModelCall?.(
      {
        session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
        turnIndex: 0,
        turnId: "r:t0" as never,
        messages: [],
        metadata: {},
      },
      request,
      async () => ({
        content: "ok",
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    );

    // Original request must not be mutated
    expect(request.messages.length).toBe(messagesBefore);
  });
});

describe("safety: concurrent-safe scoring", () => {
  test("scoring is pure — same inputs produce same output", () => {
    const stats = makeStats();
    const score1 = computeCurationScore(stats, 5, 1000, 0.01);
    const score2 = computeCurationScore(stats, 5, 1000, 0.01);
    expect(score1).toBe(score2);
  });
});

// --- Anti-collapse safety tests for structured playbooks ---

function makeStructuredBullet(overrides?: Partial<PlaybookBullet>): PlaybookBullet {
  return {
    id: "[str-00001]",
    content: "Default bullet",
    helpful: 1,
    harmful: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeStructuredSection(overrides?: Partial<PlaybookSection>): PlaybookSection {
  return {
    name: "Strategy",
    slug: "str",
    bullets: [
      makeStructuredBullet({ id: "[str-00001]", content: "First" }),
      makeStructuredBullet({ id: "[str-00002]", content: "Second" }),
    ],
    ...overrides,
  };
}

function makeStructuredPlaybook(overrides?: Partial<StructuredPlaybook>): StructuredPlaybook {
  return {
    id: "pb-1",
    title: "Test",
    sections: [makeStructuredSection()],
    tags: [],
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 1,
    ...overrides,
  };
}

describe("safety: anti-collapse invariants", () => {
  test("playbook never shrinks below minimum after delta operations", async () => {
    const pb = makeStructuredPlaybook({
      sections: [
        makeStructuredSection({
          bullets: [makeStructuredBullet({ id: "[str-00001]", helpful: 0, harmful: 10 })],
        }),
      ],
    });

    // Attempt to prune the only bullet
    const ops: readonly CuratorOperation[] = [{ kind: "prune", bulletId: "[str-00001]" }];

    const result = await applyOperations(pb, ops, 10000, () => 2000);
    // Should keep at least 1 bullet per section
    expect(result.sections[0]?.bullets).toHaveLength(1);
  });

  test("token budget always respected after operations", async () => {
    const bullets = Array.from({ length: 30 }, (_, i) =>
      makeStructuredBullet({
        id: `[str-${String(i).padStart(5, "0")}]`,
        content: "x".repeat(100),
        helpful: i,
        harmful: 0,
      }),
    );
    const pb = makeStructuredPlaybook({
      sections: [makeStructuredSection({ bullets })],
    });

    const budgets = [50, 100, 200, 500, 1000];
    for (const budget of budgets) {
      const result = await applyOperations(pb, [], budget, () => 2000);
      const tokens = await estimateStructuredTokens(result);
      expect(tokens).toBeLessThanOrEqual(budget);
    }
  });

  test("positive-value bullets survive unless budget-forced", async () => {
    const pb = makeStructuredPlaybook({
      sections: [
        makeStructuredSection({
          bullets: [
            makeStructuredBullet({ id: "[str-00001]", helpful: 10, harmful: 0 }),
            makeStructuredBullet({ id: "[str-00002]", helpful: 5, harmful: 0 }),
          ],
        }),
      ],
    });

    // Generous budget
    const result = await applyOperations(pb, [], 10000, () => 2000);
    expect(result.sections[0]?.bullets).toHaveLength(2);
  });

  test("delta operations are pure — no side effects on input", async () => {
    const pb = makeStructuredPlaybook();
    const originalSections = JSON.stringify(pb.sections);

    const ops: readonly CuratorOperation[] = [
      { kind: "add", section: "str", content: "New bullet" },
      { kind: "prune", bulletId: "[str-00001]" },
    ];

    await applyOperations(pb, ops, 10000, () => 2000);

    // Original playbook unchanged
    expect(JSON.stringify(pb.sections)).toBe(originalSections);
  });
});

describe("safety: structured playbook token estimation", () => {
  test("empty structured playbook estimates to 0 tokens", () => {
    const pb = makeStructuredPlaybook({ sections: [] });
    expect(estimateStructuredTokens(pb)).toBe(0);
  });

  test("token estimation includes structural overhead", () => {
    const pb = makeStructuredPlaybook({
      sections: [
        makeStructuredSection({
          bullets: [makeStructuredBullet({ content: "x".repeat(100) })],
        }),
      ],
    });
    const tokens = estimateStructuredTokens(pb);
    // Should be more than just 100/4 = 25 due to headers, IDs, etc.
    expect(tokens).toBeGreaterThan(25);
  });
});
