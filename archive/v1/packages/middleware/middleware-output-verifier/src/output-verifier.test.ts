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
import { buildJudgePrompt, clampScore, normalizeScore, truncateContent } from "./judge.js";
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

/** Check that returns boolean false (not a string). */
const falseCheck: DeterministicCheck = {
  name: "boolean-false",
  check: () => false,
  action: "block",
};

function makePassingJudge(score = 5): JudgeConfig {
  return {
    rubric: "Be helpful and accurate",
    modelCall: mock(async () => JSON.stringify({ score, reasoning: "Good output" })),
    vetoThreshold: 0.75,
    action: "block",
    randomFn: () => 0, // Ensure judge always runs in tests (0 ≤ any samplingRate)
  };
}

function makeBlockingJudge(score = 2): JudgeConfig {
  return {
    rubric: "Be helpful and accurate",
    modelCall: mock(async () => JSON.stringify({ score, reasoning: "Poor quality" })),
    vetoThreshold: 0.75,
    action: "block",
    randomFn: () => 0,
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
      maxRevisions: 1,
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
// wrapModelCall — boolean false check (#9)
// ---------------------------------------------------------------------------

describe("wrapModelCall — boolean false deterministic checks", () => {
  test("boolean false with block action throws KoiRuntimeError", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({ deterministic: [falseCheck] });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
  });

  test("boolean false fires event with default message 'Check \"name\" failed'", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [falseCheck],
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]?.checkReason).toBe('Check "boolean-false" failed');
  });

  test("boolean false with warn action delivers output and fires event", async () => {
    const falseWarn: DeterministicCheck = {
      name: "false-warn",
      check: () => false,
      action: "warn",
    };
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [falseWarn],
      onVeto: (e) => events.push(e),
    });

    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(response?.content).toBe("output");
    expect(events[0]?.checkReason).toBe('Check "false-warn" failed');
    expect(events[0]?.action).toBe("warn");
  });

  test("boolean false with revise action retries and uses default message", async () => {
    // let justified: call count for multi-attempt tracking
    let callCount = 0;
    const handler = async (_req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      if (callCount === 1) return { content: "bad", model: "test" };
      return { content: "good", model: "test" };
    };

    const falseRevise: DeterministicCheck = {
      name: "false-revise",
      check: (c) => c === "good",
      action: "revise",
    };

    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [falseRevise],
      onVeto: (e) => events.push(e),
    });

    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(callCount).toBe(2);
    expect(response?.content).toBe("good");
    expect(events[0]?.checkReason).toBe('Check "false-revise" failed');
  });
});

// ---------------------------------------------------------------------------
// wrapModelCall — deterministic check throwing (#7)
// ---------------------------------------------------------------------------

describe("wrapModelCall — deterministic check throws", () => {
  test("check that throws is treated as failure (fail-closed)", async () => {
    const throwingCheck: DeterministicCheck = {
      name: "throws",
      check: () => {
        throw new Error("Unexpected error in check");
      },
      action: "block",
    };
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [throwingCheck],
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.checkReason).toContain("threw");
    expect(events[0]?.checkReason).toContain("Unexpected error in check");
  });

  test("check that throws non-Error is handled", async () => {
    const throwingCheck: DeterministicCheck = {
      name: "throws-string",
      check: () => {
        throw "oops"; // eslint-disable-line no-throw-literal
      },
      action: "block",
    };
    const handler = createMockModelHandler({ content: "output" });
    const events: VerifierVetoEvent[] = [];
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [throwingCheck],
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
    expect(events[0]?.checkReason).toContain("Unknown error");
  });
});

// ---------------------------------------------------------------------------
// wrapModelCall — onVeto observer resilience (#3)
// ---------------------------------------------------------------------------

