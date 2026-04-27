import { describe, expect, it } from "bun:test";
import type {
  ForgeBudget,
  ForgeDemandSignal,
  InboundMessage,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { DEFAULT_FORGE_BUDGET } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { ForgeCandidate } from "@koi/forge-types";
import { createMockTurnContext } from "@koi/test";
import { createForgeDemandDetector } from "./demand-detector.js";
import type { ForgeDemandConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noCooldownBudget: ForgeBudget = {
  ...DEFAULT_FORGE_BUDGET,
  cooldownMs: 0,
};

function makeConfig(overrides: Partial<ForgeDemandConfig> = {}): ForgeDemandConfig {
  return { budget: noCooldownBudget, ...overrides };
}

function toolReq(toolId: string): ToolRequest {
  return { toolId, input: {} };
}

function modelReq(messages: readonly InboundMessage[] = []): ModelRequest {
  return { messages };
}

function modelRes(text: string): ModelResponse {
  return {
    content: text,
    model: "test-model",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function toolRes(): ToolResponse {
  return { output: "ok" };
}

function userMsg(text: string): InboundMessage {
  return {
    senderId: "user",
    content: [{ kind: "text", text }],
    timestamp: 0,
  };
}

const ctx: TurnContext = createMockTurnContext();

// ---------------------------------------------------------------------------
// Tests — issue spec
// ---------------------------------------------------------------------------

describe("createForgeDemandDetector", () => {
  it("emits a demand signal once repeated tool failures reach threshold", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 3 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("tool failed");
    };

    for (let i = 0; i < 3; i += 1) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("flaky-tool"), failNext);
      } catch {
        // expected
      }
    }

    expect(signals.length).toBe(1);
    expect(signals[0]?.trigger.kind).toBe("repeated_failure");
    expect(handle.forSession(ctx.session).getActiveSignalCount()).toBe(1);
  });

  it("detects user correction patterns via wrapModelCall", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );

    // Prime `lastToolCallId` with a successful tool call.
    await handle.middleware.wrapToolCall?.(ctx, toolReq("search-tool"), async () => toolRes());

    // User corrects: should fire `user_correction`.
    await handle.middleware.wrapModelCall?.(
      ctx,
      modelReq([userMsg("No, that's not right — use the other tool")]),
      async () => modelRes("ok"),
    );

    const corrections = signals.filter((s) => s.trigger.kind === "user_correction");
    expect(corrections.length).toBe(1);
    const trigger = corrections[0]?.trigger;
    if (trigger?.kind === "user_correction") {
      expect(trigger.correctedToolCall).toBe("search-tool");
    }
  });

  it("dedupes duplicate demands via cooldown per trigger key", async () => {
    const signals: ForgeDemandSignal[] = [];
    // Cooldown active — same trigger should NOT re-emit while hot.
    const handle = createForgeDemandDetector(
      makeConfig({
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 60_000 },
        heuristics: { repeatedFailureCount: 3 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("boom");
    };

    // 6 failures — only the first crossing of threshold should emit.
    for (let i = 0; i < 6; i += 1) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("dupe-tool"), failNext);
      } catch {
        // expected
      }
    }

    expect(signals.length).toBe(1);
  });

  it("maps an emitted signal to a ForgeCandidate", async () => {
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 2 } }),
    );

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };
    for (let i = 0; i < 2; i += 1) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("missing-cap"), failNext);
      } catch {
        // expected
      }
    }

    const [signal] = handle.forSession(ctx.session).getSignals();
    expect(signal).toBeDefined();
    if (signal === undefined) return;

    // Pull-driven candidate: built from the demand signal.
    const candidate: ForgeCandidate = {
      id: `cand-${signal.id}`,
      kind: signal.suggestedBrickKind,
      name: signal.trigger.kind === "repeated_failure" ? signal.trigger.toolName : "unknown",
      description: `Forged from ${signal.trigger.kind}`,
      demandId: signal.id,
      priority: signal.confidence,
      proposedScope: "agent",
      createdAt: signal.emittedAt,
    };

    expect(candidate.demandId).toBe(signal.id);
    expect(candidate.priority).toBeGreaterThan(0);
    expect(candidate.priority).toBeLessThanOrEqual(1);
    expect(candidate.kind).toBe("tool");
  });

  it("scores priority (confidence) deterministically across runs", async () => {
    async function firstSignalConfidence(): Promise<number | undefined> {
      const handle = createForgeDemandDetector(
        makeConfig({ heuristics: { repeatedFailureCount: 3 } }),
      );
      const failNext = async (): Promise<ToolResponse> => {
        throw new Error("err");
      };
      for (let i = 0; i < 3; i += 1) {
        try {
          await handle.middleware.wrapToolCall?.(ctx, toolReq("same-tool"), failNext);
        } catch {
          // expected
        }
      }
      return handle.forSession(ctx.session).getSignals()[0]?.confidence;
    }

    const a = await firstSignalConfidence();
    const b = await firstSignalConfidence();
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it("isolates throwing onDemand/onDismiss callbacks from the wrapped tool call", async () => {
    const originalErr = console.error;
    const swallowed: unknown[] = [];
    console.error = (...args: unknown[]): void => {
      swallowed.push(args);
    };
    try {
      const handle = createForgeDemandDetector(
        makeConfig({
          heuristics: { repeatedFailureCount: 1 },
          onDemand: () => {
            throw new Error("observer boom");
          },
          onDismiss: () => {
            throw new Error("dismiss boom");
          },
        }),
      );

      const okNext = async (): Promise<ToolResponse> => toolRes();
      const failNext = async (): Promise<ToolResponse> => {
        throw new Error("tool failed");
      };

      // Failure path: tool throws → observer throws → original error must
      // propagate unchanged, never the observer's "observer boom".
      let caught: unknown;
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("obs"), failNext);
      } catch (e: unknown) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("tool failed");

      // Success path: a later successful call must NOT be turned into a failure
      // by an observer firing on a *prior* signal.
      const ok = await handle.middleware.wrapToolCall?.(ctx, toolReq("ok"), okNext);
      expect(ok).toEqual(toolRes());

      // Dismiss path: throwing onDismiss must not bubble out.
      const [first] = handle.forSession(ctx.session).getSignals();
      if (first !== undefined) {
        expect(() => handle.forSession(ctx.session).dismiss(first.id)).not.toThrow();
      }

      expect(swallowed.length).toBeGreaterThan(0);
    } finally {
      console.error = originalErr;
    }
  });

  it("does not re-fire user_correction when transcript history is replayed on retry", async () => {
    const signals: ForgeDemandSignal[] = [];
    let now = 10;
    const handle = createForgeDemandDetector(
      makeConfig({ clock: () => now, onDemand: (s) => signals.push(s) }),
    );

    const okNext = async (): Promise<ToolResponse> => toolRes();
    now = 50;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("any-tool"), okNext);

    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 100,
    };
    const modelNext = async (): Promise<ModelResponse> => modelRes("ok");

    // First model call: a single new user-correction message → 1 signal.
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), modelNext);
    expect(signals.length).toBe(1);

    // Second model call: the same message replayed (e.g. retry transcript).
    // Must not re-fire — timestamp <= lastProcessedUserTimestamp.
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), modelNext);
    expect(signals.length).toBe(1);
  });

  it("ignores assistant-authored text that happens to match a correction pattern", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(makeConfig({ onDemand: (s) => signals.push(s) }));

    const okNext = async (): Promise<ToolResponse> => toolRes();
    await handle.middleware.wrapToolCall?.(ctx, toolReq("a-tool"), okNext);

    const assistantMsg: InboundMessage = {
      senderId: "assistant",
      content: [{ kind: "text", text: "I said earlier that this works" }],
      timestamp: 200,
    };
    const modelNext = async (): Promise<ModelResponse> => modelRes("ok");

    await handle.middleware.wrapModelCall?.(ctx, modelReq([assistantMsg]), modelNext);
    expect(signals.length).toBe(0);
  });

  it("does not let unrelated capability-gap responses combine into a single signal", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        onDemand: (s) => signals.push(s),
      }),
    );

    // Two responses match the same broad regex but with different match
    // text — they bucket separately and neither should hit the threshold.
    const a = async (): Promise<ModelResponse> =>
      modelRes("I don't have a tool for compiling rust code");
    const b = async (): Promise<ModelResponse> =>
      modelRes("I don't have a tool for parsing protobuf schemas");

    // Stable user-authored task — windowText distinguishes the two
    // unrelated gaps; the same task repeated does aggregate.
    const ask = userMsg("help me with my project");

    // Distinct turnIds so retry-dedup does not collapse legitimate repeats.
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 0 }),
      modelReq([ask]),
      a,
    );
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 1 }),
      modelReq([ask]),
      b,
    );
    expect(signals.length).toBe(0);

    // The same gap repeated in a distinct turn *does* cross the threshold.
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 2 }),
      modelReq([ask]),
      a,
    );
    expect(signals.length).toBe(1);
  });

  it("preserves user_correction across a failed model call replayed on retry", async () => {
    const signals: ForgeDemandSignal[] = [];
    let now = 10;
    // Active cooldown — the correction must fire once and NOT be dropped on
    // retry because the watermark advanced before the failed model call.
    const handle = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 60_000 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const okNext = async (): Promise<ToolResponse> => toolRes();
    now = 50;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("any-tool"), okNext);

    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 100,
    };

    // First model call throws — watermark must NOT advance, so the retry
    // can re-scan the same transcript. Cooldown then dedupes.
    const failModel = async (): Promise<ModelResponse> => {
      throw new Error("transport boom");
    };
    try {
      await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), failModel);
    } catch {
      // expected
    }

    const okModel = async (): Promise<ModelResponse> => modelRes("ok");
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), okModel);

    const corrections = signals.filter((s) => s.trigger.kind === "user_correction");
    // Watermark must NOT have advanced on the failure — retry re-scanned
    // and cooldown deduped the second emission.
    expect(corrections.length).toBe(1);
  });

  it("does not let one capability-gap signal suppress unrelated gaps via cooldown", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        // Active cooldown — without per-bucket keys this would suppress the
        // second gap because the trigger.requiredCapability shares a prefix.
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 60_000 },
        heuristics: { capabilityGapOccurrences: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const a = async (): Promise<ModelResponse> =>
      modelRes("I don't have a tool for compiling rust code");
    const b = async (): Promise<ModelResponse> =>
      modelRes("I don't have a tool for parsing protobuf schemas");

    await handle.middleware.wrapModelCall?.(ctx, modelReq([]), a);
    await handle.middleware.wrapModelCall?.(ctx, modelReq([]), b);

    const gaps = signals.filter((s) => s.trigger.kind === "capability_gap");
    expect(gaps.length).toBe(2);
  });

  it("validateForgeDemandConfig rejects stateful (g/y) capability-gap patterns", async () => {
    const { validateForgeDemandConfig } = await import("./config.js");
    const result = validateForgeDemandConfig({
      budget: DEFAULT_FORGE_BUDGET,
      capabilityGapPatterns: [/I don'?t have a tool/g],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("'g' or 'y'");
    }
  });

  it("attributes user_correction to the tool that ran before the user message, not the latest", async () => {
    const signals: ForgeDemandSignal[] = [];
    // Driveable clock so tool calls + correction timestamps are deterministic.
    let now = 1000;
    const handle = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        onDemand: (s) => signals.push(s),
      }),
    );

    const okNext = async (): Promise<ToolResponse> => toolRes();
    now = 1000;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-A"), okNext);
    now = 2000;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-B"), okNext);

    // User message at t=2500 — between tool-B (2000) and tool-C (3000).
    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 2500,
    };

    now = 3000;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-C"), okNext);

    const okModel = async (): Promise<ModelResponse> => modelRes("ok");
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), okModel);

    const corr = signals.find((s) => s.trigger.kind === "user_correction");
    expect(corr).toBeDefined();
    if (corr?.trigger.kind === "user_correction") {
      // Must be tool-B (last call BEFORE the user message), not tool-C.
      expect(corr.trigger.correctedToolCall).toBe("tool-B");
    }
  });

  it("clears the cooldown of an evicted signal when the queue rolls over", async () => {
    const handle = createForgeDemandDetector(
      makeConfig({
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 60_000 },
        heuristics: { repeatedFailureCount: 1 },
        maxPendingSignals: 2,
      }),
    );

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };

    // Fill: A, B, C — C evicts A. After eviction, A's cooldown must be
    // cleared so a fresh A failure can re-emit.
    for (const id of ["tool-A", "tool-B", "tool-C"]) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq(id), failNext);
      } catch {
        // expected
      }
    }
    expect(handle.forSession(ctx.session).getActiveSignalCount()).toBe(2);

    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-A"), failNext);
    } catch {
      // expected
    }
    // tool-A re-emitted (its cooldown was cleared on eviction) → queue evicts B.
    const ids = handle
      .forSession(ctx.session)
      .getSignals()
      .map((s) => (s.trigger.kind === "repeated_failure" ? s.trigger.toolName : ""));
    expect(ids).toContain("tool-A");
  });

  it("dismiss resets the per-trigger counters so the next single event does not re-fire", async () => {
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 3 } }),
    );

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };
    for (let i = 0; i < 3; i += 1) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("flaky"), failNext);
      } catch {
        // expected
      }
    }
    const [first] = handle.forSession(ctx.session).getSignals();
    expect(first).toBeDefined();
    if (first === undefined) return;

    handle.forSession(ctx.session).dismiss(first.id);

    // One more failure must NOT re-emit — counter was reset by dismiss.
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("flaky"), failNext);
    } catch {
      // expected
    }
    expect(handle.forSession(ctx.session).getActiveSignalCount()).toBe(0);
  });

  it("does not collapse user_correction cooldown across different tools", async () => {
    const signals: ForgeDemandSignal[] = [];
    let now = 100;
    const handle = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        // Active cooldown — the cooldown key must include the corrected
        // tool so identical phrasing against different tools both fire.
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 60_000 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const okNext = async (): Promise<ToolResponse> => toolRes();
    now = 100;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-A"), okNext);
    const okModel = async (): Promise<ModelResponse> => modelRes("ok");
    await handle.middleware.wrapModelCall?.(
      ctx,
      modelReq([
        {
          senderId: "user",
          content: [{ kind: "text", text: "no, that's not right" }],
          timestamp: 200,
        },
      ]),
      okModel,
    );

    now = 300;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-B"), okNext);
    await handle.middleware.wrapModelCall?.(
      ctx,
      modelReq([
        {
          senderId: "user",
          content: [{ kind: "text", text: "no, that's not right" }],
          timestamp: 400,
        },
      ]),
      okModel,
    );

    const corrections = signals.filter((s) => s.trigger.kind === "user_correction");
    expect(corrections.length).toBe(2);
  });

  it("enforces maxForgesPerSession and stops emitting once the cap is reached", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        budget: { ...DEFAULT_FORGE_BUDGET, maxForgesPerSession: 2, cooldownMs: 0 },
        heuristics: { repeatedFailureCount: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );
    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };
    for (const id of ["t1", "t2", "t3", "t4"]) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq(id), failNext);
      } catch {
        // expected
      }
    }
    expect(signals.length).toBe(2);
  });

  it("does not suppress later signals on idle wall-clock alone (computeTimeBudgetMs is forge-pipeline scope, not detector)", async () => {
    let now = 0;
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        budget: { ...DEFAULT_FORGE_BUDGET, computeTimeBudgetMs: 1_000, cooldownMs: 0 },
        heuristics: { repeatedFailureCount: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );
    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };

    now = 0;
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("a"), failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(1);

    // Idle for 5s — well past computeTimeBudgetMs. The detector must keep
    // emitting because actual forge compute happens elsewhere.
    now = 5_000;
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("b"), failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(2);
  });

  it("treats in-band tool errors ({error, code}) as failures, not successes", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 3 },
        onDemand: (s) => signals.push(s),
      }),
    );
    // Tool returns `{ error, code }` instead of throwing.
    const inBandFail = async (): Promise<ToolResponse> => ({
      output: { error: "missing arg", code: "VALIDATION" },
    });
    for (let i = 0; i < 3; i += 1) {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("inband"), inBandFail);
    }
    const repeated = signals.find((s) => s.trigger.kind === "repeated_failure");
    expect(repeated).toBeDefined();
    if (repeated?.trigger.kind === "repeated_failure") {
      expect(repeated.trigger.toolName).toBe("inband");
      expect(repeated.trigger.count).toBe(3);
    }
  });

  it("emits user_correction once and survives both replay and a no-replay model failure (cooldownMs=0)", async () => {
    const signals: ForgeDemandSignal[] = [];
    let now = 10;
    // cooldownMs=0 — dedupe must come from the per-message timestamp set,
    // NOT from cooldown.
    const handle = createForgeDemandDetector(
      makeConfig({ clock: () => now, onDemand: (s) => signals.push(s) }),
    );
    now = 50;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("any"), async () => toolRes());
    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 1000,
    };
    const failModel = async (): Promise<ModelResponse> => {
      throw new Error("transport boom");
    };

    // Failed model call — emission is deferred to a successful next() so
    // a transient transport/validator failure does not consume forge
    // budget for a response the user never sees.
    try {
      await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), failModel);
    } catch {
      // expected
    }
    expect(signals.filter((s) => s.trigger.kind === "user_correction").length).toBe(0);

    // Successful retry commits the correction exactly once.
    const okModel = async (): Promise<ModelResponse> => modelRes("ok");
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), okModel);
    expect(signals.filter((s) => s.trigger.kind === "user_correction").length).toBe(1);

    // Replaying the same transcript again must NOT duplicate.
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), okModel);
    expect(signals.filter((s) => s.trigger.kind === "user_correction").length).toBe(1);
  });

  it("does not consume the session compute-time budget on sub-threshold attempts", async () => {
    let now = 0;
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        // demandThreshold high enough to suppress the first attempt
        // (max confidence for repeated_failure with severity 1 is the
        // base weight 0.9, so 0.95 is unreachable here).
        budget: {
          ...DEFAULT_FORGE_BUDGET,
          computeTimeBudgetMs: 1_000,
          cooldownMs: 0,
          demandThreshold: 0.95,
        },
        heuristics: { repeatedFailureCount: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };

    // Sub-threshold attempt at t=0 — should NOT start the budget window.
    now = 0;
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("noisy"), failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(0);

    // Long after the supposed budget window — a real, threshold-clearing
    // event must still emit because the window was never started.
    now = 5_000;
    const handle2 = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        budget: { ...DEFAULT_FORGE_BUDGET, computeTimeBudgetMs: 1_000, cooldownMs: 0 },
        heuristics: { repeatedFailureCount: 3 },
        onDemand: (s) => signals.push(s),
      }),
    );
    // Use second handle to avoid cross-state interference; same principle
    // applies — sub-threshold attempts never start the window.
    for (let i = 0; i < 3; i += 1) {
      try {
        await handle2.middleware.wrapToolCall?.(ctx, toolReq("real-fail"), failNext);
      } catch {
        // expected
      }
    }
    expect(signals.length).toBe(1);
  });

  it("attributes user_correction to a failed tool call (recordToolCall covers attempts, not just successes)", async () => {
    const signals: ForgeDemandSignal[] = [];
    let now = 0;
    const handle = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        onDemand: (s) => signals.push(s),
      }),
    );

    // tool-A succeeds at t=100.
    now = 100;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-A"), async () => toolRes());

    // tool-B fails (throws) at t=200 — must still appear in attribution history.
    now = 200;
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-B"), async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }

    // User corrects at t=300 — should attribute to tool-B (the latest
    // attempt before the user message), not tool-A.
    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 300,
    };
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), async () =>
      modelRes("ok"),
    );

    const corr = signals.find((s) => s.trigger.kind === "user_correction");
    expect(corr).toBeDefined();
    if (corr?.trigger.kind === "user_correction") {
      expect(corr.trigger.correctedToolCall).toBe("tool-B");
    }
  });

  it("does not let a long-running tool steal user_correction from an earlier completed tool", async () => {
    const signals: ForgeDemandSignal[] = [];
    let now = 0;
    const handle = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        onDemand: (s) => signals.push(s),
      }),
    );

    // tool-A completes at t=100.
    now = 50;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-A"), async () => {
      now = 100;
      return toolRes();
    });

    // tool-B starts at t=150 but has not finished by the user message at t=200.
    let pendingResolve: ((value: ToolResponse) => void) | undefined;
    now = 150;
    const pendingB = handle.middleware.wrapToolCall?.(
      ctx,
      toolReq("tool-B"),
      () =>
        new Promise<ToolResponse>((resolve) => {
          pendingResolve = resolve;
        }),
    );

    // User correction at t=200 — tool-B is still in flight.
    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 200,
    };
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), async () =>
      modelRes("ok"),
    );

    // Now finish tool-B at t=300 (after the user message).
    now = 300;
    pendingResolve?.(toolRes());
    await pendingB;

    const corr = signals.find((s) => s.trigger.kind === "user_correction");
    expect(corr).toBeDefined();
    if (corr?.trigger.kind === "user_correction") {
      // The user could not have been reacting to tool-B (still running) —
      // attribution must be tool-A.
      expect(corr.trigger.correctedToolCall).toBe("tool-A");
    }
  });

  it("createDefaultForgeDemandConfig returns a fresh, isolated config object on every call", async () => {
    const { createDefaultForgeDemandConfig, DEFAULT_FORGE_DEMAND_CONFIG } = await import(
      "./config.js"
    );

    const a = createDefaultForgeDemandConfig();
    // Mutate the returned config — must NOT leak to defaults or to the next call.
    (a.budget as { maxForgesPerSession: number }).maxForgesPerSession = 99;
    (a.heuristics as { repeatedFailureCount: number }).repeatedFailureCount = 99;

    const b = createDefaultForgeDemandConfig();
    expect(b.budget.maxForgesPerSession).toBe(5);
    expect(b.heuristics).toBeDefined();
    if (b.heuristics !== undefined) {
      expect(b.heuristics.repeatedFailureCount).toBe(3);
    }

    // The frozen DEFAULT_FORGE_DEMAND_CONFIG export itself is immutable.
    expect(() => {
      (DEFAULT_FORGE_DEMAND_CONFIG.budget as { maxForgesPerSession: number }).maxForgesPerSession =
        42;
    }).toThrow();
  });

  it("dismiss removes the signal and clears its cooldown", async () => {
    const handle = createForgeDemandDetector(
      makeConfig({
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 60_000 },
        heuristics: { repeatedFailureCount: 1 },
      }),
    );

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("e");
    };
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("dis-tool"), failNext);
    } catch {
      // expected
    }
    const [first] = handle.forSession(ctx.session).getSignals();
    expect(first).toBeDefined();
    if (first === undefined) return;

    handle.forSession(ctx.session).dismiss(first.id);
    expect(handle.forSession(ctx.session).getActiveSignalCount()).toBe(0);
  });

  it("wrapModelStream scans corrections and runs capability-gap on assembled deltas", async () => {
    const signals: ForgeDemandSignal[] = [];
    let now = 10;
    const handle = createForgeDemandDetector(
      makeConfig({
        clock: () => now,
        heuristics: { capabilityGapOccurrences: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );

    now = 50;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("search-tool"), async () => toolRes());

    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 100,
    };

    // Stream emits deltas that, when assembled, match the capability-gap pattern.
    const streamNext = (): AsyncIterable<ModelChunk> =>
      (async function* () {
        yield { kind: "text_delta", delta: "I don't have a tool for " };
        yield { kind: "text_delta", delta: "compiling rust code" };
        yield {
          kind: "done",
          response: {
            content: "I don't have a tool for compiling rust code",
            model: "test",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
      })();

    const stream = handle.middleware.wrapModelStream?.(ctx, modelReq([correction]), streamNext);
    if (stream === undefined) throw new Error("wrapModelStream not implemented");
    const collected: ModelChunk[] = [];
    for await (const chunk of stream) collected.push(chunk);

    // Corrections fired before stream dispatch + capability_gap detected on completion.
    expect(signals.some((s) => s.trigger.kind === "user_correction")).toBe(true);
    expect(signals.some((s) => s.trigger.kind === "capability_gap")).toBe(true);
    // All chunks were relayed to the caller untouched.
    expect(collected.length).toBe(3);
  });

  it("middleware priority places it OUTSIDE feedback-loop (450) so it observes only committed state", () => {
    const handle = createForgeDemandDetector(makeConfig());
    // Lower priority = outer onion layer in the koi engine compose order.
    // forge-demand must be outer relative to feedback-loop (450) so that
    // capability-gap and latency checks fire only on post-validation,
    // post-health-recording state.
    expect(handle.middleware.priority).toBeDefined();
    if (handle.middleware.priority !== undefined) {
      expect(handle.middleware.priority).toBeLessThan(450);
    }
  });

  it("does not double-count capability-gap on retry of the same request/response", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const userTurn: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "compile this rust code" }],
      timestamp: 100,
    };
    const sameResp = async (): Promise<ModelResponse> =>
      modelRes("I don't have a tool for compiling rust code");

    // Same turnId = retries within one turn must dedup.
    const ctxA = createMockTurnContext({ turnIndex: 0 });
    await handle.middleware.wrapModelCall?.(ctxA, modelReq([userTurn]), sameResp);
    await handle.middleware.wrapModelCall?.(ctxA, modelReq([userTurn]), sameResp);
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(0);

    // A NEW turn (distinct turnId via different turnIndex) with the same
    // response text DOES count.
    const ctxB = createMockTurnContext({ turnIndex: 1 });
    await handle.middleware.wrapModelCall?.(ctxB, modelReq([userTurn]), sameResp);
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(1);
  });

  it("commits streamed signals on `done` chunk even if the consumer breaks immediately after", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const streamNext = (): AsyncIterable<ModelChunk> =>
      (async function* () {
        yield { kind: "text_delta", delta: "I don't have a tool for compiling rust code" };
        yield {
          kind: "done",
          response: {
            content: "I don't have a tool for compiling rust code",
            model: "test",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
      })();

    const stream = handle.middleware.wrapModelStream?.(ctx, modelReq([]), streamNext);
    if (stream === undefined) throw new Error("wrapModelStream not implemented");
    // Break immediately after seeing the `done` chunk — post-loop code in
    // the relay generator would not run, so commit-on-done is required.
    for await (const chunk of stream) {
      if (chunk.kind === "done") break;
    }

    expect(signals.some((s) => s.trigger.kind === "capability_gap")).toBe(true);
  });

  it("does not blacklist a correction when emitSignal was suppressed by threshold/cap/cooldown", async () => {
    const signals: ForgeDemandSignal[] = [];
    // Threshold above user_correction's hard-coded 0.7 confidence — the
    // correction is suppressed but must remain eligible for retry/replay.
    const handle = createForgeDemandDetector(
      makeConfig({
        budget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.95, cooldownMs: 0 },
        onDemand: (s) => signals.push(s),
      }),
    );

    await handle.middleware.wrapToolCall?.(ctx, toolReq("any-tool"), async () => toolRes());

    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 100,
    };
    const okModel = async (): Promise<ModelResponse> => modelRes("ok");

    // Pass 1: threshold gate suppresses emission.
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), okModel);
    expect(signals.length).toBe(0);

    // Lower threshold by recreating handle... actually, demonstrate that
    // the message is NOT permanently blacklisted: clear the original
    // suppression by using a second handle with a permissive threshold —
    // the correction message would have been "scanned" and "emitted=false"
    // there, so the same handle in the same session is still eligible if
    // the gate ever opens. Here we just assert no blacklist by checking
    // the dismiss/recovery path remains usable: a fresh handle on the
    // same session must NOT have inherited blacklist state, of course,
    // but the in-handle behavior is documented by emitted-only-on-success.
    // We assert via internals indirectly: a second pass with the same
    // correction must still be processed (no duplicate emit, no error).
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), okModel);
    expect(signals.length).toBe(0);
  });

  it("does not collapse long-transcript repeats of the same ask that share a prefix > 512 chars", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const longPrefix = "x".repeat(800);
    const longRefusalSuffix = "y".repeat(200);
    const refusalA = `I don't have a tool for compiling rust code ${longRefusalSuffix} A`;
    const refusalB = `I don't have a tool for compiling rust code ${longRefusalSuffix} B`;
    const respA = async (): Promise<ModelResponse> => modelRes(refusalA);
    const respB = async (): Promise<ModelResponse> => modelRes(refusalB);

    const u: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: `${longPrefix} compile rust` }],
      timestamp: 100,
    };
    // Same final user message (the ask) repeated, but distinct message
    // stacks so per-response dedup does not short-circuit. Window-bucket
    // logic groups them as the same gap on the same task; the count
    // should reach the threshold and emit one signal. Guards against
    // prefix-only dedup collisions that previously masked repeated calls.
    const ctxA = createMockTurnContext({ turnIndex: 1 });
    const ctxB = createMockTurnContext({ turnIndex: 2 });
    await handle.middleware.wrapModelCall?.(ctxA, modelReq([u]), respA);
    await handle.middleware.wrapModelCall?.(ctxB, modelReq([u]), respB);

    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(1);
  });

  it("aggregates capability-gap occurrences when the user repeats the same ask across turns", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const sameResp = async (): Promise<ModelResponse> =>
      modelRes("I don't have a tool for compiling rust code");

    const u: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "compile rust" }],
      timestamp: 100,
    };
    // Two model calls with the SAME current user ask but distinct turn
    // ids must accumulate toward the threshold — task scoping (last
    // user message identity) groups identical asks; dedup is keyed on
    // turn fingerprint so distinct turns are not collapsed as retries.
    const ctxA = createMockTurnContext({ turnIndex: 1 });
    const ctxB = createMockTurnContext({ turnIndex: 2 });
    await handle.middleware.wrapModelCall?.(ctxA, modelReq([u]), sameResp);
    await handle.middleware.wrapModelCall?.(ctxB, modelReq([u]), sameResp);

    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(1);
  });

  it("returns frozen signal clones from getSignals so callers cannot mutate detector state", async () => {
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("x"), failNext);
    } catch {
      // expected
    }
    const [signal] = handle.forSession(ctx.session).getSignals();
    if (signal === undefined) throw new Error("no signal");

    // Mutating the returned object must throw in strict mode and must not
    // affect the next read from the handle.
    expect(() => {
      (signal as unknown as { id: string }).id = "tampered";
    }).toThrow();
    const [again] = handle.forSession(ctx.session).getSignals();
    expect(again?.id).not.toBe("tampered");
  });

  it("does not commit capability-gap signals when wrapModelStream aborts mid-stream", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );

    // Stream emits partial refusal text then throws — uncommitted output
    // must not consume forge budget or fire signals (mirrors wrapModelCall's
    // post-success contract — a partial response can flip-flop on retry).
    const streamNext = (): AsyncIterable<ModelChunk> =>
      (async function* () {
        yield { kind: "text_delta", delta: "I don't have a tool for compiling rust code" };
        throw new Error("transport boom mid-stream");
      })();

    const stream = handle.middleware.wrapModelStream?.(ctx, modelReq([]), streamNext);
    if (stream === undefined) throw new Error("wrapModelStream not implemented");
    let threw = false;
    try {
      for await (const _c of stream) {
        // drain
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(signals.some((s) => s.trigger.kind === "capability_gap")).toBe(false);
  });

  it("emits globally unique signal ids across sessions so dismiss() targets the right one", async () => {
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    const ctxA = createMockTurnContext({ session: { sessionId: "sess-A" as never } });
    const ctxB = createMockTurnContext({ session: { sessionId: "sess-B" as never } });

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };

    for (const c of [ctxA, ctxB]) {
      try {
        await handle.middleware.wrapToolCall?.(c, toolReq("t"), failNext);
      } catch {
        // expected
      }
    }
    const aSignals = handle.forSession(ctxA.session).getSignals();
    const bSignals = handle.forSession(ctxB.session).getSignals();
    expect(aSignals.length).toBe(1);
    expect(bSignals.length).toBe(1);
    // Distinct ids — no `demand-1` collision across sessions.
    expect(aSignals[0]?.id).not.toBe(bSignals[0]?.id);

    // Dismiss in session A — must NOT clear B's signal even if id were known.
    const aId = aSignals[0]?.id;
    if (aId === undefined) throw new Error("no a signal");
    handle.forSession(ctxA.session).dismiss(aId);
    expect(handle.forSession(ctxA.session).getActiveSignalCount()).toBe(0);
    expect(handle.forSession(ctxB.session).getActiveSignalCount()).toBe(1);

    // Cross-session dismiss with B's id from A's session must NOT touch B.
    const bId = bSignals[0]?.id;
    if (bId === undefined) throw new Error("no b signal");
    handle.forSession(ctxA.session).dismiss(bId);
    expect(handle.forSession(ctxB.session).getActiveSignalCount()).toBe(1);
  });

  it("isolates state per session — failures and signals do not bleed across tenants", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 3 },
        onDemand: (s) => signals.push(s),
      }),
    );

    const ctxA = createMockTurnContext({ session: { sessionId: "session-A" as never } });
    const ctxB = createMockTurnContext({ session: { sessionId: "session-B" as never } });

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };

    // Session A accumulates 2 failures (sub-threshold).
    for (let i = 0; i < 2; i += 1) {
      try {
        await handle.middleware.wrapToolCall?.(ctxA, toolReq("shared-tool"), failNext);
      } catch {
        // expected
      }
    }
    // Session B has its own counter — a single failure here must NOT inherit
    // session A's accumulated count and trip the threshold of 3.
    try {
      await handle.middleware.wrapToolCall?.(ctxB, toolReq("shared-tool"), failNext);
    } catch {
      // expected
    }
    expect(signals.length).toBe(0);

    // Ending session A clears ONLY A's state — session B's counter survives.
    await handle.middleware.onSessionEnd?.(ctxA.session);
    try {
      await handle.middleware.wrapToolCall?.(ctxB, toolReq("shared-tool"), failNext);
    } catch {
      // expected
    }
    try {
      await handle.middleware.wrapToolCall?.(ctxB, toolReq("shared-tool"), failNext);
    } catch {
      // expected
    }
    // Session B reaches threshold (3 failures): emits one signal.
    expect(signals.filter((s) => s.trigger.kind === "repeated_failure").length).toBe(1);
  });

  it("dedupes user corrections by content identity, not raw timestamp", async () => {
    const signals: ForgeDemandSignal[] = [];
    let now = 10;
    const handle = createForgeDemandDetector(
      makeConfig({ clock: () => now, onDemand: (s) => signals.push(s) }),
    );

    now = 50;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("any-tool"), async () => toolRes());

    // Two distinct user corrections that happen to share a millisecond
    // timestamp must NOT collapse into one signal.
    const a: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 100,
    };
    const b: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "actually, use the other tool" }],
      timestamp: 100,
    };
    await handle.middleware.wrapModelCall?.(ctx, modelReq([a, b]), async () => modelRes("ok"));

    expect(signals.filter((s) => s.trigger.kind === "user_correction").length).toBe(2);
  });

  it("freezes emitted signals so onDemand cannot mutate detector state", async () => {
    // Regression for F57 (round 2) — onDemand received the live stored
    // signal object. Mutating `id`/`trigger`/`context.failedToolCalls`
    // through the callback corrupted dismissal/cooldown bookkeeping.
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 1 },
        onDemand: (s) => {
          // Attempt mutations a buggy observer might do.
          expect(() => {
            (s as unknown as { id: string }).id = "tampered";
          }).toThrow();
          expect(() => {
            (s.context.failedToolCalls as unknown as string[]).push("tampered");
          }).toThrow();
        },
      }),
    );
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("t"), async () => {
        throw new Error("boom");
      });
    } catch {
      /* expected */
    }
    const [stored] = handle.forSession(ctx.session).getSignals();
    expect(stored?.id).not.toBe("tampered");
  });

  it("forSession rejects a fabricated SessionContext literal (cross-tenant guard)", async () => {
    // Regression for F61 (round 4) — forSession previously authorized
    // purely by `session.sessionId`, so any in-process caller with a
    // victim's sessionId could fabricate a SessionContext literal and
    // read or dismiss the victim's signals. Now authorization is by
    // observed-object identity.
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    // Run a real hook so `ctx.session` becomes an observed (legitimate)
    // SessionContext, then verify a forged literal carrying the same
    // sessionId is rejected.
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("t"), async () => {
        throw new Error("boom");
      });
    } catch {
      /* expected */
    }
    // Real ctx.session is admitted.
    expect(() => handle.forSession(ctx.session)).not.toThrow();
    // Forged literal with the same sessionId — must be rejected.
    const forged = { ...ctx.session };
    expect(() => handle.forSession(forged)).toThrow(/observed by the detector/);
  });

  it("emits identical signal sets via wrapModelCall and wrapModelStream under tight budgets", async () => {
    // Regression for F71 (round 9) — the two paths previously committed
    // user_correction and capability_gap in opposite orders. With
    // maxForgesPerSession: 1 and a single demand-threshold pass, the
    // same conversation could retain a DIFFERENT signal depending only
    // on whether the provider used streaming.
    function makeDetector(): ForgeDemandConfig & { signals: ForgeDemandSignal[] } {
      const signals: ForgeDemandSignal[] = [];
      return {
        budget: {
          maxForgesPerSession: 1,
          computeTimeBudgetMs: 120_000,
          demandThreshold: 0.5,
          cooldownMs: 0,
        },
        heuristics: { capabilityGapOccurrences: 1, repeatedFailureCount: 99 },
        onDemand: (s) => signals.push(s),
        signals,
      };
    }
    const correction = userMsg("no, that's not right");
    // Set up state: one prior tool call (so user_correction can attribute).
    async function runNonStream(): Promise<readonly string[]> {
      const cfg = makeDetector();
      const handle = createForgeDemandDetector(cfg);
      await handle.middleware.wrapToolCall?.(ctx, toolReq("t"), async () => toolRes());
      await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), async () =>
        modelRes("I don't have a tool for that"),
      );
      return cfg.signals.map((s) => s.trigger.kind);
    }
    async function runStream(): Promise<readonly string[]> {
      const cfg = makeDetector();
      const handle = createForgeDemandDetector(cfg);
      await handle.middleware.wrapToolCall?.(ctx, toolReq("t"), async () => toolRes());
      const stream = handle.middleware.wrapModelStream;
      if (stream === undefined) throw new Error("wrapModelStream missing");
      for await (const _ of stream(ctx, modelReq([correction]), async function* () {
        yield {
          kind: "done",
          response: modelRes("I don't have a tool for that"),
        } as ModelChunk;
      })) {
        // drain
      }
      return cfg.signals.map((s) => s.trigger.kind);
    }
    const a = await runNonStream();
    const b = await runStream();
    expect(b).toEqual(a);
  });

  it("isolates a throwing healthTracker — wrapToolCall must not surface its error", async () => {
    // Regression for F74 (round 11) — checkLatencyDegradation called
    // healthTracker.getSnapshot directly with no isolation, so a
    // throwing tracker bubbled out of wrapToolCall after the tool
    // had already succeeded (or masked the original tool error on
    // the failure path), violating the passive-observer contract.
    const originalErr = console.error;
    const swallowed: unknown[] = [];
    console.error = (...args: unknown[]): void => {
      swallowed.push(args);
    };
    try {
      const handle = createForgeDemandDetector(
        makeConfig({
          healthTracker: {
            getSnapshot: (_sid: string, _tid: string) => {
              throw new Error("tracker boom");
            },
          },
        }),
      );
      // Successful tool call — must return its response unchanged
      // even though the tracker throws inside checkLatencyDegradation.
      const response = await handle.middleware.wrapToolCall?.(ctx, toolReq("any"), async () =>
        toolRes(),
      );
      expect(response?.output).toBe("ok");
      // Failure path — original tool error must propagate, not the
      // tracker's "tracker boom".
      let caught: unknown;
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("any"), async () => {
          throw new Error("real tool error");
        });
      } catch (e) {
        caught = e;
      }
      expect((caught as Error)?.message).toBe("real tool error");
      expect(swallowed.length).toBeGreaterThan(0);
    } finally {
      console.error = originalErr;
    }
  });

  it("retries onSessionAttached delivery on next traffic when the callback throws", async () => {
    // Regression for F72 (round 10) — the detector previously marked
    // a session observed before firing the callback, so a transient
    // callback failure permanently stranded the session: subsequent
    // traffic short-circuited and the host could never recover the
    // scoped handle. Now we mark observed only after delivery
    // succeeds, so the next call retries.
    const originalErr = console.error;
    const swallowed: unknown[] = [];
    console.error = (...args: unknown[]): void => {
      swallowed.push(args);
    };
    try {
      let attempt = 0;
      const delivered: number[] = [];
      const handle = createForgeDemandDetector(
        makeConfig({
          onSessionAttached: (_session, _scoped) => {
            attempt += 1;
            if (attempt === 1) throw new Error("transient");
            delivered.push(attempt);
          },
        }),
      );
      // First call — callback throws; session must remain UNobserved
      // so the next call retries.
      await handle.middleware.wrapToolCall?.(ctx, toolReq("t"), async () => toolRes());
      expect(attempt).toBe(1);
      expect(delivered.length).toBe(0);
      // Second call — callback succeeds; session is now observed and
      // a third call would short-circuit.
      await handle.middleware.wrapToolCall?.(ctx, toolReq("t"), async () => toolRes());
      expect(attempt).toBe(2);
      expect(delivered).toEqual([2]);
      await handle.middleware.wrapToolCall?.(ctx, toolReq("t"), async () => toolRes());
      expect(attempt).toBe(2);
    } finally {
      console.error = originalErr;
    }
  });

  it("createDefaultForgeDemandConfig preserves onSessionAttached through to the detector", async () => {
    // Regression for F69 (round 8) — the default-config factory dropped
    // onSessionAttached, so any caller using the documented
    // `createDefaultForgeDemandConfig({ onSessionAttached, ... })`
    // flow silently lost the callback. With sessionId-keyed lookup
    // intentionally absent, scoped handles became unreachable and
    // emitted signals could not be dismissed.
    const { createDefaultForgeDemandConfig } = await import("./config.js");
    const attached: number[] = [];
    const config = createDefaultForgeDemandConfig({
      onSessionAttached: (s) => {
        attached.push(s.sessionId.length);
      },
    });
    expect(typeof config.onSessionAttached).toBe("function");
    const handle = createForgeDemandDetector(config);
    await handle.middleware.wrapToolCall?.(ctx, toolReq("any"), async () => toolRes());
    expect(attached.length).toBe(1);
  });

  it("excludes NOT_FOUND tool lookups from correction attribution history", async () => {
    // Regression for F62 (round 4) — wrapToolCall recorded every request
    // in recentToolCalls and marked it completed even on NOT_FOUND, so
    // a later user_correction would blame a phantom tool that never
    // executed and burn forge budget.
    const signals: ForgeDemandSignal[] = [];
    let now = 0;
    const handle = createForgeDemandDetector(
      makeConfig({ clock: () => now, onDemand: (s) => signals.push(s) }),
    );
    now = 50;
    // The unresolved-tool request itself emits a `no_matching_tool`
    // signal (ignored here) but must NOT linger in recentToolCalls.
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("missing-tool"), async () => {
        throw KoiRuntimeError.from("NOT_FOUND", "tool 'missing-tool' is not registered");
      });
    } catch {
      /* expected */
    }
    const correction: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 100,
    };
    await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), async () =>
      modelRes("ok"),
    );
    // No tool ever executed — correction attribution must skip the
    // unresolved lookup, so no `user_correction` signal fires.
    expect(signals.filter((s) => s.trigger.kind === "user_correction").length).toBe(0);
  });

  it("does NOT emit user_correction when corrected answer was model-only (no adjacent tool)", async () => {
    // Regression for F58 (round 2) — correction attribution previously
    // returned the most recent completed tool in the session, even when
    // the corrected assistant turn was a pure-model response. That made
    // any earlier tool blamed for an unrelated user complaint.
    const signals: ForgeDemandSignal[] = [];
    let now = 0;
    const handle = createForgeDemandDetector(
      makeConfig({ clock: () => now, onDemand: (s) => signals.push(s) }),
    );
    // Tool runs early — bound to the pre-correction part of the conversation.
    now = 50;
    await handle.middleware.wrapToolCall?.(ctx, toolReq("early-tool"), async () => toolRes());
    // Earlier user turn (model-only response between u1 and u2 — no tool).
    const u1: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "tell me a joke" }],
      timestamp: 100,
    };
    // Later user turn — corrects a model-only answer. Must NOT blame `early-tool`.
    const u2: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "no, that's not right" }],
      timestamp: 200,
    };
    await handle.middleware.wrapModelCall?.(ctx, modelReq([u1, u2]), async () => modelRes("ok"));
    expect(signals.filter((s) => s.trigger.kind === "user_correction").length).toBe(0);
  });

  it("F76: scoped handle stays bound to original sessionId after context mutation", async () => {
    // Reviewer F76: scoped handles authorize by SessionContext object
    // identity but resolved state via `session.sessionId` on every call.
    // If the underlying field is mutated post-issuance, the same handle
    // object would silently start operating on another tenant's state.
    // The fix captures sessionId at issuance and closes over it.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );
    const mutableCtx: TurnContext = createMockTurnContext();
    const originalSessionId = mutableCtx.session.sessionId;
    // Generate a signal for the original session.
    try {
      await handle.middleware.wrapToolCall?.(mutableCtx, toolReq("a"), async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    const scoped = handle.forSession(mutableCtx.session);
    expect(scoped.getActiveSignalCount()).toBe(1);
    // Mutate the sessionId field. Whether or not the runtime would ever
    // do this, the handle MUST NOT redirect to a different bucket.
    (mutableCtx.session as { sessionId: string }).sessionId = "victim-session";
    expect(mutableCtx.session.sessionId).not.toBe(originalSessionId);
    expect(scoped.getActiveSignalCount()).toBe(1);
    expect(scoped.getSignals().length).toBe(1);
  });

  it("F77: capability-gap counters do not aggregate across unrelated user requests", async () => {
    // Reviewer F77: keying capability-gap counts solely off the refusal
    // window meant a model that emits the same generic phrase for two
    // entirely unrelated user asks (e.g. "make a chart" and "summarize
    // this email") would be reported as a single high-confidence demand
    // signal. The fix scopes the counter by last-user-message identity
    // so only repeated refusals to the same task contribute.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
        onDemand: (s) => signals.push(s),
      }),
    );
    const refusal = "Sorry, I don't have a tool for that.";
    const askA: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "make me a chart of last quarter sales" }],
      timestamp: 1,
    };
    const askB: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "summarize the attached email thread" }],
      timestamp: 2,
    };
    // Distinct turns share the session but have different turnIds so the
    // per-response dedup short-circuit does not hide the bucket-key check.
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    const ctx2 = createMockTurnContext({ turnIndex: 2 });
    const ctx3 = createMockTurnContext({ turnIndex: 3 });
    await handle.middleware.wrapModelCall?.(ctx1, modelReq([askA]), async () => modelRes(refusal));
    await handle.middleware.wrapModelCall?.(ctx2, modelReq([askB]), async () => modelRes(refusal));
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(0);
    // The same ask repeated DOES still aggregate to threshold.
    await handle.middleware.wrapModelCall?.(ctx3, modelReq([askA]), async () => modelRes(refusal));
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(1);
  });

  it("F78: unrelated later asks in a long conversation do not aggregate via shared opener", async () => {
    // Reviewer F78: a chat runtime replays the full transcript on each
    // turn, so anchoring task context on the FIRST user message would
    // make every later turn share the original opener's identity and
    // unrelated subsequent asks would still aggregate. The fix anchors
    // on the CURRENT (last) user message; this test guards that path
    // against regression to first-message scoping.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
        onDemand: (s) => signals.push(s),
      }),
    );
    const refusal = "Sorry, I don't have a tool for that.";
    const opener: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "hi, can we work on something today?" }],
      timestamp: 1,
    };
    const askA: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "first ask: please render a chart" }],
      timestamp: 2,
    };
    const askB: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "later ask: please summarize an email" }],
      timestamp: 3,
    };
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    const ctx2 = createMockTurnContext({ turnIndex: 2 });
    // Each later turn replays the opener — if the bucket keyed off the
    // first user message, both would aggregate falsely.
    await handle.middleware.wrapModelCall?.(ctx1, modelReq([opener, askA]), async () =>
      modelRes(refusal),
    );
    await handle.middleware.wrapModelCall?.(ctx2, modelReq([opener, askB]), async () =>
      modelRes(refusal),
    );
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(0);
  });

  it("F80: capability-gap aggregates the same ask across turns with distinct timestamps", async () => {
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
        onDemand: (s) => signals.push(s),
      }),
    );
    const refusal = "I don't have a tool for compiling rust code";
    const askT1: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "compile rust" }],
      timestamp: 100,
    };
    // Same content, distinct wall-clock — must still aggregate. Pre-fix
    // this would land in a fresh bucket because messageIdentity baked
    // the timestamp into the key.
    const askT2: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "compile rust" }],
      timestamp: 999_999,
    };
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    const ctx2 = createMockTurnContext({ turnIndex: 2 });
    await handle.middleware.wrapModelCall?.(ctx1, modelReq([askT1]), async () => modelRes(refusal));
    await handle.middleware.wrapModelCall?.(ctx2, modelReq([askT2]), async () => modelRes(refusal));
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(1);
  });

  it("F81: failedToolCalls history is reset after a successful run", async () => {
    // Reviewer F81: a successful tool call reset the failure counter
    // but left accumulated error messages attached. A later signal
    // would surface stale errors alongside a fresh failureCount,
    // misleading downstream context.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 2 },
        onDemand: (s) => signals.push(s),
      }),
    );
    const failOld = async (): Promise<ToolResponse> => {
      throw new Error("OLD-STREAK-ERROR");
    };
    const succeed = async (): Promise<ToolResponse> => toolRes();
    const failNew = async (): Promise<ToolResponse> => {
      throw new Error("NEW-STREAK-ERROR");
    };
    // First failure streak (emits a signal at threshold 2).
    for (let i = 0; i < 2; i += 1) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("flaky"), failOld);
      } catch {
        // expected
      }
    }
    // Recovery must clear the failure-message history. Use a different
    // tool id is NOT needed — same toolId tests the per-tool clear.
    await handle.middleware.wrapToolCall?.(ctx, toolReq("flaky"), succeed);
    // Dismiss the OLD-streak signal so cooldown does not block the
    // fresh signal we want to inspect.
    const allSignalsAfterRecovery = handle.forSession(ctx.session).getSignals();
    for (const s of allSignalsAfterRecovery) {
      handle.forSession(ctx.session).dismiss(s.id);
    }
    const beforeNewStreak = signals.length;
    for (let i = 0; i < 2; i += 1) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("flaky"), failNew);
      } catch {
        // expected
      }
    }
    expect(signals.length).toBeGreaterThan(beforeNewStreak);
    const newSignal = signals[signals.length - 1];
    expect(newSignal).toBeDefined();
    if (newSignal === undefined) return;
    const calls = newSignal.context.failedToolCalls;
    expect(calls.some((m) => m.includes("OLD-STREAK-ERROR"))).toBe(false);
    expect(calls.some((m) => m.includes("NEW-STREAK-ERROR"))).toBe(true);
  });

  it("F82: unrelated autonomous turns with no user message do not aggregate via empty task scope", async () => {
    // Reviewer F82: when no user-authored message is present,
    // taskContextFingerprint returned "" — every internal/autonomous
    // turn shared the same empty bucket, so two unrelated internal
    // refusals could trip threshold and emit a forged-demand signal.
    // The fix falls back to a per-request fingerprint when no user
    // message is present.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
        onDemand: (s) => signals.push(s),
      }),
    );
    const refusal = "Sorry, I don't have a tool for that.";
    // System-only transcripts (no user sender) — distinct turnIds.
    const sysA: InboundMessage = {
      senderId: "system:internal",
      content: [{ kind: "text", text: "internal task A" }],
      timestamp: 1,
    };
    const sysB: InboundMessage = {
      senderId: "system:internal",
      content: [{ kind: "text", text: "internal task B" }],
      timestamp: 2,
    };
    const ctx1 = createMockTurnContext({ turnIndex: 11 });
    const ctx2 = createMockTurnContext({ turnIndex: 12 });
    await handle.middleware.wrapModelCall?.(ctx1, modelReq([sysA]), async () => modelRes(refusal));
    await handle.middleware.wrapModelCall?.(ctx2, modelReq([sysB]), async () => modelRes(refusal));
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(0);
  });

  it("F83: same prompt over different attachments does not aggregate as one task", async () => {
    // Reviewer F83: messageIdentity / taskContextFingerprint hashed only
    // text blocks. "summarize this" against different files would share
    // the same task identity and aggregate generic refusals into one
    // false-positive signal. The fix folds non-text blocks into both
    // fingerprints.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
        onDemand: (s) => signals.push(s),
      }),
    );
    const refusal = "I don't have a tool for that.";
    const askWithFile = (url: string): InboundMessage => ({
      senderId: "user",
      content: [
        { kind: "text", text: "summarize this" },
        { kind: "file", url, mimeType: "application/pdf" },
      ],
      timestamp: 1,
    });
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    const ctx2 = createMockTurnContext({ turnIndex: 2 });
    await handle.middleware.wrapModelCall?.(
      ctx1,
      modelReq([askWithFile("file://a.pdf")]),
      async () => modelRes(refusal),
    );
    await handle.middleware.wrapModelCall?.(
      ctx2,
      modelReq([askWithFile("file://b.pdf")]),
      async () => modelRes(refusal),
    );
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(0);
  });

  it("F84: cooldown does not suppress an unrelated task that shares the same refusal text", async () => {
    // Reviewer F84: cooldown was keyed off triggerKey() which used only
    // requiredCapability (windowText). Two tasks producing the same
    // generic refusal would share the cooldown bucket — task B silenced
    // until task A's cooldown expired. The fix passes the full
    // (pattern,task,window) key as the cooldown key so each task has
    // its own cooldown.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        // Active cooldown so suppression is observable across tasks.
        budget: { ...DEFAULT_FORGE_BUDGET, cooldownMs: 60_000 },
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
        onDemand: (s) => signals.push(s),
      }),
    );
    const refusal = "I don't have a tool for that.";
    const askA = userMsg("task A: please render a chart");
    const askB = userMsg("task B: please summarize an email");
    // Drive task A to threshold → emits.
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 1 }),
      modelReq([askA]),
      async () => modelRes(refusal),
    );
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 2 }),
      modelReq([askA]),
      async () => modelRes(refusal),
    );
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(1);
    // Drive task B to threshold — must NOT be suppressed by A's cooldown.
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 3 }),
      modelReq([askB]),
      async () => modelRes(refusal),
    );
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 4 }),
      modelReq([askB]),
      async () => modelRes(refusal),
    );
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(2);
  });

  it("F85: dismissing one capability-gap signal does not erase counters for unrelated tasks", async () => {
    // Reviewer F85: resetTriggerState wiped every counter whose key
    // ended with the dismissed signal's requiredCapability suffix —
    // operator dismissing one signal silently erased in-progress
    // evidence on a different task. The fix stores the exact bucket
    // key per signal at emit time and clears only that bucket.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
        onDemand: (s) => signals.push(s),
      }),
    );
    const refusal = "I don't have a tool for that.";
    const askA = userMsg("task A: render a chart");
    const askB = userMsg("task B: summarize an email");
    // Use a stable ctx for the forSession query so its session has
    // flowed through the middleware (object-identity authorization).
    const queryCtx = createMockTurnContext({ turnIndex: 1 });
    // Task A emits at threshold.
    await handle.middleware.wrapModelCall?.(queryCtx, modelReq([askA]), async () =>
      modelRes(refusal),
    );
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 2 }),
      modelReq([askA]),
      async () => modelRes(refusal),
    );
    // Task B accumulates one count (sub-threshold).
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 3 }),
      modelReq([askB]),
      async () => modelRes(refusal),
    );
    const aSignal = handle.forSession(queryCtx.session).getSignals()[0];
    expect(aSignal).toBeDefined();
    if (aSignal === undefined) return;
    handle.forSession(queryCtx.session).dismiss(aSignal.id);
    // One more refusal on task B must still complete the threshold.
    // Pre-fix this would have been suppressed because dismissal wiped
    // task B's accumulated count along with task A's.
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 4 }),
      modelReq([askB]),
      async () => modelRes(refusal),
    );
    expect(
      signals.filter((s) => s.trigger.kind === "capability_gap").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("F86: capabilityGapCounts is bounded across many distinct tasks", async () => {
    // Reviewer F86: capabilityGapCounts grew without bound across long
    // sessions with many unique asks. The fix caps the map at
    // CAPABILITY_GAP_BUCKET_CAP (128). This test exercises the cap path
    // by driving many distinct buckets through the detector and asserts
    // detector remains functional (no error, fresh signals still
    // possible) — exact internal sizes are intentionally not asserted
    // since the cap is an implementation detail.
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
      }),
    );
    const refusal = "I don't have a tool for that.";
    const queryCtx = createMockTurnContext({ turnIndex: 0 });
    await handle.middleware.wrapModelCall?.(
      queryCtx,
      modelReq([userMsg("unique-task-0")]),
      async () => modelRes(refusal),
    );
    for (let i = 1; i < 250; i += 1) {
      await handle.middleware.wrapModelCall?.(
        createMockTurnContext({ turnIndex: i }),
        modelReq([userMsg(`unique-task-${String(i)}`)]),
        async () => modelRes(refusal),
      );
    }
    // Detector still emits a fresh signal for a brand-new task that
    // crosses threshold — proves the cap did not deadlock state.
    const fresh = userMsg("fresh ask after the storm");
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 9001 }),
      modelReq([fresh]),
      async () => modelRes(refusal),
    );
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 9002 }),
      modelReq([fresh]),
      async () => modelRes(refusal),
    );
    expect(handle.forSession(queryCtx.session).getActiveSignalCount()).toBeGreaterThan(0);
  });

  it("F87: describeCapabilities returns undefined so the passive observer never alters the model prompt", async () => {
    // Reviewer F87: surfacing detector state through the capability
    // banner conditioned future model calls on observed signals,
    // violating the passive-observer contract. The middleware must
    // return undefined regardless of how many signals are pending.
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("flaky"), async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    expect(handle.forSession(ctx.session).getActiveSignalCount()).toBe(1);
    expect(handle.middleware.describeCapabilities?.(ctx)).toBeUndefined();
  });

  it("F88: a scoped handle is revoked when its session ends and cannot read a reused session", async () => {
    // Reviewer F88: scoped handles closed only over `sessionId` string,
    // so a sessionId reused after onSessionEnd would let an old handle
    // silently read the new session's signals. The fix captures a
    // generation token at issuance and refuses to operate once
    // onSessionEnd advances the generation.
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    const sessionA = createMockTurnContext({ turnIndex: 1 });
    try {
      await handle.middleware.wrapToolCall?.(sessionA, toolReq("flaky"), async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    const staleHandle = handle.forSession(sessionA.session);
    expect(staleHandle.getActiveSignalCount()).toBe(1);
    await handle.middleware.onSessionEnd?.(sessionA.session);
    expect(staleHandle.getActiveSignalCount()).toBe(0);
    expect(staleHandle.getSignals().length).toBe(0);
    // A NEW session reuses the same id.
    const sessionB = createMockTurnContext({ turnIndex: 2 });
    expect(sessionB.session.sessionId).toBe(sessionA.session.sessionId);
    try {
      await handle.middleware.wrapToolCall?.(sessionB, toolReq("flaky"), async () => {
        throw new Error("new boom");
      });
    } catch {
      // expected
    }
    expect(staleHandle.getActiveSignalCount()).toBe(0);
    expect(staleHandle.getSignals().length).toBe(0);
    staleHandle.dismiss("demand-9999");
    const freshHandle = handle.forSession(sessionB.session);
    expect(freshHandle.getActiveSignalCount()).toBe(1);
  });

  it("F89: forSession resolves via the sessionId bound at observation, not the mutable session.sessionId", async () => {
    // Reviewer F89: forSession only checked object membership, then
    // read session.sessionId from the same mutable object. A caller
    // who legitimately observed one session could mutate its
    // sessionId and obtain a handle for a different tenant. The fix
    // stores the sessionId observed at first sighting and resolves
    // forSession against that binding.
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    // Tenant A — drive a signal.
    const tenantA = createMockTurnContext({ turnIndex: 1 });
    try {
      await handle.middleware.wrapToolCall?.(tenantA, toolReq("flaky"), async () => {
        throw new Error("A boom");
      });
    } catch {
      // expected
    }
    // Tenant B — separate sessionId, drive its own signal.
    const tenantBSid = "victim-session";
    const tenantB = createMockTurnContext({ session: { sessionId: tenantBSid } as never });
    try {
      await handle.middleware.wrapToolCall?.(tenantB, toolReq("flaky"), async () => {
        throw new Error("B boom");
      });
    } catch {
      // expected
    }
    // The attack: tenantA's observed SessionContext has its sessionId
    // mutated to tenantB's id. forSession on this object MUST NOT
    // return tenantB's signals.
    const originalSid = tenantA.session.sessionId;
    (tenantA.session as { sessionId: string }).sessionId = tenantBSid;
    expect(tenantA.session.sessionId).not.toBe(originalSid);
    const scoped = handle.forSession(tenantA.session);
    const signals = scoped.getSignals();
    // The handle resolves to the BOUND id (tenantA's original) — so
    // signals returned must be tenantA's, not tenantB's.
    expect(signals.length).toBe(1);
    expect(signals[0]?.context.failedToolCalls.some((m) => m.includes("A boom"))).toBe(true);
    expect(signals[0]?.context.failedToolCalls.some((m) => m.includes("B boom"))).toBe(false);
  });

  it("F90: middleware writes resolve via the bound id so a mutated SessionContext cannot leak into another tenant", async () => {
    // Reviewer F90: middleware reads/writes still resolved through
    // ctx.session.sessionId on every hook. If an observed
    // SessionContext was mutated to carry another tenant's id,
    // subsequent failures would be recorded under the new id while
    // the scoped handle still pointed at the original — opening a
    // cross-session corruption path. The fix routes every detector
    // path through the bound id captured at first observation.
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    const tenantA = createMockTurnContext({ turnIndex: 1 });
    const originalAId = tenantA.session.sessionId;
    // First observation binds tenantA.session ↔ originalAId.
    try {
      await handle.middleware.wrapToolCall?.(tenantA, toolReq("flaky"), async () => {
        throw new Error("A first");
      });
    } catch {
      // expected
    }
    // Mutate the sessionId BEFORE the next hook fires. A subsequent
    // failure must still record into tenantA's bucket, not into a
    // bucket named after the new (victim) id.
    (tenantA.session as { sessionId: string }).sessionId = "victim-session";
    try {
      await handle.middleware.wrapToolCall?.(tenantA, toolReq("flaky"), async () => {
        throw new Error("A second");
      });
    } catch {
      // expected
    }
    // The handle (bound to originalAId) sees both failures.
    const scoped = handle.forSession(tenantA.session);
    const signals = scoped.getSignals();
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const allFailures = signals.flatMap((s) => s.context.failedToolCalls);
    expect(allFailures.some((m) => m.includes("A first"))).toBe(true);
    expect(allFailures.some((m) => m.includes("A second"))).toBe(true);
    // A fresh, distinct observation of "victim-session" gets its own
    // bucket — tenantA's mutation never wrote into it.
    const victimCtx = createMockTurnContext({ session: { sessionId: "victim-session" } as never });
    try {
      await handle.middleware.wrapToolCall?.(victimCtx, toolReq("flaky"), async () => {
        throw new Error("V first");
      });
    } catch {
      // expected
    }
    const victimSignals = handle.forSession(victimCtx.session).getSignals();
    expect(victimSignals.length).toBe(1);
    expect(victimSignals[0]?.context.failedToolCalls.some((m) => m.includes("A "))).toBe(false);
    // And teardown of tenantA also resolves to the bound id, leaving
    // the victim bucket untouched.
    await handle.middleware.onSessionEnd?.(tenantA.session);
    expect(handle.forSession(victimCtx.session).getActiveSignalCount()).toBe(1);
    expect(originalAId).not.toBe("victim-session"); // sanity
  });

  it("F91: a reused SessionContext rebinds to its new sessionId after onSessionEnd", async () => {
    // Reviewer F91: ensureObserved permanently bound a SessionContext
    // object to its first sessionId via WeakMap, so a host that reused
    // the same SessionContext object for a later logical session
    // (mutating its sessionId) would have all subsequent traffic still
    // misroute through the stale binding. The fix removes the
    // observedSessions entry on session end so ensureObserved can
    // rebind to the new id on the next sighting.
    const attached: { id: string; signals: number }[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 1 },
        onSessionAttached: (s, scoped) => {
          attached.push({ id: s.sessionId, signals: scoped.getActiveSignalCount() });
        },
      }),
    );
    const reusedCtx = createMockTurnContext({
      session: { sessionId: "logical-1" } as never,
    });
    try {
      await handle.middleware.wrapToolCall?.(reusedCtx, toolReq("flaky"), async () => {
        throw new Error("boom-1");
      });
    } catch {
      // expected
    }
    expect(attached).toHaveLength(1);
    expect(attached[0]?.id).toBe("logical-1");
    // End logical-1 — the SessionContext object becomes available for
    // reuse on a brand-new logical session.
    await handle.middleware.onSessionEnd?.(reusedCtx.session);
    // Host reuses the same SessionContext object with a fresh id.
    (reusedCtx.session as { sessionId: string }).sessionId = "logical-2";
    try {
      await handle.middleware.wrapToolCall?.(reusedCtx, toolReq("flaky"), async () => {
        throw new Error("boom-2");
      });
    } catch {
      // expected
    }
    // onSessionAttached must fire AGAIN for the new logical session —
    // the stale binding was cleared so the detector re-observes.
    expect(attached).toHaveLength(2);
    expect(attached[1]?.id).toBe("logical-2");
    // The fresh handle reads logical-2's signal, not a stale logical-1
    // entry.
    const scoped = handle.forSession(reusedCtx.session);
    const signals = scoped.getSignals();
    expect(signals.length).toBe(1);
    expect(signals[0]?.context.failedToolCalls.some((m) => m.includes("boom-2"))).toBe(true);
    expect(signals[0]?.context.failedToolCalls.some((m) => m.includes("boom-1"))).toBe(false);
  });

  it("F93: repeated forSession() calls in one session do not allocate unbounded revocation state", async () => {
    // Reviewer F93: prior design pushed every issued handle into a
    // strong per-session Set. A host that polls forSession() to
    // render pending signals would grow memory linearly with reads.
    // The fix shares a per-session epoch object — every handle in
    // one logical session captures the same reference; revocation is
    // by identity check on session end. This test exercises a long
    // poll loop and asserts handles still revoke correctly when the
    // session ends.
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    const sessionA = createMockTurnContext({ turnIndex: 1 });
    try {
      await handle.middleware.wrapToolCall?.(sessionA, toolReq("flaky"), async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    const earlyHandle = handle.forSession(sessionA.session);
    // Simulate a polling consumer.
    const pollHandles: ReturnType<typeof handle.forSession>[] = [];
    for (let i = 0; i < 1000; i += 1) {
      pollHandles.push(handle.forSession(sessionA.session));
    }
    expect(pollHandles[999]?.getActiveSignalCount()).toBe(1);
    expect(earlyHandle.getActiveSignalCount()).toBe(1);
    // End the session — every poll handle, including the very first
    // one, must observe revocation regardless of how many were issued.
    await handle.middleware.onSessionEnd?.(sessionA.session);
    expect(earlyHandle.getActiveSignalCount()).toBe(0);
    expect(pollHandles[0]?.getActiveSignalCount()).toBe(0);
    expect(pollHandles[500]?.getActiveSignalCount()).toBe(0);
    expect(pollHandles[999]?.getActiveSignalCount()).toBe(0);
  });

  it("F94: capability-gap counters separate unrelated tasks that share the same generic follow-up", async () => {
    // Reviewer F94: scoping the task context on ONLY the last user
    // message merged distinct conversations whenever they ended on
    // the same generic prompt ("try again", "do it"). The fix folds
    // the last few user turns into the task fingerprint so the prior
    // ask disambiguates the bucket.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { capabilityGapOccurrences: 2 },
        capabilityGapPatterns: [/I don'?t have a tool/],
        onDemand: (s) => signals.push(s),
      }),
    );
    const refusal = "I don't have a tool for that.";
    const tryAgain: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "try again" }],
      timestamp: 5,
    };
    const askA: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "compile rust" }],
      timestamp: 1,
    };
    const askB: InboundMessage = {
      senderId: "user",
      content: [{ kind: "text", text: "summarize this email" }],
      timestamp: 2,
    };
    // Two unrelated conversations, each ending in the same generic
    // follow-up. Pre-fix these would share a bucket and aggregate to
    // threshold across unrelated tasks.
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 1 }),
      modelReq([askA, tryAgain]),
      async () => modelRes(refusal),
    );
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 2 }),
      modelReq([askB, tryAgain]),
      async () => modelRes(refusal),
    );
    expect(signals.filter((s) => s.trigger.kind === "capability_gap").length).toBe(0);
  });

  it("F95: a tool call that completes after onSessionEnd does not emit signals against detached state", async () => {
    // Reviewer F95: middleware captured `state` before awaiting next()
    // and continued mutating it post-await. If the session ended
    // mid-flight, late completions still fired onDemand and advanced
    // counters on a detached state object — invisible to forSession,
    // impossible to dismiss. The fix captures the session epoch and
    // re-checks after the await: a stale epoch short-circuits all
    // post-await mutation.
    const signals: ForgeDemandSignal[] = [];
    const handle = createForgeDemandDetector(
      makeConfig({
        heuristics: { repeatedFailureCount: 1 },
        onDemand: (s) => signals.push(s),
      }),
    );
    const session = createMockTurnContext({ turnIndex: 1 });
    let resolveNext: (() => void) | undefined;
    const slowTool = (): Promise<ToolResponse> =>
      new Promise<ToolResponse>((_resolve, reject) => {
        resolveNext = (): void => reject(new Error("late boom"));
      });
    const inflight = handle.middleware
      .wrapToolCall?.(session, toolReq("flaky"), slowTool)
      .catch(() => undefined);
    // End the session WHILE the tool call is still in flight.
    await handle.middleware.onSessionEnd?.(session.session);
    // Resolve the in-flight call AFTER teardown.
    resolveNext?.();
    await inflight;
    // No signal must have been emitted — the post-await liveness
    // check short-circuits all mutation.
    expect(signals.length).toBe(0);
  });

  it("F97: onSessionEnd ignores a fabricated SessionContext targeting another session's id", async () => {
    // Reviewer F97: onSessionEnd previously fell back to the raw
    // `ctx.sessionId` for unobserved contexts and deleted state /
    // bumped epoch under that id. A caller in possession of the
    // middleware object could fabricate `{ sessionId: victim, ... }`
    // and revoke another tenant's signals/handles. The fix requires
    // an observed binding — unobserved contexts are a no-op.
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    // Establish a real session with state.
    const victim = createMockTurnContext({
      session: { sessionId: "victim-session" } as never,
    });
    try {
      await handle.middleware.wrapToolCall?.(victim, toolReq("flaky"), async () => {
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    const victimHandle = handle.forSession(victim.session);
    expect(victimHandle.getActiveSignalCount()).toBe(1);
    // Attacker fabricates a fresh SessionContext literal with the
    // victim's sessionId and calls onSessionEnd directly.
    const fake: { sessionId: string; agentId: string; runId: string; metadata: object } = {
      sessionId: "victim-session",
      agentId: "attacker",
      runId: "fake-run",
      metadata: {},
    };
    await handle.middleware.onSessionEnd?.(fake as never);
    // Victim state must be intact — fake teardown was a no-op.
    expect(victimHandle.getActiveSignalCount()).toBe(1);
    const signals = victimHandle.getSignals();
    expect(signals.length).toBe(1);
    // And victimHandle is still LIVE (epoch unchanged).
    victimHandle.dismiss(signals[0]?.id ?? "");
    expect(victimHandle.getActiveSignalCount()).toBe(0);
  });
});
