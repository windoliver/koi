import { describe, expect, mock, test } from "bun:test";
import type {
  ModelChunk,
  OutcomeRubric,
  SessionContext,
  SessionId,
  StopGateResult,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createOutcomeEvaluatorMiddleware } from "./outcome-evaluator.js";
import type { OutcomeEvaluationEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const RUBRIC: OutcomeRubric = {
  description: "Explain recursion",
  criteria: [
    { name: "base_case", description: "Mentions base case" },
    { name: "self_call", description: "Mentions self-call" },
  ],
};

const ADVISORY_RUBRIC: OutcomeRubric = {
  description: "Write a poem",
  criteria: [
    { name: "rhymes", description: "Contains rhymes" },
    { name: "meter", description: "Has consistent meter", required: false },
  ],
};

function makeSessionContext(sessionId = "sess-1"): SessionContext {
  return {
    agentId: "agent-1",
    sessionId: sessionId as SessionId,
    runId: "run-1" as ReturnType<typeof import("@koi/core").runId>,
    metadata: {},
  };
}

function makeTurnContext(sessionId = "sess-1"): TurnContext {
  return {
    session: makeSessionContext(sessionId),
    turnIndex: 0,
    turnId: "turn-1" as ReturnType<typeof import("@koi/core").turnId>,
    messages: [],
    metadata: {},
    signal: undefined,
  };
}

const ALL_PASS_RESPONSE = JSON.stringify({
  criteria: [
    { name: "base_case", passed: true },
    { name: "self_call", passed: true },
  ],
  explanation: "All criteria met.",
});

const ALL_FAIL_RESPONSE = JSON.stringify({
  criteria: [
    { name: "base_case", passed: false, gap: "No base case mentioned" },
    { name: "self_call", passed: false, gap: "No self-call mentioned" },
  ],
  explanation: "Output is insufficient.",
});

// Simulate a model stream that yields text then done
async function* makeTextStream(text: string): AsyncIterable<ModelChunk> {
  yield { kind: "text_delta", delta: text };
  yield {
    kind: "done",
    response: {
      content: text,
      model: "test",
      usage: { inputTokens: 10, outputTokens: 10 },
    },
  };
}

// ---------------------------------------------------------------------------
// Null-safe helpers for optional middleware hooks
// ---------------------------------------------------------------------------

async function captureStream(
  handle: ReturnType<typeof createOutcomeEvaluatorMiddleware>,
  ctx: TurnContext,
  text: string,
): Promise<void> {
  const fn = handle.middleware.wrapModelStream;
  if (fn === undefined)
    throw new Error("wrapModelStream must be defined on outcome-evaluator middleware");
  const stream = fn(ctx, {} as never, () => makeTextStream(text));
  for await (const _ of stream) {
    /* consume */
  }
}

async function callStop(
  handle: ReturnType<typeof createOutcomeEvaluatorMiddleware>,
  ctx: TurnContext,
): Promise<StopGateResult> {
  const fn = handle.middleware.onBeforeStop;
  if (fn === undefined)
    throw new Error("onBeforeStop must be defined on outcome-evaluator middleware");
  return fn(ctx);
}

async function callSessionEnd(
  handle: ReturnType<typeof createOutcomeEvaluatorMiddleware>,
  ctx: SessionContext,
): Promise<void> {
  const fn = handle.middleware.onSessionEnd;
  if (fn === undefined)
    throw new Error("onSessionEnd must be defined on outcome-evaluator middleware");
  return fn(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOutcomeEvaluatorMiddleware — construction validation", () => {
  test("throws when maxIterations > 20", () => {
    expect(() =>
      createOutcomeEvaluatorMiddleware({
        rubric: RUBRIC,
        graderModelCall: async () => ALL_PASS_RESPONSE,
        maxIterations: 21,
      }),
    ).toThrow(KoiRuntimeError);
  });

  test("throws when maxIterations > engineStopRetryCap", () => {
    expect(() =>
      createOutcomeEvaluatorMiddleware({
        rubric: RUBRIC,
        graderModelCall: async () => ALL_PASS_RESPONSE,
        maxIterations: 15,
        engineStopRetryCap: 3,
      }),
    ).toThrow(KoiRuntimeError);
  });

  test("does not throw when maxIterations === engineStopRetryCap", () => {
    expect(() =>
      createOutcomeEvaluatorMiddleware({
        rubric: RUBRIC,
        graderModelCall: async () => ALL_PASS_RESPONSE,
        maxIterations: 5,
        engineStopRetryCap: 5,
      }),
    ).not.toThrow();
  });
});

describe("createOutcomeEvaluatorMiddleware — convergence", () => {
  test("satisfied on first pass returns { kind: continue }", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_PASS_RESPONSE,
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "Recursion has a base case and calls itself.");
    const result = await callStop(handle, ctx);
    expect(result.kind).toBe("continue");
  });

  test("agent iterates on feedback: fails on iter 1, passes on iter 2", async () => {
    let callCount = 0;
    const graderModelCall = async () => {
      callCount++;
      return callCount === 1 ? ALL_FAIL_RESPONSE : ALL_PASS_RESPONSE;
    };
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall,
      maxIterations: 3,
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "Recursion artifact");

    const r1 = await callStop(handle, ctx);
    expect(r1.kind).toBe("block");
    if (r1.kind === "block") {
      expect(r1.reason).toContain("base_case");
    }

    await captureStream(handle, ctx, "Better recursion with base case and self-call.");
    const r2 = await callStop(handle, ctx);
    expect(r2.kind).toBe("continue");
    expect(callCount).toBe(2);
  });
});