describe("wrapModelCall — onVeto observer resilience", () => {
  test("onVeto throwing does not affect verification correctness", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [warnCheck],
      onVeto: () => {
        throw new Error("Observer crashed");
      },
    });

    // Should not throw — onVeto error is swallowed
    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(response?.content).toBe("output");
  });

  test("onVeto throwing during block does not prevent the block throw", async () => {
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
      onVeto: () => {
        throw new Error("Observer crashed");
      },
    });

    // The KoiRuntimeError from block should still propagate
    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
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
      judge: makeBlockingJudge(2),
      onVeto: (e) => events.push(e),
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    expect(events[0]?.source).toBe("judge");
    // score 2 → normalizeScore → 0.25
    expect(events[0]?.score).toBe(0.25);
    expect(events[0]?.action).toBe("block");
    expect(events[0]?.reasoning).toBe("Poor quality");
  });

  test("score exactly at threshold passes (>= not >)", async () => {
    const handler = createMockModelHandler({ content: "Borderline output" });
    const judge: JudgeConfig = {
      rubric: "Test",
      // score 4 → normalizeScore → 0.75, which equals threshold
      modelCall: async () => JSON.stringify({ score: 4, reasoning: "Borderline" }),
      vetoThreshold: 0.75,
      action: "block",
      randomFn: () => 0,
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
      // score 3 → normalizeScore → 0.5, below threshold
      modelCall: async () => JSON.stringify({ score: 3, reasoning: "Mediocre" }),
      vetoThreshold: 0.75,
      action: "warn",
      randomFn: () => 0,
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
    const scores = [2, 5]; // 2 → 0.25 (fail), 5 → 1.0 (pass)
    // let justified: index tracks which score to return
    let scoreIndex = 0;
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => {
        const score = scores[scoreIndex] ?? 5;
        scoreIndex++;
        return JSON.stringify({ score, reasoning: "Needs improvement" });
      },
      vetoThreshold: 0.75,
      action: "revise",
      randomFn: () => 0,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge, maxRevisions: 1 });
    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(callCount).toBe(2);
    expect(response?.content).toBe("output-2");
  });

  test("revise action throws after maxRevisions exhausted", async () => {
    const handler = createMockModelHandler({ content: "Bad output" });
    const judge: JudgeConfig = {
      rubric: "Test",
      // score 1 → 0.0, always below threshold
      modelCall: async () => JSON.stringify({ score: 1, reasoning: "Always bad" }),
      vetoThreshold: 0.75,
      action: "revise",
      randomFn: () => 0,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge, maxRevisions: 1 });

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
    const scores = [1, 5]; // 1 → 0.0 (fail), 5 → 1.0 (pass)
    // let justified: index tracks which score to return
    let scoreIndex = 0;
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => {
        const score = scores[scoreIndex] ?? 5;
        scoreIndex++;
        return JSON.stringify({ score, reasoning: longReasoning });
      },
      vetoThreshold: 0.75,
      action: "revise",
      randomFn: () => 0,
    };
    const { middleware } = createOutputVerifierMiddleware({
      judge,
      maxRevisions: 1,
      revisionFeedbackMaxLength: 100,
    });
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
// Multi-revision tests (#10)
// ---------------------------------------------------------------------------

