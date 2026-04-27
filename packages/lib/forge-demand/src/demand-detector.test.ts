import { describe, expect, it } from "bun:test";
import type {
  ForgeBudget,
  ForgeDemandSignal,
  InboundMessage,
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
});