describe("createOutcomeEvaluatorMiddleware — budget exhaustion", () => {
  test("returns continue after maxIterations exhausted", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_FAIL_RESPONSE,
      maxIterations: 2,
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");

    await callStop(handle, ctx); // iter 1 — block
    await callStop(handle, ctx); // iter 2 — block
    const r3 = await callStop(handle, ctx); // iter 3 — over budget
    expect(r3.kind).toBe("continue");
  });
});

describe("createOutcomeEvaluatorMiddleware — circuit breaker", () => {
  test("same failing set twice trips circuit → continue before maxIterations", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_FAIL_RESPONSE,
      maxIterations: 10,
      circuitBreakConsecutiveIdenticalFailures: 2,
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");

    const r1 = await callStop(handle, ctx); // iter 1: fail → block
    expect(r1.kind).toBe("block");

    await captureStream(handle, ctx, "same artifact");
    const r2 = await callStop(handle, ctx); // iter 2: same fails → circuit trips → continue
    expect(r2.kind).toBe("continue");
  });

  test("partial improvement resets circuit counter", async () => {
    let callCount = 0;
    const graderModelCall = async () => {
      callCount++;
      if (callCount <= 2) {
        return JSON.stringify({
          criteria: [
            { name: "base_case", passed: false, gap: "missing" },
            { name: "self_call", passed: false, gap: "missing" },
          ],
          explanation: "Both fail",
        });
      }
      // After 2 fails, partial improvement: only self_call fails
      return JSON.stringify({
        criteria: [
          { name: "base_case", passed: true },
          { name: "self_call", passed: false, gap: "still missing" },
        ],
        explanation: "Partial",
      });
    };
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall,
      maxIterations: 10,
      circuitBreakConsecutiveIdenticalFailures: 2,
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");

    const r1 = await callStop(handle, ctx); // both fail
    expect(r1.kind).toBe("block");

    await captureStream(handle, ctx, "artifact");
    const r2 = await callStop(handle, ctx); // both fail again — circuit should trip
    expect(r2.kind).toBe("continue"); // circuit tripped: 2 consecutive identical failures

    // But if we reset and try partial improvement path:
    const handle2 = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: (() => {
        let n = 0;
        return async () => {
          n++;
          if (n === 1)
            return JSON.stringify({
              criteria: [
                { name: "base_case", passed: false, gap: "x" },
                { name: "self_call", passed: false, gap: "x" },
              ],
              explanation: "",
            });
          if (n === 2)
            return JSON.stringify({
              criteria: [
                { name: "base_case", passed: true },
                { name: "self_call", passed: false, gap: "x" },
              ],
              explanation: "",
            });
          if (n === 3)
            return JSON.stringify({
              criteria: [
                { name: "base_case", passed: true },
                { name: "self_call", passed: false, gap: "x" },
              ],
              explanation: "",
            });
          return ALL_PASS_RESPONSE;
        };
      })(),
      maxIterations: 10,
      circuitBreakConsecutiveIdenticalFailures: 2,
    });
    const ctx2 = makeTurnContext("sess-2");
    await captureStream(handle2, ctx2, "a");
    const h2r1 = await callStop(handle2, ctx2); // both fail → block
    expect(h2r1.kind).toBe("block");

    await captureStream(handle2, ctx2, "b");
    const h2r2 = await callStop(handle2, ctx2); // partial improvement → counter resets → block
    expect(h2r2.kind).toBe("block");

    await captureStream(handle2, ctx2, "c");
    const h2r3 = await callStop(handle2, ctx2); // same as r2 set → consecutive 2 → circuit trips
    expect(h2r3.kind).toBe("continue");
  });
});

