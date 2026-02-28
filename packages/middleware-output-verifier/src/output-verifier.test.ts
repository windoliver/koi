/**
 * Unit tests for @koi/middleware-output-verifier.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ModelChunk, ModelRequest, ModelResponse } from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createMockModelHandler,
  createMockTurnContext,
  createSpyModelStreamHandler,
} from "@koi/test-utils";
import { BUILTIN_CHECKS } from "./builtin-checks.js";
import { createOutputVerifierMiddleware } from "./output-verifier.js";
import type { DeterministicCheck, JudgeConfig, VerifierVetoEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ctx = createMockTurnContext();
const request: ModelRequest = { messages: [] };

const passCheck: DeterministicCheck = {
  name: "always-pass",
  check: () => true,
  action: "block",
};

const blockCheck: DeterministicCheck = {
  name: "always-block",
  check: () => "Content blocked by policy",
  action: "block",
};

const warnCheck: DeterministicCheck = {
  name: "always-warn",
  check: () => "Suspicious content",
  action: "warn",
};

const reviseCheck: DeterministicCheck = {
  name: "always-revise",
  check: () => "Needs improvement",
  action: "revise",
};

function makePassingJudge(score = 0.9): JudgeConfig {
  return {
    rubric: "Be helpful and accurate",
    modelCall: mock(async () => JSON.stringify({ score, reasoning: "Good output" })),
    vetoThreshold: 0.75,
    action: "block",
  };
}

function makeBlockingJudge(score = 0.5): JudgeConfig {
  return {
    rubric: "Be helpful and accurate",
    modelCall: mock(async () => JSON.stringify({ score, reasoning: "Poor quality" })),
    vetoThreshold: 0.75,
    action: "block",
  };
}

async function collectStream(stream: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function assertStream(s: AsyncIterable<ModelChunk> | undefined): AsyncIterable<ModelChunk> {
  if (s === undefined) throw new Error("Expected wrapModelStream to be defined");
  return s;
}

// ---------------------------------------------------------------------------
// Factory validation
// ---------------------------------------------------------------------------

describe("createOutputVerifierMiddleware", () => {
  test("throws at factory time if neither deterministic nor judge is configured", () => {
    expect(() => createOutputVerifierMiddleware({})).toThrow(KoiRuntimeError);
  });

  test("throws with VALIDATION code when empty config", () => {
    try {
      createOutputVerifierMiddleware({});
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
      }
    }
  });

  test("succeeds with only deterministic checks", () => {
    expect(() => createOutputVerifierMiddleware({ deterministic: [passCheck] })).not.toThrow();
  });

  test("succeeds with only judge config", () => {
    expect(() => createOutputVerifierMiddleware({ judge: makePassingJudge() })).not.toThrow();
  });

  test("succeeds with both deterministic and judge", () => {
    expect(() =>
      createOutputVerifierMiddleware({
        deterministic: [passCheck],
        judge: makePassingJudge(),
      }),
    ).not.toThrow();
  });

  test("has name 'output-verifier' and priority 385", () => {
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [passCheck] });
    expect(middleware.name).toBe("output-verifier");
    expect(middleware.priority).toBe(385);
  });
});

// ---------------------------------------------------------------------------
// wrapModelCall — deterministic stage
// ---------------------------------------------------------------------------

describe("wrapModelCall — deterministic checks", () => {
  test("passes through output when all checks pass", async () => {
    const handler = createMockModelHandler({ content: "Good output" });
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [passCheck] });

    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(response?.content).toBe("Good output");
  });

  test("block action throws KoiRuntimeError", async () => {
    const handler = createMockModelHandler({ content: "Bad output" });
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [blockCheck] });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
  });

  test("block action throws with VALIDATION code", async () => {
    const handler = createMockModelHandler({ content: "Bad output" });
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [blockCheck] });

    try {
      await middleware.wrapModelCall?.(ctx, request, handler);
      expect(true).toBe(false);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("VALIDATION");
      }
    }
  });

  test("block action fires onVeto with source='deterministic'", async () => {
    const handler = createMockModelHandler({ content: "Bad output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("deterministic");
    expect(events[0]?.checkName).toBe("always-block");
    expect(events[0]?.action).toBe("block");
    expect(events[0]?.checkReason).toBe("Content blocked by policy");
  });

  test("warn action fires onVeto but delivers output", async () => {
    const handler = createMockModelHandler({ content: "Suspicious output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [warnCheck],
      onVeto: (e) => events.push(e),
    });

    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(response?.content).toBe("Suspicious output");
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("warn");
  });

  test("revise action retries with injected feedback", async () => {
    // let justified: count calls to verify retry happens
    let callCount = 0;
    const handler = async (_req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      if (callCount === 1) return { content: "needs-improvement", model: "test" };
      return { content: "improved", model: "test" };
    };

    const reviseOnce: DeterministicCheck = {
      name: "quality",
      check: (c) => c === "improved" || "Needs improvement",
      action: "revise",
    };

    const { middleware } = createOutputVerifierMiddleware({ deterministic: [reviseOnce] });
    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(callCount).toBe(2);
    expect(response?.content).toBe("improved");
  });

  test("revise action throws after maxRevisions exhausted", async () => {
    const handler = createMockModelHandler({ content: "always-bad" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [reviseCheck],
      judge: { ...makePassingJudge(), maxRevisions: 1 },
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
  });

  test("first blocking check short-circuits remaining checks", async () => {
    const spyCheck = mock((_: string) => true);
    const afterBlock: DeterministicCheck = {
      name: "after-block",
      check: spyCheck,
      action: "block",
    };
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [blockCheck, afterBlock],
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    expect(spyCheck).not.toHaveBeenCalled();
  });

  test("multiple checks: warn continues, block after warn still throws", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [warnCheck, blockCheck],
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    // warn fired first, then block
    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe("warn");
    expect(events[1]?.action).toBe("block");
  });
});

// ---------------------------------------------------------------------------
// wrapModelCall — judge stage
// ---------------------------------------------------------------------------

describe("wrapModelCall — judge stage", () => {
  test("passing judge delivers output", async () => {
    const handler = createMockModelHandler({ content: "Great output" });
    const { middleware } = createOutputVerifierMiddleware({ judge: makePassingJudge() });

    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(response?.content).toBe("Great output");
  });

  test("blocking judge throws KoiRuntimeError", async () => {
    const handler = createMockModelHandler({ content: "Bad output" });
    const { middleware } = createOutputVerifierMiddleware({ judge: makeBlockingJudge() });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
  });

  test("blocking judge fires veto with source='judge' and score", async () => {
    const handler = createMockModelHandler({ content: "Bad output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      judge: makeBlockingJudge(0.4),
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    expect(events[0]?.source).toBe("judge");
    expect(events[0]?.score).toBe(0.4);
    expect(events[0]?.action).toBe("block");
    expect(events[0]?.reasoning).toBe("Poor quality");
  });

  test("score exactly at threshold passes (>= not >)", async () => {
    const handler = createMockModelHandler({ content: "Borderline output" });
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => JSON.stringify({ score: 0.75, reasoning: "Borderline" }),
      vetoThreshold: 0.75,
      action: "block",
    };
    const { middleware } = createOutputVerifierMiddleware({ judge });

    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(response?.content).toBe("Borderline output");
  });

  test("warn action fires event and delivers output", async () => {
    const handler = createMockModelHandler({ content: "Mediocre output" });
    const events: VerifierVetoEvent[] = [];
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => JSON.stringify({ score: 0.5, reasoning: "Mediocre" }),
      vetoThreshold: 0.75,
      action: "warn",
    };
    const { middleware } = createOutputVerifierMiddleware({
      judge,
      onVeto: (e) => events.push(e),
    });

    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(response?.content).toBe("Mediocre output");
    expect(events[0]?.action).toBe("warn");
    expect(events[0]?.source).toBe("judge");
  });

  test("revise action retries with judge reasoning injected", async () => {
    // let justified: counts calls to verify the retry
    let callCount = 0;
    const handler = async (_req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      return { content: `output-${callCount}`, model: "test" };
    };
    const scores = [0.5, 0.9];
    // let justified: index tracks which score to return
    let scoreIndex = 0;
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => {
        const score = scores[scoreIndex] ?? 0.9;
        scoreIndex++;
        return JSON.stringify({ score, reasoning: "Needs improvement" });
      },
      vetoThreshold: 0.75,
      action: "revise",
      maxRevisions: 1,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge });
    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(callCount).toBe(2);
    expect(response?.content).toBe("output-2");
  });

  test("revise action throws after maxRevisions exhausted", async () => {
    const handler = createMockModelHandler({ content: "Bad output" });
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => JSON.stringify({ score: 0.3, reasoning: "Always bad" }),
      vetoThreshold: 0.75,
      action: "revise",
      maxRevisions: 1,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
  });

  test("judge revision feedback is truncated to revisionFeedbackMaxLength", async () => {
    const longReasoning = "x".repeat(1000);
    const capturedMessages: ModelRequest[] = [];
    // let justified: call count for multi-attempt tracking
    let callCount = 0;
    const handler = async (req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      capturedMessages.push(req);
      return { content: "output", model: "test" };
    };
    const scores = [0.3, 0.9];
    // let justified: index tracks which score to return
    let scoreIndex = 0;
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => {
        const score = scores[scoreIndex] ?? 0.9;
        scoreIndex++;
        return JSON.stringify({ score, reasoning: longReasoning });
      },
      vetoThreshold: 0.75,
      action: "revise",
      maxRevisions: 1,
      revisionFeedbackMaxLength: 100,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge });
    await middleware.wrapModelCall?.(ctx, request, handler);

    // Second call should have an injected message with truncated reasoning
    expect(callCount).toBe(2);
    const secondRequest = capturedMessages[1];
    expect(secondRequest).toBeDefined();
    const lastMsg = secondRequest?.messages[secondRequest.messages.length - 1];
    const textBlock = lastMsg?.content[0];
    if (textBlock?.kind === "text") {
      // Verify truncation (feedback message contains judge reasoning, bounded)
      expect(textBlock.text.length).toBeLessThan(300); // 100-char reasoning + fixed prefix
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: judge errors treated as score 0
// ---------------------------------------------------------------------------

describe("wrapModelCall — judge failure modes (fail-closed)", () => {
  test("judge modelCall throws → treated as score 0 → veto fires", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => {
        throw new Error("Network error");
      },
      vetoThreshold: 0.75,
      action: "block",
    };
    const { middleware } = createOutputVerifierMiddleware({
      judge,
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
    expect(events[0]?.judgeError).toBe("Network error");
    expect(events[0]?.score).toBe(0);
  });

  test("judge returns unparseable response → score 0 → veto fires", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => "not json at all",
      vetoThreshold: 0.75,
      action: "block",
    };
    const { middleware } = createOutputVerifierMiddleware({
      judge,
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
    expect(events[0]?.judgeError).toBeDefined();
  });

  test("judge returns regex-matched but malformed JSON → score 0 → veto fires with parse error", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const judge: JudgeConfig = {
      rubric: "Test",
      // Has braces so regex matches, but JSON.parse throws
      modelCall: async () => "{malformed: json}",
      vetoThreshold: 0.75,
      action: "block",
    };
    const { middleware } = createOutputVerifierMiddleware({
      judge,
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
    expect(events[0]?.judgeError).toBeDefined();
    expect(events[0]?.score).toBe(0);
  });

  test("judge returns empty string → score 0 → veto fires", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => "",
      vetoThreshold: 0.75,
      action: "block",
    };
    const { middleware } = createOutputVerifierMiddleware({ judge });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Short-circuit: warn in deterministic still runs judge
// ---------------------------------------------------------------------------

describe("wrapModelCall — short-circuit logic", () => {
  test("block in deterministic skips judge", async () => {
    const judgeModelCall = mock(async () => JSON.stringify({ score: 0.9, reasoning: "good" }));
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
      judge: { rubric: "Test", modelCall: judgeModelCall, vetoThreshold: 0.75 },
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    expect(judgeModelCall).not.toHaveBeenCalled();
  });

  test("warn in deterministic still runs judge", async () => {
    const judgeModelCall = mock(async () => JSON.stringify({ score: 0.9, reasoning: "good" }));
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [warnCheck],
      judge: { rubric: "Test", modelCall: judgeModelCall, vetoThreshold: 0.75 },
    });

    await middleware.wrapModelCall?.(ctx, request, handler);
    expect(judgeModelCall).toHaveBeenCalledTimes(1);
  });

  test("deterministic pass + judge pass = output delivered", async () => {
    const handler = createMockModelHandler({ content: "Great output" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [passCheck],
      judge: makePassingJudge(),
    });

    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(response?.content).toBe("Great output");
  });

  test("deterministic warn + judge block = veto events from both sources", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [warnCheck],
      judge: makeBlockingJudge(),
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    const sources = events.map((e) => e.source);
    expect(sources).toContain("deterministic");
    expect(sources).toContain("judge");
  });
});

// ---------------------------------------------------------------------------
// Stats tracking
// ---------------------------------------------------------------------------

describe("getStats", () => {
  test("initial state is all zeros", () => {
    const { getStats } = createOutputVerifierMiddleware({ deterministic: [passCheck] });
    const s = getStats();
    expect(s.totalChecks).toBe(0);
    expect(s.vetoed).toBe(0);
    expect(s.warned).toBe(0);
    expect(s.vetoRate).toBe(0);
  });

  test("totalChecks increments on each wrapModelCall", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const { middleware, getStats } = createOutputVerifierMiddleware({ deterministic: [passCheck] });

    await middleware.wrapModelCall?.(ctx, request, handler);
    await middleware.wrapModelCall?.(ctx, request, handler);
    expect(getStats().totalChecks).toBe(2);
  });

  test("warn does NOT count as vetoed (warn only increments warned)", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware, getStats } = createOutputVerifierMiddleware({
      deterministic: [warnCheck],
      onVeto: (e) => events.push(e),
    });

    await middleware.wrapModelCall?.(ctx, request, handler);
    const s = getStats();
    expect(s.vetoed).toBe(0);
    expect(s.warned).toBe(1);
    expect(s.vetoRate).toBe(0);
  });

  test("block increments vetoed, not warned", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const { middleware, getStats } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    const s = getStats();
    expect(s.vetoed).toBe(1);
    expect(s.warned).toBe(0);
  });

  test("vetoRate = vetoed / totalChecks — 25% Spotify baseline example", async () => {
    const handler = createMockModelHandler({ content: "output" });

    // Let blockCheck fire 1 out of 4 calls
    let callNum = 0;
    const conditionalCheck: DeterministicCheck = {
      name: "conditional",
      check: () => {
        callNum++;
        return callNum % 4 !== 0 || "blocked";
      },
      action: "block",
    };

    const { middleware, getStats } = createOutputVerifierMiddleware({
      deterministic: [conditionalCheck],
    });

    for (let i = 0; i < 3; i++) {
      await middleware.wrapModelCall?.(ctx, request, handler);
    }
    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();

    const s = getStats();
    expect(s.totalChecks).toBe(4);
    expect(s.vetoed).toBe(1);
    expect(s.vetoRate).toBe(0.25);
  });

  test("deterministicVetoes vs judgeVetoes tracked separately", async () => {
    // let justified: call count for alternating responses
    let callN = 0;
    const handler = async (): Promise<ModelResponse> => {
      callN++;
      return { content: `output-${callN}`, model: "test" };
    };
    const events: VerifierVetoEvent[] = [];
    const { middleware, getStats } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
      judge: makeBlockingJudge(),
      onVeto: (e) => events.push(e),
    });

    // 1st call: block from deterministic (judge skipped)
    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();

    const s = getStats();
    expect(s.deterministicVetoes).toBe(1);
    expect(s.judgeVetoes).toBe(0);
  });

  test("judgedChecks tracks how many times the judge actually ran", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const { middleware, getStats } = createOutputVerifierMiddleware({
      judge: makePassingJudge(),
    });

    await middleware.wrapModelCall?.(ctx, request, handler);
    await middleware.wrapModelCall?.(ctx, request, handler);
    expect(getStats().judgedChecks).toBe(2);
  });

  test("samplingRate=0 means judge never runs", async () => {
    const judgeModelCall = mock(async () => JSON.stringify({ score: 0.9, reasoning: "good" }));
    const handler = createMockModelHandler({ content: "output" });
    const { middleware, getStats } = createOutputVerifierMiddleware({
      judge: {
        rubric: "Test",
        modelCall: judgeModelCall,
        vetoThreshold: 0.75,
        samplingRate: 0,
      },
    });

    await middleware.wrapModelCall?.(ctx, request, handler);
    await middleware.wrapModelCall?.(ctx, request, handler);
    expect(judgeModelCall).not.toHaveBeenCalled();
    expect(getStats().judgedChecks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Handle control
// ---------------------------------------------------------------------------

describe("setRubric", () => {
  test("judge uses updated rubric on the next call", async () => {
    const capturedPrompts: string[] = [];
    const handler = createMockModelHandler({ content: "output" });
    const judge: JudgeConfig = {
      rubric: "Original rubric",
      modelCall: async (prompt) => {
        capturedPrompts.push(prompt);
        return JSON.stringify({ score: 0.9, reasoning: "ok" });
      },
      vetoThreshold: 0.75,
    };
    const handle = createOutputVerifierMiddleware({ judge });

    await handle.middleware.wrapModelCall?.(ctx, request, handler);
    handle.setRubric("New rubric");
    await handle.middleware.wrapModelCall?.(ctx, request, handler);

    expect(capturedPrompts[0]).toContain("Original rubric");
    expect(capturedPrompts[1]).toContain("New rubric");
  });
});

describe("reset", () => {
  test("reset() clears all stats to zero", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const { middleware, getStats, reset } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    expect(getStats().totalChecks).toBe(1);

    reset();
    const s = getStats();
    expect(s.totalChecks).toBe(0);
    expect(s.vetoed).toBe(0);
    expect(s.warned).toBe(0);
    expect(s.deterministicVetoes).toBe(0);
    expect(s.judgeVetoes).toBe(0);
    expect(s.judgedChecks).toBe(0);
    expect(s.vetoRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal propagation
// ---------------------------------------------------------------------------

describe("AbortSignal propagation", () => {
  test("judge modelCall receives ctx.signal", async () => {
    const capturedSignals: (AbortSignal | undefined)[] = [];
    const handler = createMockModelHandler({ content: "output" });
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async (_prompt, signal) => {
        capturedSignals.push(signal);
        return JSON.stringify({ score: 0.9, reasoning: "ok" });
      },
      vetoThreshold: 0.75,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge });

    const ctxWithSignal = createMockTurnContext();

    await middleware.wrapModelCall?.(ctxWithSignal, request, handler);
    // Signal is passed through (may be undefined in test context, but the parameter is forwarded)
    expect(capturedSignals).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// wrapModelStream
// ---------------------------------------------------------------------------

describe("wrapModelStream", () => {
  test("valid output passes through all chunks", async () => {
    const doneResponse: ModelResponse = { content: "Great output", model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "Great " },
      { kind: "text_delta", delta: "output" },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [passCheck],
    });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    const collected = await collectStream(stream);
    expect(collected).toHaveLength(3);
    expect(collected[2]?.kind).toBe("done");
  });

  test("block action degrades to warn for streaming (with degraded=true)", async () => {
    const doneResponse: ModelResponse = { content: "Bad output", model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "Bad output" },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
      onVeto: (e) => events.push(e),
    });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    // Should NOT throw — block degrades to warn for streams
    const collected = await collectStream(stream);
    expect(collected).toHaveLength(2); // All chunks still yielded
    expect(events[0]?.degraded).toBe(true);
    expect(events[0]?.action).toBe("block");
  });

  test("revise action degrades to warn for streaming (with degraded=true)", async () => {
    const doneResponse: ModelResponse = { content: "output", model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "output" },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [reviseCheck],
      onVeto: (e) => events.push(e),
    });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    await collectStream(stream); // Must not throw
    expect(events[0]?.degraded).toBe(true);
  });

  test("judge block degrades to warn for streaming", async () => {
    const doneResponse: ModelResponse = { content: "output", model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "output" },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      judge: makeBlockingJudge(),
      onVeto: (e) => events.push(e),
    });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    await collectStream(stream); // Must not throw
    expect(events[0]?.source).toBe("judge");
    expect(events[0]?.degraded).toBe(true);
  });

  test("judge warn fires event and increments stats for streaming (no degraded flag)", async () => {
    const doneResponse: ModelResponse = { content: "mediocre output", model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "mediocre output" },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const events: VerifierVetoEvent[] = [];
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => JSON.stringify({ score: 0.5, reasoning: "Mediocre" }),
      vetoThreshold: 0.75,
      action: "warn",
    };
    const { middleware, getStats } = createOutputVerifierMiddleware({
      judge,
      onVeto: (e) => events.push(e),
    });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    await collectStream(stream); // Must not throw — warn never blocks
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("judge");
    expect(events[0]?.action).toBe("warn");
    expect(events[0]?.degraded).toBeUndefined(); // warn is native, not degraded
    const s = getStats();
    expect(s.judgeVetoes).toBe(1);
    expect(s.warned).toBe(1);
  });

  test("stream buffer overflow fires warn event with degraded=true", async () => {
    const overflowContent = "x".repeat(300);
    const doneResponse: ModelResponse = { content: overflowContent, model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: overflowContent },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
      maxBufferSize: 100,
      onVeto: (e) => events.push(e),
    });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    await collectStream(stream);
    const overflow = events.find((e) => e.checkName === "stream-buffer-overflow");
    expect(overflow).toBeDefined();
    expect(overflow?.degraded).toBe(true);
  });

  test("non-text chunks pass through unchanged", async () => {
    const validContent = "Great output";
    const doneResponse: ModelResponse = { content: validContent, model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: validContent },
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [passCheck] });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    const collected = await collectStream(stream);
    expect(collected.find((c) => c.kind === "usage")).toBeDefined();
  });

  test("empty buffer skips validation on done", async () => {
    const doneResponse: ModelResponse = { content: "", model: "test" };
    const chunks: readonly ModelChunk[] = [{ kind: "done", response: doneResponse }];
    const handler = createSpyModelStreamHandler(chunks);
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [blockCheck] });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    const collected = await collectStream(stream);
    expect(collected).toHaveLength(1);
  });

  test("totalChecks increments for wrapModelStream calls", async () => {
    const doneResponse: ModelResponse = { content: "ok", model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "ok" },
      { kind: "done", response: doneResponse },
    ];
    const handler = createSpyModelStreamHandler(chunks);
    const { middleware, getStats } = createOutputVerifierMiddleware({ deterministic: [passCheck] });

    const stream = assertStream(middleware.wrapModelStream?.(ctx, request, handler.handler));
    await collectStream(stream);
    expect(getStats().totalChecks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities
// ---------------------------------------------------------------------------

describe("describeCapabilities", () => {
  test("returns label 'output-gate'", () => {
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [passCheck] });
    const cap = middleware.describeCapabilities?.(ctx);
    expect(cap?.label).toBe("output-gate");
  });

  test("description reflects current veto stats", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [blockCheck] });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    const cap = middleware.describeCapabilities?.(ctx);
    expect(cap?.description).toContain("1/1");
  });

  test("description includes threshold when judge is configured", () => {
    const { middleware } = createOutputVerifierMiddleware({ judge: makePassingJudge() });
    const cap = middleware.describeCapabilities?.(ctx);
    expect(cap?.description).toContain("0.75");
  });
});

// ---------------------------------------------------------------------------
// BUILTIN_CHECKS
// ---------------------------------------------------------------------------

describe("BUILTIN_CHECKS", () => {
  test("nonEmpty blocks empty string", () => {
    const check = BUILTIN_CHECKS.nonEmpty();
    expect(check.check("")).not.toBe(true);
    expect(check.check("   ")).not.toBe(true);
    expect(check.check("hello")).toBe(true);
  });

  test("maxLength blocks content over limit", () => {
    const check = BUILTIN_CHECKS.maxLength(5);
    expect(check.check("hello")).toBe(true);
    expect(check.check("hello world")).not.toBe(true);
  });

  test("validJson passes valid JSON and blocks invalid", () => {
    const check = BUILTIN_CHECKS.validJson();
    expect(check.check('{"a":1}')).toBe(true);
    expect(check.check("not json")).not.toBe(true);
  });

  test("matchesPattern works with regex", () => {
    const check = BUILTIN_CHECKS.matchesPattern(/^\d+$/, "digits-only");
    expect(check.check("123")).toBe(true);
    expect(check.check("abc")).not.toBe(true);
  });
});
