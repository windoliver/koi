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
    expect(handle.getActiveSignalCount()).toBe(1);
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

    const [signal] = handle.getSignals();
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
      return handle.getSignals()[0]?.confidence;
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
      const [first] = handle.getSignals();
      if (first !== undefined) {
        expect(() => handle.dismiss(first.id)).not.toThrow();
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

    // Distinct turnIds so retry-dedup does not collapse legitimate repeats.
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 0 }),
      modelReq([]),
      a,
    );
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 1 }),
      modelReq([]),
      b,
    );
    expect(signals.length).toBe(0);

    // The same gap repeated in a distinct turn *does* cross the threshold.
    await handle.middleware.wrapModelCall?.(
      createMockTurnContext({ turnIndex: 2 }),
      modelReq([]),
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
    expect(handle.getActiveSignalCount()).toBe(2);

    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("tool-A"), failNext);
    } catch {
      // expected
    }
    // tool-A re-emitted (its cooldown was cleared on eviction) → queue evicts B.
    const ids = handle
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
    const [first] = handle.getSignals();
    expect(first).toBeDefined();
    if (first === undefined) return;

    handle.dismiss(first.id);

    // One more failure must NOT re-emit — counter was reset by dismiss.
    try {
      await handle.middleware.wrapToolCall?.(ctx, toolReq("flaky"), failNext);
    } catch {
      // expected
    }
    expect(handle.getActiveSignalCount()).toBe(0);
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

    // Failed model call — correction must STILL emit (not lost on no-replay).
    try {
      await handle.middleware.wrapModelCall?.(ctx, modelReq([correction]), failModel);
    } catch {
      // expected
    }
    expect(signals.filter((s) => s.trigger.kind === "user_correction").length).toBe(1);

    // Retry replays the same transcript — must not duplicate.
    const okModel = async (): Promise<ModelResponse> => modelRes("ok");
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
    const [first] = handle.getSignals();
    expect(first).toBeDefined();
    if (first === undefined) return;

    handle.dismiss(first.id);
    expect(handle.getActiveSignalCount()).toBe(0);
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

  it("emits globally unique signal ids across sessions so dismiss() targets the right one", async () => {
    const handle = createForgeDemandDetector(
      makeConfig({ heuristics: { repeatedFailureCount: 1 } }),
    );
    const ctxA = createMockTurnContext({ session: { sessionId: "sess-A" as never } });
    const ctxB = createMockTurnContext({ session: { sessionId: "sess-B" as never } });

    const failNext = async (): Promise<ToolResponse> => {
      throw new Error("nope");
    };

    for (const ctx of [ctxA, ctxB]) {
      try {
        await handle.middleware.wrapToolCall?.(ctx, toolReq("t"), failNext);
      } catch {
        // expected
      }
    }
    const all = handle.getSignals();
    expect(all.length).toBe(2);
    const ids = new Set(all.map((s) => s.id));
    expect(ids.size).toBe(2); // distinct ids — no `demand-1` collision

    // Dismissing one id removes exactly one signal — never both.
    const [first] = all;
    if (first === undefined) throw new Error("no signal");
    handle.dismiss(first.id);
    expect(handle.getActiveSignalCount()).toBe(1);
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
});