describe("createOutcomeEvaluatorMiddleware — grader error handling", () => {
  test("fail_closed (default): grader throws → continue (let agent complete)", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => {
        throw new Error("Network error");
      },
      onGraderError: "fail_closed",
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");
    const result = await callStop(handle, ctx);
    expect(result.kind).toBe("continue");
  });

  test("fail_open: grader throws → block (keep agent in loop)", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => {
        throw new Error("API error");
      },
      onGraderError: "fail_open",
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");
    const result = await callStop(handle, ctx);
    expect(result.kind).toBe("block");
  });

  test("grader returns unparseable response → treated as grader error", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => "not json at all",
      onGraderError: "fail_closed",
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");
    const result = await callStop(handle, ctx);
    expect(result.kind).toBe("continue"); // fail_closed
  });
});

describe("createOutcomeEvaluatorMiddleware — isolated criteria mode", () => {
  test("isolateCriteria:true fires exactly criteria.length grader calls", async () => {
    const mockGrader = mock(async (prompt: string): Promise<string> => {
      // Return a pass response for whichever criterion is in this prompt
      if (prompt.includes("base_case")) {
        return JSON.stringify({ criteria: [{ name: "base_case", passed: true }], explanation: "" });
      }
      return JSON.stringify({ criteria: [{ name: "self_call", passed: true }], explanation: "" });
    });

    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: mockGrader,
      isolateCriteria: true,
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "Recursion artifact");
    await callStop(handle, ctx);

    expect(mockGrader.mock.calls.length).toBe(RUBRIC.criteria.length);
  });

  test("isolated mode: different criteria get different prompts", async () => {
    const receivedPrompts: string[] = [];
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async (prompt) => {
        receivedPrompts.push(prompt);
        return JSON.stringify({
          criteria: [
            { name: prompt.includes("base_case") ? "base_case" : "self_call", passed: true },
          ],
          explanation: "",
        });
      },
      isolateCriteria: true,
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");
    await callStop(handle, ctx);

    expect(receivedPrompts.some((p) => p.includes("base_case"))).toBe(true);
    expect(receivedPrompts.some((p) => p.includes("self_call"))).toBe(true);
  });
});