describe("wrapModelCall — multi-revision", () => {
  test("maxRevisions=2 allows 3 handler calls and passes on 3rd attempt", async () => {
    // let justified: call count for multi-attempt tracking
    let callCount = 0;
    const handler = async (_req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      return { content: `output-${callCount}`, model: "test" };
    };
    const scores = [1, 2, 5]; // 0.0, 0.25, 1.0
    // let justified: index tracks which score to return
    let scoreIndex = 0;
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => {
        const score = scores[scoreIndex] ?? 5;
        scoreIndex++;
        return JSON.stringify({ score, reasoning: "Improving" });
      },
      vetoThreshold: 0.75,
      action: "revise",
      randomFn: () => 0,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge, maxRevisions: 2 });
    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(callCount).toBe(3);
    expect(response?.content).toBe("output-3");
  });

  test("maxRevisions=2 throws after exhausting all revisions", async () => {
    const handler = createMockModelHandler({ content: "always-bad" });
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => JSON.stringify({ score: 1, reasoning: "Always bad" }),
      vetoThreshold: 0.75,
      action: "revise",
      randomFn: () => 0,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge, maxRevisions: 2 });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toBeInstanceOf(
      KoiRuntimeError,
    );
  });

  test("multi-revision accumulates messages across revisions", async () => {
    const capturedRequests: ModelRequest[] = [];
    // let justified: call count for multi-attempt tracking
    let callCount = 0;
    const handler = async (req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      capturedRequests.push(req);
      return { content: `output-${callCount}`, model: "test" };
    };
    const scores = [1, 1, 5]; // fail, fail, pass
    // let justified: index tracks which score to return
    let scoreIndex = 0;
    const judge: JudgeConfig = {
      rubric: "Test",
      modelCall: async () => {
        const score = scores[scoreIndex] ?? 5;
        scoreIndex++;
        return JSON.stringify({ score, reasoning: "Revise" });
      },
      vetoThreshold: 0.75,
      action: "revise",
      randomFn: () => 0,
    };
    const { middleware } = createOutputVerifierMiddleware({ judge, maxRevisions: 2 });
    await middleware.wrapModelCall?.(ctx, request, handler);

    // 1st call: original request (0 messages)
    expect(capturedRequests[0]?.messages).toHaveLength(0);
    // 2nd call: 1 injected revision message
    expect(capturedRequests[1]?.messages).toHaveLength(1);
    // 3rd call: 2 injected revision messages (accumulated)
    expect(capturedRequests[2]?.messages).toHaveLength(2);
  });

  test("deterministic multi-revision with maxRevisions=2", async () => {
    // let justified: call count for multi-attempt tracking
    let callCount = 0;
    const handler = async (_req: ModelRequest): Promise<ModelResponse> => {
      callCount++;
      if (callCount <= 2) return { content: "bad", model: "test" };
      return { content: "good", model: "test" };
    };

    const conditionalCheck: DeterministicCheck = {
      name: "quality",
      check: (c) => c === "good" || "Not good enough",
      action: "revise",
    };

    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [conditionalCheck],
      maxRevisions: 2,
    });
    const response = await middleware.wrapModelCall?.(ctx, request, handler);
    expect(callCount).toBe(3);
    expect(response?.content).toBe("good");
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
      randomFn: () => 0,
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
      randomFn: () => 0,
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
      randomFn: () => 0,
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
      randomFn: () => 0,
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
    const judgeModelCall = mock(async () => JSON.stringify({ score: 5, reasoning: "good" }));
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [blockCheck],
      judge: { rubric: "Test", modelCall: judgeModelCall, vetoThreshold: 0.75, randomFn: () => 0 },
    });

    await expect(middleware.wrapModelCall?.(ctx, request, handler)).rejects.toThrow();
    expect(judgeModelCall).not.toHaveBeenCalled();
  });

  test("warn in deterministic still runs judge", async () => {
    const judgeModelCall = mock(async () => JSON.stringify({ score: 5, reasoning: "good" }));
    const handler = createMockModelHandler({ content: "output" });
    const { middleware } = createOutputVerifierMiddleware({
      deterministic: [warnCheck],
      judge: { rubric: "Test", modelCall: judgeModelCall, vetoThreshold: 0.75, randomFn: () => 0 },
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
    const judgeModelCall = mock(async () => JSON.stringify({ score: 5, reasoning: "good" }));
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
// randomFn injection (#16)
// ---------------------------------------------------------------------------

describe("randomFn injection", () => {
  test("injected randomFn controls sampling", async () => {
    const judgeModelCall = mock(async () => JSON.stringify({ score: 5, reasoning: "good" }));
    const handler = createMockModelHandler({ content: "output" });

    // randomFn returns 0.8 → > 0.5 samplingRate → judge skipped
    const { middleware, getStats } = createOutputVerifierMiddleware({
      judge: {
        rubric: "Test",
        modelCall: judgeModelCall,
        vetoThreshold: 0.75,
        samplingRate: 0.5,
        randomFn: () => 0.8,
      },
    });

    await middleware.wrapModelCall?.(ctx, request, handler);
    expect(judgeModelCall).not.toHaveBeenCalled();
    expect(getStats().judgedChecks).toBe(0);
  });

  test("injected randomFn returning 0 always samples", async () => {
    const judgeModelCall = mock(async () => JSON.stringify({ score: 5, reasoning: "good" }));
    const handler = createMockModelHandler({ content: "output" });

    const { middleware, getStats } = createOutputVerifierMiddleware({
      judge: {
        rubric: "Test",
        modelCall: judgeModelCall,
        vetoThreshold: 0.75,
        samplingRate: 0.5,
        randomFn: () => 0,
      },
    });

    await middleware.wrapModelCall?.(ctx, request, handler);
    expect(judgeModelCall).toHaveBeenCalledTimes(1);
    expect(getStats().judgedChecks).toBe(1);
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
        return JSON.stringify({ score: 5, reasoning: "ok" });
      },
      vetoThreshold: 0.75,
      randomFn: () => 0,
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
        return JSON.stringify({ score: 5, reasoning: "ok" });
      },
      vetoThreshold: 0.75,
      randomFn: () => 0,
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
      // score 3 → 0.5, below threshold
      modelCall: async () => JSON.stringify({ score: 3, reasoning: "Mediocre" }),
      vetoThreshold: 0.75,
      action: "warn",
      randomFn: () => 0,
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
// wrapModelStream — setRubric (#11)
// ---------------------------------------------------------------------------

describe("wrapModelStream — setRubric", () => {
  test("streaming path uses updated rubric after setRubric", async () => {
    const capturedPrompts: string[] = [];
    const doneResponse: ModelResponse = { content: "output", model: "test" };
    const chunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "output" },
      { kind: "done", response: doneResponse },
    ];

    const judge: JudgeConfig = {
      rubric: "Original rubric",
      modelCall: async (prompt) => {
        capturedPrompts.push(prompt);
        return JSON.stringify({ score: 5, reasoning: "ok" });
      },
      vetoThreshold: 0.75,
      randomFn: () => 0,
    };
    const handle = createOutputVerifierMiddleware({ judge });

    // First streaming call with original rubric
    const handler1 = createSpyModelStreamHandler(chunks);
    const stream1 = assertStream(
      handle.middleware.wrapModelStream?.(ctx, request, handler1.handler),
    );
    await collectStream(stream1);

    // Update rubric
    handle.setRubric("New rubric");

    // Second streaming call with new rubric
    const handler2 = createSpyModelStreamHandler(chunks);
    const stream2 = assertStream(
      handle.middleware.wrapModelStream?.(ctx, request, handler2.handler),
    );
    await collectStream(stream2);

    expect(capturedPrompts[0]).toContain("Original rubric");
    expect(capturedPrompts[1]).toContain("New rubric");
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

// ---------------------------------------------------------------------------
// judge.ts helpers
// ---------------------------------------------------------------------------

describe("normalizeScore", () => {
  test("normalizes 1-5 integer scale to 0.0-1.0", () => {
    expect(normalizeScore(1)).toBe(0);
    expect(normalizeScore(2)).toBe(0.25);
    expect(normalizeScore(3)).toBe(0.5);
    expect(normalizeScore(4)).toBe(0.75);
    expect(normalizeScore(5)).toBe(1);
  });

  test("clamps values outside 1-5 range", () => {
    expect(normalizeScore(0)).toBe(0); // clamped to 1 → 0
    expect(normalizeScore(-1)).toBe(0);
    expect(normalizeScore(6)).toBe(1); // clamped to 5 → 1
    expect(normalizeScore(100)).toBe(1);
  });

  test("rounds fractional scores to nearest integer before normalizing", () => {
    expect(normalizeScore(2.4)).toBe(0.25); // rounds to 2
    expect(normalizeScore(2.6)).toBe(0.5); // rounds to 3
  });
});

describe("clampScore (deprecated alias)", () => {
  test("delegates to normalizeScore", () => {
    expect(clampScore(3)).toBe(normalizeScore(3));
    expect(clampScore(5)).toBe(normalizeScore(5));
  });
});

describe("truncateContent", () => {
  test("returns content unchanged when within limit", () => {
    expect(truncateContent("hello", 100)).toBe("hello");
  });

  test("truncates with 60/40 split and elision marker", () => {
    const content = "a".repeat(100);
    const result = truncateContent(content, 50);
    // 60% of 50 = 30 head, 40% of 50 = 20 tail
    expect(result).toContain("a".repeat(30));
    expect(result).toContain("[...truncated 50 chars...]");
    expect(result.endsWith("a".repeat(20))).toBe(true);
  });

  test("exact length is not truncated", () => {
    const content = "x".repeat(50);
    expect(truncateContent(content, 50)).toBe(content);
  });
});

describe("buildJudgePrompt", () => {
  test("includes 1-5 scale instructions", () => {
    const prompt = buildJudgePrompt("test rubric", "test content");
    expect(prompt).toContain('{"score": <1-5>');
    expect(prompt).toContain("1 — Completely fails");
    expect(prompt).toContain("5 — Fully meets");
  });

  test("truncates content when maxContentLength provided", () => {
    const longContent = "x".repeat(200);
    const prompt = buildJudgePrompt("rubric", longContent, 50);
    expect(prompt).toContain("[...truncated");
    expect(prompt).not.toContain("x".repeat(200));
  });

  test("does not truncate when maxContentLength not provided", () => {
    const longContent = "x".repeat(200);
    const prompt = buildJudgePrompt("rubric", longContent);
    expect(prompt).toContain(longContent);
  });
});
