/**
 * ReputationBackend interface — comprehensive E2E validation.
 *
 * Validates the full L0 contract through two paths:
 *   1. createKoi + createLoopAdapter (ReAct loop, real Anthropic LLM calls)
 *   2. createKoi + createPiAdapter   (Pi streaming, real Anthropic LLM calls)
 *
 * The test builds an in-memory ReputationBackend implementation inline and
 * exercises every method and shape defined in packages/kernel/core/src/reputation-backend.ts:
 *   - record()          — feedback input → stored
 *   - getScore()        — fail-closed: undefined for unknown agents
 *   - getScores()       — batch scoring for N+1-safe routing
 *   - query()           — filter by targetId, sourceId, kinds, after/before, limit
 *   - REPUTATION_LEVEL_ORDER — safe level comparisons for routing decisions
 *   - DEFAULT_REPUTATION_QUERY_LIMIT — default pagination
 *   - dispose()         — cleanup clears state
 *
 * Contract tests (no LLM): run always.
 * E2E tests (real LLM): gated on ANTHROPIC_API_KEY.
 *
 * Run from the repo root:
 *   bun test --env-file .env tests/e2e/reputation-backend-e2e.test.ts
 *
 * Or from the worktree root:
 *   ANTHROPIC_API_KEY=sk-... bun test tests/e2e/reputation-backend-e2e.test.ts
 *
 * Cost: ~$0.02–0.06 per full run (haiku model, minimal prompts).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type {
  AgentId,
  ComponentProvider,
  EngineEvent,
  FeedbackKind,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ReputationBackend,
  ReputationFeedback,
  ReputationLevel,
  ReputationQuery,
  ReputationScore,
  Tool,
  TurnContext,
} from "@koi/core";
import { agentId, DEFAULT_REPUTATION_QUERY_LIMIT, REPUTATION_LEVEL_ORDER } from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";

// ---------------------------------------------------------------------------
// .env bootstrap — worktrees don't inherit .env from the repo root.
// Tries the worktree root then the koi repo root as fallbacks.
// ---------------------------------------------------------------------------

function tryLoadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key) process.env[key] ??= val;
    }
  }
}

// worktree root: tests/e2e/ → ../../
tryLoadEnvFile(new URL("../../.env", import.meta.url).pathname);
// koi repo root: tests/e2e/ → ../../../../../ (inside .claude/worktrees/<name>/)
tryLoadEnvFile(new URL("../../../../../.env", import.meta.url).pathname);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const MODEL_NAME = "claude-haiku-4-5-20251001";
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// collectEvents — drains AsyncIterable<EngineEvent> into a readonly array
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

// ---------------------------------------------------------------------------
// In-memory ReputationBackend implementation
//
// Implements every method defined in the L0 contract.
// Score formula: positives / (positives + negatives) — neutrals count toward
// feedbackCount but not toward the ratio.
// Level thresholds: <0.2 untrusted · <0.4 low · <0.6 medium · ≥0.6 high.
// "verified" requires external attestation — not emitted by this backend.
// ---------------------------------------------------------------------------

function levelFromScore(score: number): ReputationLevel {
  if (score < 0.2) return "untrusted";
  if (score < 0.4) return "low";
  if (score < 0.6) return "medium";
  return "high";
}

function createInMemoryReputationBackend(): ReputationBackend & {
  readonly feedbackCount: () => number;
} {
  // let justified: accumulated over multiple record() calls; reset by dispose()
  let store: readonly ReputationFeedback[] = [];

  const computeScore = (targetId: AgentId): ReputationScore | undefined => {
    const entries = store.filter((f) => f.targetId === targetId);
    if (entries.length === 0) return undefined;

    const positives = entries.filter((f) => f.kind === "positive").length;
    const negatives = entries.filter((f) => f.kind === "negative").length;
    const scored = positives + negatives;
    const score = scored === 0 ? 0.5 : positives / scored;

    return {
      agentId: targetId,
      score,
      level: levelFromScore(score),
      feedbackCount: entries.length,
      computedAt: Date.now(),
    };
  };

  return {
    record: (f) => {
      store = [...store, f];
      return { ok: true as const, value: undefined };
    },

    getScore: (targetId) => ({ ok: true as const, value: computeScore(targetId) }),

    getScores: (targetIds) => {
      const map = new Map<AgentId, ReputationScore | undefined>();
      for (const id of targetIds) map.set(id, computeScore(id));
      return {
        ok: true as const,
        value: map as ReadonlyMap<AgentId, ReputationScore | undefined>,
      };
    },

    query: (filter: ReputationQuery) => {
      // let justified: progressively narrowed by each optional filter predicate
      let entries = [...store];
      if (filter.targetId !== undefined) {
        const t = filter.targetId;
        entries = entries.filter((f) => f.targetId === t);
      }
      if (filter.sourceId !== undefined) {
        const s = filter.sourceId;
        entries = entries.filter((f) => f.sourceId === s);
      }
      if (filter.kinds !== undefined) {
        const kinds: readonly FeedbackKind[] = filter.kinds;
        entries = entries.filter((f) => kinds.includes(f.kind));
      }
      if (filter.after !== undefined) {
        const after = filter.after;
        entries = entries.filter((f) => f.timestamp >= after);
      }
      if (filter.before !== undefined) {
        const before = filter.before;
        entries = entries.filter((f) => f.timestamp < before);
      }
      entries.sort((a, b) => b.timestamp - a.timestamp); // descending by timestamp
      const limit = filter.limit ?? DEFAULT_REPUTATION_QUERY_LIMIT;
      const hasMore = entries.length > limit;
      return { ok: true as const, value: { entries: entries.slice(0, limit), hasMore } };
    },

    dispose: async () => {
      store = [];
    },

    feedbackCount: () => store.length,
  };
}

// ---------------------------------------------------------------------------
// Test helpers — weather tool + two-phase model call
// ---------------------------------------------------------------------------

function createWeatherTool(onExecute?: () => void): {
  readonly tool: Tool;
  readonly provider: ComponentProvider;
} {
  const tool: Tool = {
    descriptor: {
      name: "get_weather",
      description: "Get weather for a city.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
    trustTier: "sandbox",
    execute: async () => {
      onExecute?.();
      return { temperature: "22C", condition: "sunny" };
    },
  };

  const provider: ComponentProvider = {
    name: "e2e-reputation-tool-provider",
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken("get_weather"), tool);
      return components;
    },
  };

  return { tool, provider };
}

function createTwoPhaseModelCall(opts: {
  readonly toolCallPhases: number;
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
}): {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly getCallCount: () => number;
} {
  // let justified: tracks which phase the model handler is in across multiple calls
  let callCount = 0;

  const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
    callCount++;
    if (callCount <= opts.toolCallPhases) {
      return {
        content: `Calling ${opts.toolName} (phase ${callCount}).`,
        model: MODEL_NAME,
        usage: { inputTokens: 10, outputTokens: 15 },
        metadata: {
          toolCalls: [
            {
              toolName: opts.toolName,
              callId: `call-e2e-${callCount}`,
              input: opts.toolInput,
            },
          ],
        },
      };
    }
    const { createAnthropicAdapter } = await import("@koi/model-router");
    const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
    return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 100 });
  };

  return { modelCall, getCallCount: () => callCount };
}

// ===========================================================================
// 1. Pure contract tests — no LLM required
// ===========================================================================

describe("ReputationBackend contract (no LLM required)", () => {
  // -------------------------------------------------------------------------
  // 1a. Fail-closed: getScore returns undefined for unknown agents
  // -------------------------------------------------------------------------

  test("getScore returns undefined for unknown agent — fail-closed contract", async () => {
    const backend = createInMemoryReputationBackend();

    const result = await backend.getScore(agentId("completely-unknown-agent"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Callers MUST treat undefined as "unknown" level — never implicit trust
      expect(result.value).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // 1b. record() + getScore() reflects feedback correctly
  // -------------------------------------------------------------------------

  test("record positive feedback → score=1.0, level=high", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");

    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "positive",
      timestamp: 1_000_000,
    });

    const result = await backend.getScore(target);
    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.agentId).toBe(target);
      expect(result.value.score).toBe(1.0);
      expect(result.value.feedbackCount).toBe(1);
      expect(result.value.level).toBe("high");
    }
  });

  test("record negative feedback → score=0, level=untrusted", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");

    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "negative",
      timestamp: 1_000_000,
    });

    const result = await backend.getScore(target);
    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.score).toBe(0);
      expect(result.value.level).toBe("untrusted");
    }
  });

  test("mixed feedback: level upgrades with more positives, level order is respected", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");
    const now = 1_000_000;

    // 1 negative → untrusted
    await backend.record({ sourceId: source, targetId: target, kind: "negative", timestamp: now });
    const afterNeg = await backend.getScore(target);
    if (afterNeg.ok && afterNeg.value) {
      const untrustedIdx = REPUTATION_LEVEL_ORDER.indexOf("untrusted");
      const mediumIdx = REPUTATION_LEVEL_ORDER.indexOf("medium");
      expect(REPUTATION_LEVEL_ORDER.indexOf(afterNeg.value.level)).toBeLessThan(mediumIdx);
      expect(untrustedIdx).toBeLessThan(mediumIdx);
    }

    // +3 positives → 3/4 = 0.75 → high
    for (let i = 1; i <= 3; i++) {
      await backend.record({
        sourceId: source,
        targetId: target,
        kind: "positive",
        timestamp: now + i,
      });
    }
    const afterPos = await backend.getScore(target);
    if (afterPos.ok && afterPos.value) {
      const idx = REPUTATION_LEVEL_ORDER.indexOf(afterPos.value.level);
      expect(idx).toBeGreaterThanOrEqual(REPUTATION_LEVEL_ORDER.indexOf("medium"));
      // Not "verified" — no external attestation in this backend
      expect(afterPos.value.level).not.toBe("verified");
    }
  });

  test("neutral feedback contributes to feedbackCount but not to score ratio", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");

    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "positive",
      timestamp: 1_000_000,
    });
    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "neutral",
      timestamp: 1_000_001,
    });
    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "neutral",
      timestamp: 1_000_002,
    });

    const result = await backend.getScore(target);
    if (result.ok && result.value) {
      // feedbackCount includes neutrals
      expect(result.value.feedbackCount).toBe(3);
      // score ratio: 1 positive / (1 positive + 0 negative) = 1.0
      expect(result.value.score).toBe(1.0);
    }
  });

  // -------------------------------------------------------------------------
  // 1c. getScores() batch — undefined for unknown, score for known
  // -------------------------------------------------------------------------

  test("getScores batch returns score for known agent, undefined for unknown", async () => {
    const backend = createInMemoryReputationBackend();
    const known = agentId("agent-known");
    const unknown = agentId("agent-unknown");
    const source = agentId("agent-source");

    await backend.record({
      sourceId: source,
      targetId: known,
      kind: "positive",
      timestamp: Date.now(),
    });

    const getScoresFn = backend.getScores;
    expect(getScoresFn).toBeDefined();
    if (!getScoresFn) return; // TypeScript narrowing — never reached due to expect above
    const result = await getScoresFn([known, unknown]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.get(known)).toBeDefined();
      expect(result.value.get(known)?.feedbackCount).toBe(1);
      // Fail-closed: unknown agent → undefined (never implicitly trusted)
      expect(result.value.get(unknown)).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // 1d. query() filter coverage
  // -------------------------------------------------------------------------

  test("query filters by targetId", async () => {
    const backend = createInMemoryReputationBackend();
    const t1 = agentId("agent-1");
    const t2 = agentId("agent-2");
    const source = agentId("agent-source");
    const now = Date.now();

    await backend.record({ sourceId: source, targetId: t1, kind: "positive", timestamp: now });
    await backend.record({ sourceId: source, targetId: t2, kind: "negative", timestamp: now + 1 });

    const result = await backend.query({ targetId: t1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries).toHaveLength(1);
      expect(result.value.entries[0]?.targetId).toBe(t1);
      expect(result.value.hasMore).toBe(false);
    }
  });

  test("query filters by sourceId", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const s1 = agentId("source-1");
    const s2 = agentId("source-2");
    const now = Date.now();

    await backend.record({ sourceId: s1, targetId: target, kind: "positive", timestamp: now });
    await backend.record({ sourceId: s2, targetId: target, kind: "positive", timestamp: now + 1 });

    const result = await backend.query({ sourceId: s1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries).toHaveLength(1);
      expect(result.value.entries[0]?.sourceId).toBe(s1);
    }
  });

  test("query filters by kinds — only matching kinds returned", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");
    const now = Date.now();

    await backend.record({ sourceId: source, targetId: target, kind: "positive", timestamp: now });
    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "negative",
      timestamp: now + 1,
    });
    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "neutral",
      timestamp: now + 2,
    });

    const result = await backend.query({ targetId: target, kinds: ["positive", "neutral"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries).toHaveLength(2);
      for (const entry of result.value.entries) {
        expect(["positive", "neutral"]).toContain(entry.kind);
      }
    }
  });

  test("query filters by after/before timestamps", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");
    const base = 1_000_000;

    await backend.record({ sourceId: source, targetId: target, kind: "positive", timestamp: base });
    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "negative",
      timestamp: base + 1_000,
    });
    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "neutral",
      timestamp: base + 2_000,
    });

    // Only the second entry falls in [base+500, base+1500)
    const result = await backend.query({ after: base + 500, before: base + 1_500 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries).toHaveLength(1);
      expect(result.value.entries[0]?.kind).toBe("negative");
    }
  });

  test("query respects DEFAULT_REPUTATION_QUERY_LIMIT and sets hasMore", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");
    const now = Date.now();

    // Record one more than the default limit
    for (let i = 0; i <= DEFAULT_REPUTATION_QUERY_LIMIT; i++) {
      await backend.record({
        sourceId: source,
        targetId: target,
        kind: "positive",
        timestamp: now + i,
      });
    }

    const result = await backend.query({ targetId: target });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries).toHaveLength(DEFAULT_REPUTATION_QUERY_LIMIT);
      expect(result.value.hasMore).toBe(true);
    }
  });

  test("query respects explicit limit override", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      await backend.record({
        sourceId: source,
        targetId: target,
        kind: "positive",
        timestamp: now + i,
      });
    }

    const result = await backend.query({ targetId: target, limit: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.entries).toHaveLength(3);
      expect(result.value.hasMore).toBe(true);
    }
  });

  test("query returns entries in descending timestamp order", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");
    const base = 1_000_000;

    // Insert in ascending order
    for (let i = 0; i < 5; i++) {
      await backend.record({
        sourceId: source,
        targetId: target,
        kind: "positive",
        timestamp: base + i,
      });
    }

    const result = await backend.query({ targetId: target });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const timestamps = result.value.entries.map((e) => e.timestamp);
      for (let i = 1; i < timestamps.length; i++) {
        // Each timestamp should be ≤ the previous (descending)
        const prev = timestamps[i - 1];
        if (prev === undefined) continue; // always defined; satisfies noUncheckedIndexedAccess
        expect(timestamps[i]).toBeLessThanOrEqual(prev);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 1e. REPUTATION_LEVEL_ORDER — routing guard pattern
  // -------------------------------------------------------------------------

  test("REPUTATION_LEVEL_ORDER enables safe level comparison for routing guards", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");
    const now = Date.now();

    // 5 positives → score=1.0 → level=high
    for (let i = 0; i < 5; i++) {
      await backend.record({
        sourceId: source,
        targetId: target,
        kind: "positive",
        timestamp: now + i,
      });
    }

    const result = await backend.getScore(target);
    if (result.ok && result.value) {
      const idx = REPUTATION_LEVEL_ORDER.indexOf(result.value.level);
      // "high" (4) ≥ "medium" (3): agent passes the routing minimum
      expect(idx).toBeGreaterThanOrEqual(REPUTATION_LEVEL_ORDER.indexOf("medium"));
      // Not externally verified
      expect(idx).toBeLessThan(REPUTATION_LEVEL_ORDER.indexOf("verified"));
    }
  });

  // -------------------------------------------------------------------------
  // 1f. DEFAULT_REPUTATION_QUERY_LIMIT
  // -------------------------------------------------------------------------

  test("DEFAULT_REPUTATION_QUERY_LIMIT is a positive integer", () => {
    expect(DEFAULT_REPUTATION_QUERY_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_REPUTATION_QUERY_LIMIT)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 1g. dispose() clears state
  // -------------------------------------------------------------------------

  test("dispose() clears all stored feedback — fail-closed after dispose", async () => {
    const backend = createInMemoryReputationBackend();
    const target = agentId("agent-target");
    const source = agentId("agent-source");

    await backend.record({
      sourceId: source,
      targetId: target,
      kind: "positive",
      timestamp: Date.now(),
    });
    expect(backend.feedbackCount()).toBe(1);

    await backend.dispose?.();

    // After dispose — no feedback → fail-closed (undefined)
    const result = await backend.getScore(target);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
    expect(backend.feedbackCount()).toBe(0);
  });
});

// ===========================================================================
// 2. E2E: createKoi + createLoopAdapter (real Anthropic LLM)
// ===========================================================================

describeE2E("e2e: ReputationBackend through createKoi + createLoopAdapter", () => {
  test(
    "records feedback after a real agent run and reflects in score",
    async () => {
      const backend = createInMemoryReputationBackend();

      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        const { createAnthropicAdapter } = await import("@koi/model-router");
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 30 });
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-reputation-loop-basic",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Say exactly: hello" }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
        if (done?.kind === "done") expect(done.output.stopReason).toBe("completed");

        // Record feedback for the agent that just ran
        const target = runtime.agent.pid.id; // AgentId from ECS ProcessId
        const observer = agentId("e2e-observer");
        const rec = await backend.record({
          sourceId: observer,
          targetId: target,
          kind: "positive",
          context: { task: "greeting", session: "e2e-run-1" },
          timestamp: Date.now(),
        });
        expect(rec.ok).toBe(true);

        // Score reflects the single positive feedback
        const score = await backend.getScore(target);
        expect(score.ok).toBe(true);
        if (score.ok && score.value) {
          expect(score.value.agentId).toBe(target);
          expect(score.value.feedbackCount).toBe(1);
          expect(score.value.score).toBe(1.0);
          // level ≥ medium (score=1.0 → "high")
          expect(REPUTATION_LEVEL_ORDER.indexOf(score.value.level)).toBeGreaterThanOrEqual(
            REPUTATION_LEVEL_ORDER.indexOf("medium"),
          );
        }
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "middleware records feedback in onAfterTurn via SessionContext.agentId",
    async () => {
      const backend = createInMemoryReputationBackend();
      const observer = agentId("e2e-turn-observer");
      // let justified: captured from onAfterTurn to cross-reference with runtime.agent.pid.id
      let capturedAgentId: string | undefined;

      const reputationMiddleware: KoiMiddleware = {
        name: "e2e-reputation-recorder",
        onAfterTurn: async (ctx: TurnContext) => {
          capturedAgentId = ctx.session.agentId;
          await backend.record({
            sourceId: observer,
            targetId: agentId(ctx.session.agentId),
            kind: "positive",
            context: { turnIndex: ctx.turnIndex },
            timestamp: Date.now(),
          });
        },
      };

      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        const { createAnthropicAdapter } = await import("@koi/model-router");
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 30 });
      };

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: { name: "e2e-reputation-mw", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [reputationMiddleware],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hi" }));

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();

        // Middleware fired and captured the agent ID from session context
        expect(capturedAgentId).toBeDefined();
        expect(capturedAgentId).toBe(runtime.agent.pid.id);

        // Feedback was recorded from within the middleware chain (at least 1 turn)
        expect(backend.feedbackCount()).toBeGreaterThan(0);

        // Score is valid and reflects all-positive feedback
        const score = await backend.getScore(runtime.agent.pid.id);
        expect(score.ok).toBe(true);
        if (score.ok && score.value) {
          expect(score.value.feedbackCount).toBeGreaterThan(0);
          expect(score.value.score).toBe(1.0); // all feedback was positive
          // Routing guard: level is at least "high"
          expect(REPUTATION_LEVEL_ORDER.indexOf(score.value.level)).toBeGreaterThanOrEqual(
            REPUTATION_LEVEL_ORDER.indexOf("medium"),
          );
        }

        // Query confirms context was stored (turnIndex in context)
        const queryResult = await backend.query({ sourceId: observer });
        if (queryResult.ok) {
          for (const entry of queryResult.value.entries) {
            expect(entry.context).toBeDefined();
          }
        }
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "tool-augmented run: feedback + batch getScores for routing simulation",
    async () => {
      const backend = createInMemoryReputationBackend();
      const observer = agentId("e2e-routing-observer");
      // let justified: tracks actual tool executions
      let toolExecutions = 0;
      const { provider } = createWeatherTool(() => {
        toolExecutions++;
      });
      const { modelCall, getCallCount } = createTwoPhaseModelCall({
        toolCallPhases: 1,
        toolName: "get_weather",
        toolInput: { city: "Seoul" },
      });

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-reputation-tool", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        providers: [provider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What is the weather in Seoul?" }),
        );

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
        if (done?.kind === "done") expect(done.output.stopReason).toBe("completed");

        // Tool call events were emitted through L1
        expect(events.filter((e) => e.kind === "tool_call_start").length).toBeGreaterThan(0);
        expect(toolExecutions).toBe(1);
        expect(getCallCount()).toBe(2); // phase 1 (tool call) + phase 2 (real LLM)

        // Record varied feedback: positive for weather answer, neutral for tool use
        const target = runtime.agent.pid.id;
        const ts = Date.now();
        await backend.record({
          sourceId: observer,
          targetId: target,
          kind: "positive",
          timestamp: ts,
        });
        await backend.record({
          sourceId: observer,
          targetId: target,
          kind: "neutral",
          timestamp: ts + 1,
        });
        await backend.record({
          sourceId: observer,
          targetId: target,
          kind: "positive",
          timestamp: ts + 2,
        });

        // batch getScores: agent has score; unknown agent does not
        const unknownId = agentId("unknown-routing-candidate");
        const getScoresBatch = backend.getScores;
        expect(getScoresBatch).toBeDefined();
        if (!getScoresBatch) return; // TypeScript narrowing — never reached due to expect above
        const batchResult = await getScoresBatch([target, unknownId]);
        expect(batchResult.ok).toBe(true);
        if (batchResult.ok) {
          const known = batchResult.value.get(target);
          expect(known).toBeDefined();
          expect(known?.feedbackCount).toBe(3);
          // score: 2 positive / (2 positive + 0 negative) = 1.0
          expect(known?.score).toBe(1.0);

          // Fail-closed: unknown candidate → not in map or explicitly undefined
          expect(batchResult.value.get(unknownId)).toBeUndefined();
        }

        // Query only positive feedback
        const posQuery = await backend.query({ targetId: target, kinds: ["positive"] });
        if (posQuery.ok) {
          expect(posQuery.value.entries).toHaveLength(2);
          expect(posQuery.value.hasMore).toBe(false);
        }
      } finally {
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// 3. E2E: createKoi + createPiAdapter (Pi streaming path)
// ===========================================================================

describeE2E("e2e: ReputationBackend through createKoi + createPiAdapter", () => {
  test(
    "records feedback after a Pi agent run — same contract, different adapter",
    async () => {
      const backend = createInMemoryReputationBackend();

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "You are a concise test agent. Reply in 5 words or fewer.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-reputation-pi-basic",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();
        if (done?.kind === "done") expect(done.output.stopReason).toBe("completed");

        // Record feedback for the Pi agent
        const target = runtime.agent.pid.id;
        const observer = agentId("e2e-pi-observer");
        const rec = await backend.record({
          sourceId: observer,
          targetId: target,
          kind: "positive",
          context: { adapter: "pi", task: "greeting" },
          timestamp: Date.now(),
        });
        expect(rec.ok).toBe(true);

        // Verify score — same contract as loop adapter
        const score = await backend.getScore(target);
        expect(score.ok).toBe(true);
        if (score.ok && score.value) {
          expect(score.value.agentId).toBe(target);
          expect(score.value.feedbackCount).toBe(1);
          expect(score.value.score).toBe(1.0);
          expect(score.value.level).toBe("high");
        }
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  test(
    "reputation middleware composes with Pi: wrapModelStream + onAfterTurn both fire",
    async () => {
      const backend = createInMemoryReputationBackend();
      const observer = agentId("e2e-pi-mw-observer");
      // let justified: toggled in wrapModelStream to verify Pi routes through it
      let streamIntercepted = false;

      const reputationMiddleware: KoiMiddleware = {
        name: "e2e-pi-reputation-recorder",
        // Pi uses wrapModelStream (not wrapModelCall) — verify both hooks fire
        wrapModelStream: (_ctx, request, next: ModelStreamHandler) => {
          streamIntercepted = true;
          return next(request);
        },
        onAfterTurn: async (ctx: TurnContext) => {
          await backend.record({
            sourceId: observer,
            targetId: agentId(ctx.session.agentId),
            kind: "positive",
            context: { adapter: "pi", turnIndex: ctx.turnIndex },
            timestamp: Date.now(),
          });
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-reputation-pi-mw", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [reputationMiddleware],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Hi" }));

        const done = events.find((e) => e.kind === "done");
        expect(done).toBeDefined();

        // Pi routes all model calls through wrapModelStream
        expect(streamIntercepted).toBe(true);

        // onAfterTurn fired and recorded feedback
        expect(backend.feedbackCount()).toBeGreaterThan(0);

        // Score for the Pi agent is valid
        const score = await backend.getScore(runtime.agent.pid.id);
        expect(score.ok).toBe(true);
        if (score.ok && score.value) {
          expect(score.value.score).toBe(1.0);
          expect(REPUTATION_LEVEL_ORDER.indexOf(score.value.level)).toBeGreaterThanOrEqual(
            REPUTATION_LEVEL_ORDER.indexOf("medium"),
          );
        }

        // Context field stored correctly
        const queryResult = await backend.query({
          targetId: runtime.agent.pid.id,
          sourceId: observer,
        });
        if (queryResult.ok) {
          expect(queryResult.value.entries.length).toBeGreaterThan(0);
          for (const entry of queryResult.value.entries) {
            expect(entry.context?.adapter).toBe("pi");
          }
        }
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