describe("createOutcomeEvaluatorMiddleware — artifact handling", () => {
  test("empty artifact (no stream captured) throws and emits grader_error", async () => {
    const events: OutcomeEvaluationEvent[] = [];
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_PASS_RESPONSE,
      onEvent: (e) => events.push(e),
    });
    const ctx = makeTurnContext();
    // No captureStream call — capturedText stays ""
    const result = await callStop(handle, ctx);
    // fail_closed default: grader_error + continue
    expect(result.kind).toBe("continue");
    expect(
      events.some(
        (e) => e.kind === "outcome.evaluation.end" && e.evaluation.result === "grader_error",
      ),
    ).toBe(true);
  });

  test("artifact exceeding maxArtifactTokens emits truncation event", async () => {
    const events: OutcomeEvaluationEvent[] = [];
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_PASS_RESPONSE,
      maxArtifactTokens: 5, // very small limit
      onEvent: (e) => events.push(e),
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "A".repeat(100)); // definitely > 5 tokens
    await callStop(handle, ctx);
    expect(events.some((e) => e.kind === "outcome.artifact.truncated")).toBe(true);
  });
});

describe("createOutcomeEvaluatorMiddleware — advisory criteria", () => {
  test("advisory criterion failing does not block satisfied", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: ADVISORY_RUBRIC,
      graderModelCall: async () =>
        JSON.stringify({
          criteria: [
            { name: "rhymes", passed: true },
            { name: "meter", passed: false, gap: "inconsistent meter" },
          ],
          explanation: "Mostly good.",
        }),
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "poem artifact");
    const result = await callStop(handle, ctx);
    expect(result.kind).toBe("continue"); // advisory failing but required passed
  });
});

describe("createOutcomeEvaluatorMiddleware — session lifecycle", () => {
  test("onSessionEnd removes session state", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_FAIL_RESPONSE,
    });
    const ctx = makeTurnContext("sess-cleanup");
    await captureStream(handle, ctx, "artifact");
    await callStop(handle, ctx); // creates session state

    const sessionCtx = makeSessionContext("sess-cleanup");
    await callSessionEnd(handle, sessionCtx);

    // Stats should be zeroed (session removed)
    const stats = handle.getStats("sess-cleanup" as SessionId);
    expect(stats.totalEvaluations).toBe(0);
  });

  test("getStats returns zeroed stats for unknown session", () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_PASS_RESPONSE,
    });
    const stats = handle.getStats("unknown-sess" as SessionId);
    expect(stats.totalEvaluations).toBe(0);
    expect(stats.satisfied).toBe(0);
  });
});

describe("createOutcomeEvaluatorMiddleware — ATIF events", () => {
  test("evaluation.start fires before evaluation.end on each iteration", async () => {
    const events: OutcomeEvaluationEvent[] = [];
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_PASS_RESPONSE,
      onEvent: (e) => events.push(e),
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");
    await callStop(handle, ctx);

    const startIdx = events.findIndex((e) => e.kind === "outcome.evaluation.start");
    const endIdx = events.findIndex((e) => e.kind === "outcome.evaluation.end");
    expect(startIdx).toBeLessThan(endIdx);
  });

  test("evaluation.end payload includes iteration, criteria[], and result", async () => {
    const events: OutcomeEvaluationEvent[] = [];
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_PASS_RESPONSE,
      onEvent: (e) => events.push(e),
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");
    await callStop(handle, ctx);

    const endEvent = events.find((e) => e.kind === "outcome.evaluation.end");
    expect(endEvent).toBeDefined();
    if (endEvent?.kind === "outcome.evaluation.end") {
      expect(endEvent.evaluation.iteration).toBe(1);
      expect(endEvent.evaluation.criteria.length).toBeGreaterThan(0);
      expect(["satisfied", "needs_revision", "grader_error", "max_iterations_reached"]).toContain(
        endEvent.evaluation.result,
      );
    }
  });

  test("block reason contains structured gap feedback on needs_revision", async () => {
    const handle = createOutcomeEvaluatorMiddleware({
      rubric: RUBRIC,
      graderModelCall: async () => ALL_FAIL_RESPONSE,
    });
    const ctx = makeTurnContext();
    await captureStream(handle, ctx, "artifact");
    const result = await callStop(handle, ctx);
    expect(result.kind).toBe("block");
    if (result.kind === "block") {
      expect(result.reason).toContain("base_case");
      expect(result.reason).toContain("No base case mentioned");
    }
  });
});
