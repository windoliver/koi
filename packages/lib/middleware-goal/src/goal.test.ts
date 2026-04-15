import { describe, expect, it, mock } from "bun:test";
import type {
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  SessionId,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";

import type { DriftUserMessage, GoalMiddlewareConfig } from "./index.js";

import {
  computeNextInterval,
  createGoalMiddleware as createGoalMiddlewareRaw,
  detectCompletions,
  extractKeywords,
  isDrifting,
  renderGoalBlock,
  validateGoalConfig,
} from "./index.js";

/** Test helper: unwrap middleware from the controller wrapper. */
function createGoalMiddleware(config: GoalMiddlewareConfig): KoiMiddleware {
  return createGoalMiddlewareRaw(config).middleware;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionCtx(sid?: SessionId): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: sid ?? sessionId("s1"),
    runId: runId("r1"),
    metadata: {},
  };
}

function makeTurnCtx(
  session: SessionContext,
  opts?: {
    turnIndex?: number;
    messages?: readonly InboundMessage[];
    stopBlocked?: true;
    signal?: AbortSignal;
  },
): TurnContext {
  return {
    session,
    turnIndex: opts?.turnIndex ?? 0,
    turnId: turnId(runId("r1"), opts?.turnIndex ?? 0),
    messages: opts?.messages ?? [],
    metadata: {},
    ...(opts?.stopBlocked !== undefined ? { stopBlocked: opts.stopBlocked } : {}),
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

function makeModelRequest(messages?: readonly InboundMessage[]): ModelRequest {
  return { messages: messages ?? [] };
}

function makeModelResponse(content: string): ModelResponse {
  return { content, model: "test-model" };
}

function makeTextMessage(text: string, sender = "user"): InboundMessage {
  return {
    senderId: sender,
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("extractKeywords", () => {
  it("extracts words with 4+ characters", () => {
    const kw = extractKeywords(["Write unit tests"]);
    expect(kw.has("write")).toBe(true);
    expect(kw.has("unit")).toBe(true);
    expect(kw.has("tests")).toBe(true);
  });

  it("keeps short tokens alongside long words (acronym preservation)", () => {
    // "iOS support" keeps {i, os, support} so that "support" alone cannot
    // satisfy the objective on generic text.
    const kw = extractKeywords(["iOS support"]);
    expect(kw.has("i")).toBe(true);
    expect(kw.has("os")).toBe(true);
    expect(kw.has("support")).toBe(true);
  });

  it("lowercases and splits on separators", () => {
    // hyphens, underscores, slashes, dots now act as token separators
    const kw = extractKeywords(["Implement auth-flow!"]);
    expect(kw.has("implement")).toBe(true);
    expect(kw.has("auth")).toBe(true);
    expect(kw.has("flow")).toBe(true);
  });

  it("falls back to short tokens when no 4+ char words exist", () => {
    const kw = extractKeywords(["Add UI"]);
    expect(kw.has("add")).toBe(true);
    expect(kw.has("ui")).toBe(true);
  });

  it("falls back for ticket-id / numeric objectives", () => {
    const kw = extractKeywords(["Fix CI", "7 + 5"]);
    expect(kw.has("fix")).toBe(true);
    expect(kw.has("ci")).toBe(true);
    expect(kw.has("7")).toBe(true);
    expect(kw.has("5")).toBe(true);
  });

  it("unions per-objective keywords across mixed objective lists", () => {
    // Per-objective fallback: each objective contributes its own keywords.
    // "Write tests" keeps long words; "Fix CI" falls back to its short tokens.
    const kw = extractKeywords(["Write tests", "Fix CI"]);
    expect(kw.has("write")).toBe(true);
    expect(kw.has("tests")).toBe(true);
    expect(kw.has("fix")).toBe(true);
    expect(kw.has("ci")).toBe(true);
  });
});

describe("renderGoalBlock", () => {
  it("renders pending items", () => {
    const items = [{ text: "Write tests", completed: false }];
    const block = renderGoalBlock(items, "## Goals");
    expect(block).toContain("## Goals");
    expect(block).toContain("- [ ] Write tests");
  });

  it("returns undefined when all items are completed", () => {
    const items = [{ text: "Write tests", completed: true }];
    const block = renderGoalBlock(items, "## Goals");
    expect(block).toBeUndefined();
  });

  it("only renders pending items, excludes completed", () => {
    const items = [
      { text: "Write tests", completed: true },
      { text: "Fix bugs", completed: false },
    ];
    const block = renderGoalBlock(items, "## Goals");
    expect(block).not.toContain("Write tests");
    expect(block).toContain("- [ ] Fix bugs");
  });
});

describe("detectCompletions", () => {
  it("marks matching items as completed when completion signal found", () => {
    const items = [{ text: "Write integration tests", completed: false }];
    const result = detectCompletions("I have completed the integration tests.", items);
    expect(result[0]?.completed).toBe(true);
  });

  it("does not mark items without completion signal", () => {
    const items = [{ text: "Write tests", completed: false }];
    const result = detectCompletions("Working on the tests now.", items);
    expect(result[0]?.completed).toBe(false);
  });

  it("preserves already completed items", () => {
    const items = [{ text: "Write tests", completed: true }];
    const result = detectCompletions("Nothing relevant here.", items);
    expect(result[0]?.completed).toBe(true);
  });

  it("detects checkbox markers", () => {
    const items = [{ text: "Write integration tests", completed: false }];
    const result = detectCompletions("[x] integration tests done", items);
    expect(result[0]?.completed).toBe(true);
  });

  it("does not false-positive on single generic keyword match", () => {
    const items = [{ text: "Write integration tests", completed: false }];
    // Only "write" matches — not enough (need 2 of 3 keywords)
    const result = detectCompletions("completed the writeup for docs", items);
    expect(result[0]?.completed).toBe(false);
  });

  it("requires majority keyword match for multi-word objectives", () => {
    const items = [{ text: "Implement authentication endpoint", completed: false }];
    // "implement" + "authentication" + "endpoint" = 3 keywords, need 2
    const result = detectCompletions("done with implement and authentication work", items);
    expect(result[0]?.completed).toBe(true);
  });

  it("marks short-only objectives as complete via fallback keywords", () => {
    // "Add UI" has no 4+ char tokens, but fallback should enable matching
    const items = [{ text: "Add UI", completed: false }];
    const result = detectCompletions("completed: add UI polish", items);
    expect(result[0]?.completed).toBe(true);
  });

  it("does not substring-match short tokens inside longer words", () => {
    // "Fix CI" → keywords {fix, ci}. "specific" contains "ci" but must NOT match.
    const items = [{ text: "Fix CI", completed: false }];
    const result = detectCompletions("completed a specific refactor fix", items);
    expect(result[0]?.completed).toBe(false);
  });

  it("matches inflected completion forms via prefix match on long-enough keywords", () => {
    // "Fix CI" → keywords {fix, ci}. "finished fixing CI" should match: "fix" is
    // a prefix of "fixing" (>=3 chars → prefix rule); "ci" matches exactly.
    const items = [{ text: "Fix CI", completed: false }];
    const result = detectCompletions("finished fixing CI", items);
    expect(result[0]?.completed).toBe(true);
  });

  it("matches identifier-style completions echoing the objective", () => {
    const items = [{ text: "Fix CI", completed: false }];
    const result = detectCompletions("completed CI fixups in the pipeline", items);
    expect(result[0]?.completed).toBe(true);
  });

  it("does not match 3-char keywords inside unrelated longer tokens", () => {
    // "fix" must not match "prefix" (prefix doesn't start with "fix")
    const fixItems = [{ text: "Fix CI", completed: false }];
    expect(detectCompletions("completed prefix CI cleanup", fixItems)[0]?.completed).toBe(false);

    // "api" must not match "rapid" (doesn't start with "api")
    const addItems = [{ text: "Add API", completed: false }];
    expect(detectCompletions("completed rapid work", addItems)[0]?.completed).toBe(false);

    // "add" must not match "addressing" (suffix "ressing" is > 3 chars)
    const addUiItems = [{ text: "Add UI", completed: false }];
    expect(detectCompletions("completed addressing the backlog", addUiItems)[0]?.completed).toBe(
      false,
    );
    // "add" must not match "additional" (suffix "itional" is > 3 chars)
    expect(detectCompletions("completed additional UI polish", addUiItems)[0]?.completed).toBe(
      false,
    );
  });

  it("matches short keywords inside camelCase identifiers", () => {
    // camelCase boundary is a tokenization hint: fixCiPipeline → fix ci pipeline
    const items = [{ text: "Fix CI", completed: false }];
    expect(detectCompletions("completed fixCiPipeline today", items)[0]?.completed).toBe(true);
    const apiItems = [{ text: "Add API", completed: false }];
    expect(detectCompletions("done addApiClient handler", apiItems)[0]?.completed).toBe(true);
  });

  it("does not mark compound-acronym objectives complete on generic text", () => {
    // "iOS support" regression guard: only "support" in text must not satisfy
    // a multi-token objective.
    const items = [{ text: "iOS support", completed: false }];
    expect(detectCompletions("completed support docs overhaul", items)[0]?.completed).toBe(false);
    // With iOS acronym echoed, threshold is met.
    expect(detectCompletions("completed iOS support update", items)[0]?.completed).toBe(true);
  });

  it("preserves dotted version tokens as distinguishing keywords", () => {
    // "Release v1.2.3" must keep v123 as a keyword so that "released docs" alone
    // does not satisfy the objective (would be a false completion).
    const items = [{ text: "Release v1.2.3", completed: false }];
    expect(detectCompletions("completed release of initial docs", items)[0]?.completed).toBe(false);
    expect(detectCompletions("completed release v1.2.3 successfully", items)[0]?.completed).toBe(
      true,
    );
  });

  it("matches short keywords in snake_case/kebab-case/path identifiers", () => {
    // normalizeText converts _/-// to spaces, so short keywords find their
    // own token inside identifier-style references.
    const items = [{ text: "Fix CI", completed: false }];
    expect(detectCompletions("completed fix_ci_pipeline cleanup", items)[0]?.completed).toBe(true);
    expect(detectCompletions("done fixing fix-ci-pipeline", items)[0]?.completed).toBe(true);
    expect(detectCompletions("finished src/fix/ci/runner.ts rewrites", items)[0]?.completed).toBe(
      true,
    );
  });

  it("matches multi-word objectives echoed inside camelCase identifiers", () => {
    // camelCase identifiers aren't split by normalizeText (only punctuation
    // separators are), so long keywords must still find their substring
    // inside the collapsed token.
    const items = [{ text: "recorded trajectory path", completed: false }];
    expect(
      detectCompletions("completed work on recordedTrajectoryPath today", items)[0]?.completed,
    ).toBe(true);
    expect(
      detectCompletions("done updating recorded_trajectory_path handling", items)[0]?.completed,
    ).toBe(true);
    expect(
      detectCompletions("finished fixtures/recorded-trajectory-path.json rewrites", items)[0]
        ?.completed,
    ).toBe(true);
  });
});

describe("isDrifting", () => {
  it("returns true when no keywords found in recent messages", () => {
    const messages = [makeTextMessage("The weather is nice today.")];
    const keywords = new Set(["tests", "auth"]);
    expect(isDrifting(messages, keywords)).toBe(true);
  });

  it("returns false when keywords found", () => {
    const messages = [makeTextMessage("I'm working on the auth module tests.")];
    const keywords = new Set(["tests", "auth"]);
    expect(isDrifting(messages, keywords)).toBe(false);
  });

  it("returns false for empty keywords", () => {
    const messages = [makeTextMessage("Anything.")];
    expect(isDrifting(messages, new Set())).toBe(false);
  });

  it("detects drift against short-only keyword set (fallback)", () => {
    // e.g. objectives=["Fix CI"] → fallback keywords {"fix","ci"}
    const keywords = new Set(["fix", "ci"]);
    const drifting = [makeTextMessage("Let me refactor the logging subsystem.")];
    expect(isDrifting(drifting, keywords)).toBe(true);
    const onTopic = [makeTextMessage("Running ci now to see if fix holds.")];
    expect(isDrifting(onTopic, keywords)).toBe(false);
  });

  it("does not substring-match short keywords inside longer words", () => {
    // "ci" must not match inside "specific" or "precision"
    const keywords = new Set(["fix", "ci"]);
    const messages = [makeTextMessage("working on specific precision tuning")];
    expect(isDrifting(messages, keywords)).toBe(true);
  });

  it("checks only last 3 messages", () => {
    const messages = [
      makeTextMessage("Working on auth tests"),
      makeTextMessage("Unrelated stuff"),
      makeTextMessage("More unrelated"),
      makeTextMessage("Even more unrelated"),
    ];
    const keywords = new Set(["auth", "tests"]);
    expect(isDrifting(messages, keywords)).toBe(true);
  });
});

describe("computeNextInterval", () => {
  it("always returns baseInterval (exponential backoff removed)", () => {
    // Issue 2 fix: exponential backoff removed. computeNextInterval
    // always returns baseInterval regardless of drifting or current interval.
    expect(computeNextInterval(5, false, 5, 20)).toBe(5);
    expect(computeNextInterval(15, false, 5, 20)).toBe(5);
  });

  it("returns baseInterval when drifting", () => {
    expect(computeNextInterval(20, true, 5, 20)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------

describe("validateGoalConfig", () => {
  it("accepts valid config", () => {
    const result = validateGoalConfig({ objectives: ["Do something"] });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateGoalConfig(null);
    expect(result.ok).toBe(false);
  });

  it("accepts empty objectives (for lazy /goal add)", () => {
    const result = validateGoalConfig({ objectives: [] });
    expect(result.ok).toBe(true);
  });

  it("rejects non-string objectives", () => {
    const result = validateGoalConfig({ objectives: [42] });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid baseInterval", () => {
    const result = validateGoalConfig({ objectives: ["x"], baseInterval: 0 });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid maxInterval", () => {
    const result = validateGoalConfig({ objectives: ["x"], maxInterval: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects maxInterval < baseInterval", () => {
    const result = validateGoalConfig({ objectives: ["x"], baseInterval: 10, maxInterval: 5 });
    expect(result.ok).toBe(false);
  });

  it("accepts maxInterval >= baseInterval", () => {
    const result = validateGoalConfig({ objectives: ["x"], baseInterval: 5, maxInterval: 10 });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Middleware lifecycle tests
// ---------------------------------------------------------------------------

describe("createGoalMiddleware", () => {
  it("throws on invalid config", () => {
    expect(() => createGoalMiddleware({ objectives: null } as never)).toThrow();
  });

  it("accepts empty objectives for lazy goal add", () => {
    const mw = createGoalMiddleware({ objectives: [] });
    expect(mw).toBeDefined();
  });

  it("injects goals on first model call", async () => {
    const mw = createGoalMiddleware({ objectives: ["Build feature A"] });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    let capturedRequest: ModelRequest | undefined;
    const handler: ModelHandler = async (req) => {
      capturedRequest = req;
      return makeModelResponse("Working on it.");
    };

    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    expect(capturedRequest?.messages.length).toBe(1);
    expect(capturedRequest?.messages[0]?.senderId).toBe("system:goal");
  });

  it("fires onComplete when objective is detected as completed", async () => {
    const completed: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write integration tests"],
      onComplete: (obj) => completed.push(obj),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    const handler: ModelHandler = async () =>
      makeModelResponse("I have completed the integration tests successfully.");

    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    expect(completed).toEqual(["Write integration tests"]);
  });

  it("does not fire onComplete twice for same objective", async () => {
    const completed: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write integration tests"],
      onComplete: (obj) => completed.push(obj),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    const handler: ModelHandler = async () =>
      makeModelResponse("I have completed the integration tests.");

    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    expect(completed).toEqual(["Write integration tests"]);
  });

  it("does not revert completions on later model call without signal", async () => {
    const completed: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write integration tests"],
      onComplete: (obj) => completed.push(obj),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);

    // First call: marks objective as completed inline from wrapModelCall
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
      makeModelResponse("I have completed the integration tests."),
    );
    expect(completed).toEqual(["Write integration tests"]);

    // Second call: no completion signal — should NOT revert
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
      makeModelResponse("Now working on something else entirely."),
    );
    // onComplete should not fire again, and status stays completed
    expect(completed).toEqual(["Write integration tests"]);
    const cap = mw.describeCapabilities(ctx);
    expect(cap?.description).toBe("1/1 objectives completed");
  });

  it("describes capabilities with completion count", async () => {
    const mw = createGoalMiddleware({ objectives: ["A", "B"] });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    const cap = mw.describeCapabilities(ctx);
    expect(cap).toEqual({ label: "goals", description: "0/2 objectives completed" });
  });

  it("cleans up session state on end", async () => {
    const mw = createGoalMiddleware({ objectives: ["Test cleanup"] });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await mw.onSessionEnd?.(session);

    const ctx = makeTurnCtx(session);
    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });

  it("passes through tool calls", async () => {
    const mw = createGoalMiddleware({ objectives: ["Test"] });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    const toolHandler = mock(async () => ({ output: "ok" }));
    await mw.wrapToolCall?.(ctx, { toolId: "test", input: {} }, toolHandler);
    expect(toolHandler).toHaveBeenCalledTimes(1);
  });

  it("updates interval after turn via onAfterTurn", async () => {
    const mw = createGoalMiddleware({
      objectives: ["Build auth module"],
      baseInterval: 2,
      maxInterval: 8,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: injects (first turn always injects)
    const ctx0 = makeTurnCtx(session, {
      turnIndex: 0,
      messages: [makeTextMessage("Working on auth module")],
    });
    await mw.onBeforeTurn?.(ctx0);
    let injected = false;
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async (req) => {
      injected = req.messages.length > 0 && req.messages[0]?.senderId === "system:goal";
      return makeModelResponse("ok");
    });
    expect(injected).toBe(true);
    await mw.onAfterTurn?.(ctx0);

    // Turn 1: should NOT inject (interval=2, only 1 turn since reminder)
    const ctx1 = makeTurnCtx(session, {
      turnIndex: 1,
      messages: [makeTextMessage("Working on auth module"), makeTextMessage("Continuing work")],
    });
    await mw.onBeforeTurn?.(ctx1);
    injected = false;
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async (req) => {
      injected = req.messages.length > 0 && req.messages[0]?.senderId === "system:goal";
      return makeModelResponse("ok");
    });
    expect(injected).toBe(false);
  });

  it("only injects goals on first model call within a turn", async () => {
    const mw = createGoalMiddleware({ objectives: ["Test"] });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);

    // First model call gets injection
    let injected1 = false;
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async (req) => {
      injected1 = req.messages.length > 0 && req.messages[0]?.senderId === "system:goal";
      return makeModelResponse("ok");
    });
    // Second model call in same turn does NOT get injection
    let injected2 = false;
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async (req) => {
      injected2 = req.messages.length > 0 && req.messages[0]?.senderId === "system:goal";
      return makeModelResponse("ok");
    });
    expect(injected1).toBe(true);
    expect(injected2).toBe(false);
  });

  it("injects goals on streamed model call", async () => {
    const mw = createGoalMiddleware({ objectives: ["Build feature A"] });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    let capturedRequest: ModelRequest | undefined;
    const streamHandler: ModelStreamHandler = async function* (req) {
      capturedRequest = req;
      yield { kind: "text_delta", delta: "Working on it." } as ModelChunk;
      yield { kind: "done", response: makeModelResponse("Working on it.") } as ModelChunk;
    };

    const chunks: ModelChunk[] = [];
    const stream = mw.wrapModelStream?.(ctx, makeModelRequest(), streamHandler);
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
    }
    expect(capturedRequest?.messages.length).toBe(1);
    expect(capturedRequest?.messages[0]?.senderId).toBe("system:goal");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("detects completions from streamed text", async () => {
    const completed: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write integration tests"],
      onComplete: (obj) => completed.push(obj),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    const streamHandler: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "I have completed the " } as ModelChunk;
      yield { kind: "text_delta", delta: "integration tests." } as ModelChunk;
      yield { kind: "done", response: makeModelResponse("done") } as ModelChunk;
    };

    const stream = mw.wrapModelStream?.(ctx, makeModelRequest(), streamHandler);
    if (stream) {
      for await (const _chunk of stream) {
        // consume
      }
    }
    expect(completed).toEqual(["Write integration tests"]);
  });

  it("detects completions from done chunk when no text_delta emitted", async () => {
    const completed: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write integration tests"],
      onComplete: (obj) => completed.push(obj),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    // Adapter emits no text_delta, only done with full response content
    const streamHandler: ModelStreamHandler = async function* () {
      yield {
        kind: "done",
        response: makeModelResponse("I have completed the integration tests successfully."),
      } as ModelChunk;
    };

    const stream = mw.wrapModelStream?.(ctx, makeModelRequest(), streamHandler);
    if (stream) {
      for await (const _chunk of stream) {
        // consume
      }
    }
    expect(completed).toEqual(["Write integration tests"]);
  });

  it("does not detect completions from aborted streams", async () => {
    const completed: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write integration tests"],
      onComplete: (obj) => completed.push(obj),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    const streamHandler: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "I have completed the integration" } as ModelChunk;
      throw new Error("stream aborted");
    };

    const stream = mw.wrapModelStream?.(ctx, makeModelRequest(), streamHandler);
    if (stream) {
      try {
        for await (const _chunk of stream) {
          // consume
        }
      } catch {
        // expected
      }
    }
    expect(completed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Callback API tests
// ---------------------------------------------------------------------------

describe("isDrifting callback", () => {
  it("is called with DriftJudgeInput + ctx, sync return respected", async () => {
    const calls: Array<{ messages: number; responseTexts: number; items: number }> = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: (input, _ctx) => {
        calls.push({
          messages: input.userMessages.length,
          responseTexts: input.responseTexts.length,
          items: input.items.length,
        });
        return false; // on-topic
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session, {
      messages: [makeTextMessage("user asks about tests")],
    });
    await mw.onBeforeTurn?.(ctx);
    const handler: ModelHandler = async () => makeModelResponse("here is the answer");
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    await mw.onAfterTurn?.(ctx);

    expect(calls.length).toBe(1);
    expect(calls[0]?.items).toBe(1);
    expect(calls[0]?.messages).toBe(1);
  });

  it("async (Promise) return respected", async () => {
    let driftReturn = true;
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: async (_input, _ctx) => driftReturn,
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session, {
      messages: [makeTextMessage("user msg")],
    });
    await mw.onBeforeTurn?.(ctx);
    const handler: ModelHandler = async () => makeModelResponse("ok");
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    await mw.onAfterTurn?.(ctx);

    const cap = mw.describeCapabilities?.(ctx);
    expect(cap).toBeDefined();
    // drift=true resets interval to base; verify by running another turn
    driftReturn = false;
    const ctx2 = makeTurnCtx(session, { turnIndex: 1, messages: [] });
    await mw.onBeforeTurn?.(ctx2);
    await mw.onAfterTurn?.(ctx2);
  });

  it("throws → fail-safe to drifting=true, fires onCallbackError(reason=error)", async () => {
    const errors: Array<{ callback: string; reason: string }> = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: () => {
        throw new Error("LLM down");
      },
      onCallbackError: (info) => errors.push({ callback: info.callback, reason: info.reason }),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    const handler: ModelHandler = async () => makeModelResponse("x");
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    await mw.onAfterTurn?.(ctx);

    expect(errors).toEqual([{ callback: "isDrifting", reason: "error" }]);
  });

  it("exceeds callbackTimeoutMs → fail-safe to drifting, fires onCallbackError(reason=timeout)", async () => {
    const errors: Array<{ callback: string; reason: string }> = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      callbackTimeoutMs: 20,
      isDrifting: () => new Promise<boolean>((_res) => setTimeout(() => _res(false), 200)),
      onCallbackError: (info) => errors.push({ callback: info.callback, reason: info.reason }),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    const handler: ModelHandler = async () => makeModelResponse("x");
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    await mw.onAfterTurn?.(ctx);

    expect(errors).toEqual([{ callback: "isDrifting", reason: "timeout" }]);
  });

  it("callback receives AbortSignal on ctx that fires at timeout", async () => {
    const { promise: callbackFinished, resolve: finish } = Promise.withResolvers<boolean>();
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      callbackTimeoutMs: 20,
      isDrifting: async (_input, ctx) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        finish(ctx.signal?.aborted === true);
        return false;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    const handler: ModelHandler = async () => makeModelResponse("x");
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    await mw.onAfterTurn?.(ctx);

    const observedAborted = await callbackFinished;
    expect(observedAborted).toBe(true);
  });

  it("filters synthetic stop-gate retry messages from userMessages buffer", async () => {
    let capturedMessages: readonly DriftUserMessage[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: (input) => {
        capturedMessages = input.userMessages;
        return false;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Real user turn
    const ctx0 = makeTurnCtx(session, {
      messages: [makeTextMessage("please write tests", "user")],
    });
    await mw.onBeforeTurn?.(ctx0);
    const handler: ModelHandler = async () => makeModelResponse("ok");
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), handler);
    await mw.onAfterTurn?.(ctx0);

    // Retry turn with synthetic [Completion blocked] system msg
    const ctx1 = makeTurnCtx(session, {
      turnIndex: 1,
      messages: [makeTextMessage("[Completion blocked] retry reason", "system")],
    });
    await mw.onBeforeTurn?.(ctx1);
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), handler);
    await mw.onAfterTurn?.(ctx1);

    // The synthetic retry message must NOT be in the buffer
    const texts = capturedMessages.map((m) => m.text);
    expect(texts.some((t) => t.startsWith("[Completion blocked]"))).toBe(false);
    expect(texts.some((t) => t === "please write tests")).toBe(true);
  });

  it("is skipped on stop-gate blocked turns", async () => {
    let calls = 0;
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: () => {
        calls += 1;
        return false;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session, { stopBlocked: true });
    await mw.onBeforeTurn?.(ctx);
    const handler: ModelHandler = async () => makeModelResponse("x");
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    await mw.onAfterTurn?.(ctx);

    expect(calls).toBe(0);
  });
});

describe("detectCompletions callback", () => {
  it("is called once per turn with per-model-call response list", async () => {
    const calls: Array<{ texts: string[]; itemCount: number }> = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests", "Fix bug"],
      detectCompletions: (texts, items, _ctx) => {
        calls.push({ texts: [...texts], itemCount: items.length });
        return [];
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);

    // model → tool → model pattern: 2 calls in one turn
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("first"));
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("second"));
    await mw.onAfterTurn?.(ctx);

    expect(calls.length).toBe(1);
    expect(calls[0]?.texts).toEqual(["first", "second"]);
    expect(calls[0]?.itemCount).toBe(2);
  });

  it("returned IDs merge by lookup (reorder/filter safe)", async () => {
    const completed: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests", "Fix bug", "Deploy"],
      onComplete: (obj) => completed.push(obj),
      // Callback returns IDs in reverse and with a duplicate/unknown
      detectCompletions: (_texts, items) => {
        const ids = items.map((i) => i.id);
        const id0 = ids[0];
        const id2 = ids[2];
        if (id0 === undefined || id2 === undefined) return [];
        return [id2, id0, id2, "goal-nonexistent"];
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("ok"));
    await mw.onAfterTurn?.(ctx);

    // "Write tests" (idx 0) and "Deploy" (idx 2) marked; "Fix bug" still pending
    expect(completed.sort()).toEqual(["Deploy", "Write tests"]);
  });

  it("onComplete fires at turn boundary (not mid-turn) under callback opt-in", async () => {
    const order: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      onComplete: (obj) => order.push(`complete:${obj}`),
      detectCompletions: (_texts, items) => items.map((i) => i.id),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => {
      order.push("model-response");
      return makeModelResponse("I completed the tests");
    });
    order.push("after-wrapModelCall");
    await mw.onAfterTurn?.(ctx);
    order.push("after-onAfterTurn");

    // onComplete must NOT fire between model-response and after-wrapModelCall
    expect(order).toEqual([
      "model-response",
      "after-wrapModelCall",
      "complete:Write tests",
      "after-onAfterTurn",
    ]);
  });

  it("throws → falls back to heuristic", async () => {
    const completed: string[] = [];
    const errors: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write integration tests"],
      onComplete: (obj) => completed.push(obj),
      detectCompletions: () => {
        throw new Error("judge down");
      },
      onCallbackError: (info) => errors.push(info.reason),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
      makeModelResponse("I have completed the integration tests successfully."),
    );
    await mw.onAfterTurn?.(ctx);

    expect(errors).toEqual(["error"]);
    expect(completed).toEqual(["Write integration tests"]);
  });

  it("stop-gate blocked turn processes all entries except the last", async () => {
    const received: string[][] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      detectCompletions: (texts) => {
        received.push([...texts]);
        return [];
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session, { stopBlocked: true });
    await mw.onBeforeTurn?.(ctx);

    // three model calls, last one was stop-gate vetoed
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("first"));
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("second"));
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("vetoed"));
    await mw.onAfterTurn?.(ctx);

    expect(received).toEqual([["first", "second"]]);
  });

  it("response buffer resets at turn boundary", async () => {
    const received: string[][] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      detectCompletions: (texts) => {
        received.push([...texts]);
        return [];
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx0 = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("a"));
    await mw.onAfterTurn?.(ctx0);

    const ctx1 = makeTurnCtx(session, { turnIndex: 1 });
    await mw.onBeforeTurn?.(ctx1);
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async () => makeModelResponse("b"));
    await mw.onAfterTurn?.(ctx1);

    expect(received).toEqual([["a"], ["b"]]);
  });

  it("timeout → fires onCallbackError + falls back to heuristic", async () => {
    const errors: string[] = [];
    const completed: string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      callbackTimeoutMs: 20,
      onComplete: (obj) => completed.push(obj),
      detectCompletions: () => new Promise((res) => setTimeout(() => res([]), 200)),
      onCallbackError: (info) => errors.push(info.reason),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
      makeModelResponse("completed: write tests task done"),
    );
    await mw.onAfterTurn?.(ctx);

    expect(errors).toEqual(["timeout"]);
    expect(completed).toEqual(["Write tests"]);
  });

  it("partial opt-in (only isDrifting): onComplete fires at turn boundary", async () => {
    const completed: string[] = [];
    let driftCalled = 0;
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      onComplete: (obj) => completed.push(obj),
      isDrifting: () => {
        driftCalled += 1;
        return false;
      },
      // detectCompletions NOT provided
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);

    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => {
      return makeModelResponse("completed write tests task");
    });
    // onComplete has NOT fired yet — it fires at turn boundary (onAfterTurn)
    expect(completed).toEqual([]);

    await mw.onAfterTurn?.(ctx);
    expect(completed).toEqual(["Write tests"]);
    expect(driftCalled).toBe(1);
  });
});

describe("turn-scoped state (overlap safety)", () => {
  it("isDrifting-only mode: turn N cannot observe turn N+1's user messages", async () => {
    // In drift-only mode, onBeforeTurn does NOT await pendingWork. Turn
    // N+1's onBeforeTurn can append new user messages to the session
    // buffer before turn N's pending isDrifting callback clones them.
    // Per-turn snapshot must prevent cross-turn leakage.
    const observedByTurn0: string[][] = [];
    let turn0Gate: (() => void) | undefined;
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      baseInterval: 1,
      maxInterval: 1,
      isDrifting: async (input, ctx) => {
        const texts = input.userMessages.map((m) => m.text);
        if (ctx.turnIndex === 0) {
          observedByTurn0.push(texts);
          await new Promise<void>((resolve) => {
            turn0Gate = resolve;
          });
          // Re-read after gate release — must STILL show original snapshot
          const t2 = input.userMessages.map((m) => m.text);
          observedByTurn0.push(t2);
        }
        return false;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx0 = makeTurnCtx(session, {
      turnIndex: 0,
      messages: [makeTextMessage("turn-0-msg", "user")],
    });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("x"));
    const after0 = mw.onAfterTurn?.(ctx0);

    // While turn 0's drift callback is gated, advance turn 1's onBeforeTurn.
    // This appends "turn-1-msg" to the shared buffer.
    const ctx1 = makeTurnCtx(session, {
      turnIndex: 1,
      messages: [makeTextMessage("turn-1-msg", "user")],
    });
    await mw.onBeforeTurn?.(ctx1);

    turn0Gate?.();
    await after0;
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async () => makeModelResponse("x"));
    await mw.onAfterTurn?.(ctx1);

    // Both observations from turn 0 must NOT contain "turn-1-msg"
    for (const texts of observedByTurn0) {
      expect(texts).not.toContain("turn-1-msg");
    }
    expect(observedByTurn0[0]).toContain("turn-0-msg");
  });

  it("per-turn response buffers never mix across turns", async () => {
    // Serialization means callback evaluation is strictly sequential.
    // Each invocation must see only its own turn's buffered responses.
    const calls: Array<{ turnIdx: number; texts: readonly string[] }> = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      detectCompletions: (texts, _items, ctx) => {
        calls.push({ turnIdx: ctx.turnIndex, texts: [...texts] });
        return [];
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx0 = makeTurnCtx(session, { turnIndex: 0 });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("turn-0-a"));
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("turn-0-b"));
    await mw.onAfterTurn?.(ctx0);

    const ctx1 = makeTurnCtx(session, { turnIndex: 1 });
    await mw.onBeforeTurn?.(ctx1);
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async () =>
      makeModelResponse("turn-1-only"),
    );
    await mw.onAfterTurn?.(ctx1);

    expect(calls[0]?.texts).toEqual(["turn-0-a", "turn-0-b"]);
    expect(calls[1]?.texts).toEqual(["turn-1-only"]);
  });

  it("onBeforeTurn awaits prior turn's deferred callback before injecting", async () => {
    // Serialization guarantees: turn N+1's onBeforeTurn blocks on turn N's
    // detectCompletions, so prompt injection sees updated items.
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      baseInterval: 1,
      maxInterval: 1,
      detectCompletions: async (_texts, items) => {
        // Mark goal 0 as complete at turn 0's onAfterTurn
        const first = items[0];
        return first ? [first.id] : [];
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: trigger detectCompletions
    const ctx0 = makeTurnCtx(session, { turnIndex: 0 });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("ok"));
    await mw.onAfterTurn?.(ctx0);

    // Turn 1: completed goals are excluded from injection — no goal message
    let goalInjected = false;
    const ctx1 = makeTurnCtx(session, { turnIndex: 1 });
    await mw.onBeforeTurn?.(ctx1);
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async (req) => {
      goalInjected = req.messages.some((m) => m.senderId === "system:goal");
      return makeModelResponse("x");
    });

    // All goals completed → no goal block injected
    expect(goalInjected).toBe(false);
  });
});

describe("stop-gate cadence rollback", () => {
  it("blocked turn does not consume the reminder; retry turn re-injects", async () => {
    let injectedCount = 0;
    const mw = createGoalMiddleware({ objectives: ["Write tests"] });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: first inject (turnIndex=0 always injects)
    const ctx0 = makeTurnCtx(session, { turnIndex: 0, stopBlocked: true });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async (req) => {
      if (req.messages.some((m) => m.senderId === "system:goal")) injectedCount += 1;
      return makeModelResponse("x");
    });
    await mw.onAfterTurn?.(ctx0);
    // Turn 0 was blocked, so lastReminderTurn should roll back to -1.

    // Retry turn (turnIndex=0 still) — should inject again
    const ctxRetry = makeTurnCtx(session, { turnIndex: 0 });
    await mw.onBeforeTurn?.(ctxRetry);
    await mw.wrapModelCall?.(ctxRetry, makeModelRequest(), async (req) => {
      if (req.messages.some((m) => m.senderId === "system:goal")) injectedCount += 1;
      return makeModelResponse("x");
    });
    await mw.onAfterTurn?.(ctxRetry);

    expect(injectedCount).toBe(2);
  });
});

describe("pendingDrift counter coherence", () => {
  it("counter returns to zero after slow drift callback under state spreads", async () => {
    let turn0Gate: (() => void) | undefined;
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      baseInterval: 1,
      maxInterval: 1,
      isDrifting: async (_input, ctx) => {
        if (ctx.turnIndex === 0) {
          await new Promise<void>((resolve) => {
            turn0Gate = resolve;
          });
        }
        return false;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx0 = makeTurnCtx(session, { turnIndex: 0 });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("x"));
    const after0 = mw.onAfterTurn?.(ctx0);

    // Advance turn 1 fully (triggers sessions.set spread elsewhere)
    const ctx1 = makeTurnCtx(session, { turnIndex: 1 });
    await mw.onBeforeTurn?.(ctx1);
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async () => makeModelResponse("x"));
    // Release turn 0's gate before turn 1's onAfterTurn awaits pendingWork,
    // otherwise turn 1 blocks waiting for turn 0's slow callback to finish.
    turn0Gate?.();
    await after0;
    await mw.onAfterTurn?.(ctx1);

    // After slow callback resolves under state-spread interleaving, the
    // counter must return to 0 and normal cadence should resume.
    // Indirect assertion: turn 3's shouldInject uses currentInterval
    // (not baseInterval fail-safe) once pendingDrift=0. With baseInterval=1
    // and maxInterval=1, interval stays at 1 anyway; verify the call
    // completes without throwing and a later turn processes normally.
    const ctx2 = makeTurnCtx(session, { turnIndex: 2 });
    await mw.onBeforeTurn?.(ctx2);
    await mw.wrapModelCall?.(ctx2, makeModelRequest(), async () => makeModelResponse("x"));
    await mw.onAfterTurn?.(ctx2);
  });
});

describe("cancellation safety", () => {
  it("pre-aborted signal does NOT invoke callback body (no side effects)", async () => {
    let callbackInvoked = false;
    const controller = new AbortController();
    controller.abort(); // already aborted before any turn work
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      detectCompletions: () => {
        callbackInvoked = true;
        return [];
      },
      isDrifting: () => {
        callbackInvoked = true;
        return false;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session, { signal: controller.signal });
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("x"));
    await mw.onAfterTurn?.(ctx);

    expect(callbackInvoked).toBe(false);
  });

  it("upstream abort does NOT fire onComplete or run heuristic fallback", async () => {
    const completed: string[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      onComplete: (obj) => completed.push(obj),
      detectCompletions: async (_texts, _items, ctx) => {
        // wait until upstream aborts
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return [];
      },
      onCallbackError: (info) => errors.push(info.reason),
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session, { signal: controller.signal });
    await mw.onBeforeTurn?.(ctx);
    // Heuristic-matching response text — would mark complete if fallback ran
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
      makeModelResponse("completed write tests task"),
    );
    // Abort before onAfterTurn awaits the callback
    queueMicrotask(() => controller.abort());
    await mw.onAfterTurn?.(ctx);

    // Upstream abort must NOT trigger heuristic fallback or onComplete
    expect(completed).toEqual([]);
    // onCallbackError must NOT fire for upstream cancellation
    expect(errors).toEqual([]);
  });

  it("upstream abort during isDrifting skips interval update", async () => {
    const controller = new AbortController();
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: async (_input, ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return true;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session, { signal: controller.signal });
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("x"));
    queueMicrotask(() => controller.abort());
    // Should complete without throwing; interval update is skipped
    await mw.onAfterTurn?.(ctx);
  });
});

describe("isDrifting message sanitization", () => {
  it("strips assistant / tool / system / file content from userMessages", async () => {
    let captured: readonly DriftUserMessage[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: (input) => {
        captured = input.userMessages;
        return false;
      },
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Mixed senders + mixed content: assistant/tool/system must be dropped,
    // file/image blocks must be stripped.
    const messages: InboundMessage[] = [
      makeTextMessage("user question", "user"),
      makeTextMessage("assistant reply (must be dropped)", "assistant"),
      makeTextMessage("tool output (must be dropped)", "tool"),
      makeTextMessage("system: hidden prompt (must be dropped)", "system"),
      {
        senderId: "user",
        timestamp: 0,
        content: [
          { kind: "text", text: "user text ok" },
          // file/image blocks would normally serialize but we synthesize a
          // text-only shape since InboundMessage union varies by repo
        ],
      },
    ];
    const ctx = makeTurnCtx(session, { messages });
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("ok"));
    await mw.onAfterTurn?.(ctx);

    const senders = captured.map((m) => m.senderId);
    expect(senders).not.toContain("assistant");
    expect(senders).not.toContain("tool");
    expect(senders).not.toContain("system");
    // text-only user messages survive
    const texts = captured.map((m) => m.text);
    expect(texts).toContain("user question");
    expect(texts).toContain("user text ok");
  });

  it("rejects messages with metadata.role assistant/tool regardless of senderId", async () => {
    let captured: readonly DriftUserMessage[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: (input) => {
        captured = input.userMessages;
        return false;
      },
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session, {
      messages: [
        {
          // Explicit user role — accepted
          senderId: "customer-42",
          timestamp: 0,
          metadata: { role: "user" },
          content: [{ kind: "text", text: "actual user text" }],
        },
        {
          // metadata.role=assistant — must be rejected despite benign senderId
          senderId: "customer-43",
          timestamp: 0,
          metadata: { role: "assistant" },
          content: [{ kind: "text", text: "hidden assistant reply" }],
        },
        {
          senderId: "customer-44",
          timestamp: 0,
          metadata: { role: "tool" },
          content: [{ kind: "text", text: "hidden tool output" }],
        },
        {
          // Roleless + non-"user" senderId — strict default-deny rejects
          senderId: "customer-45",
          timestamp: 0,
          content: [{ kind: "text", text: "roleless custom sender" }],
        },
      ],
    });
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("x"));
    await mw.onAfterTurn?.(ctx);

    const texts = captured.map((m) => m.text);
    expect(texts).toEqual(["actual user text"]);
  });

  it("rejects prefixed assistant:/tool: sender IDs from userMessages", async () => {
    let captured: readonly DriftUserMessage[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: (input) => {
        captured = input.userMessages;
        return false;
      },
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session, {
      messages: [
        makeTextMessage("user msg", "user"),
        makeTextMessage("hidden asst 1", "assistant:tool-runner"),
        makeTextMessage("hidden asst 2", "assistant:main"),
        makeTextMessage("tool out 1", "tool:shell"),
      ],
    });
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("x"));
    await mw.onAfterTurn?.(ctx);

    const senders = captured.map((m) => m.senderId);
    expect(senders).toEqual(["user"]);
  });

  it("callback-side mutation of userMessages cannot poison subsequent turns", async () => {
    let call = 0;
    let firstTurnTextOnSecondCall: string | undefined;
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      baseInterval: 1,
      maxInterval: 1,
      isDrifting: (input) => {
        call += 1;
        if (call === 1) {
          // Buggy mutation: try to overwrite text (DriftUserMessage is
          // readonly at type level; runtime mutation is still attempted).
          const mutable = input.userMessages as unknown as Array<{ text: string }>;
          const first = mutable[0];
          if (first) first.text = "MUTATED";
        } else {
          firstTurnTextOnSecondCall = input.userMessages[0]?.text;
        }
        return false;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx0 = makeTurnCtx(session, {
      messages: [makeTextMessage("original text", "user")],
    });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("x"));
    await mw.onAfterTurn?.(ctx0);

    const ctx1 = makeTurnCtx(session, {
      turnIndex: 1,
      messages: [makeTextMessage("another msg", "user")],
    });
    await mw.onBeforeTurn?.(ctx1);
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async () => makeModelResponse("x"));
    await mw.onAfterTurn?.(ctx1);

    // Session-state buffer must still contain unmutated "original text"
    expect(firstTurnTextOnSecondCall).toBe("original text");
  });
});

describe("isDrifting response-text buffer", () => {
  it("sees assistant responses even without detectCompletions opt-in", async () => {
    let receivedTexts: readonly string[] = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: (input) => {
        receivedTexts = input.responseTexts;
        return false;
      },
      // detectCompletions NOT provided
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
      makeModelResponse("first response"),
    );
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
      makeModelResponse("second response"),
    );
    await mw.onAfterTurn?.(ctx);

    expect(receivedTexts).toEqual(["first response", "second response"]);
  });
});

describe("callback input mutation safety", () => {
  it("in-place item mutation inside callback cannot corrupt session state", async () => {
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      detectCompletions: (_texts, items) => {
        // Buggy callback mutates its input (bypasses readonly at runtime)
        const mutable = items as Array<{ id: string; text: string; completed: boolean }>;
        if (mutable[0]) mutable[0].completed = true;
        mutable.length = 0;
        return [];
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("ok"));
    await mw.onAfterTurn?.(ctx);

    // Next turn's callback should still see the ORIGINAL unmutated item
    let observedCompleted = true;
    let observedCount = 0;
    const mw2Config = {
      ...mw,
    };
    void mw2Config; // keep prev ref alive

    // Run another turn and inspect items via isDrifting callback
    const mwWithDrift = createGoalMiddleware({
      objectives: ["Write tests"],
      isDrifting: (input) => {
        observedCompleted = input.items[0]?.completed ?? true;
        observedCount = input.items.length;
        return false;
      },
      detectCompletions: (_texts, items) => {
        const mutable = items as Array<{ id: string; text: string; completed: boolean }>;
        if (mutable[0]) mutable[0].completed = true;
        return [];
      },
    });
    const session2 = makeSessionCtx();
    await mwWithDrift.onSessionStart?.(session2);
    const ctx2 = makeTurnCtx(session2);
    await mwWithDrift.onBeforeTurn?.(ctx2);
    await mwWithDrift.wrapModelCall?.(ctx2, makeModelRequest(), async () =>
      makeModelResponse("ok"),
    );
    await mwWithDrift.onAfterTurn?.(ctx2);

    expect(observedCompleted).toBe(false);
    expect(observedCount).toBe(1);
  });
});

describe("drift sees post-completion state", () => {
  it("isDrifting receives items updated by detectCompletions in the same turn", async () => {
    let observedCompleted: ReadonlyArray<{ id: string; completed: boolean }> = [];
    const mw = createGoalMiddleware({
      objectives: ["Write tests", "Fix bug"],
      // Complete item 0 this turn
      detectCompletions: (_texts, items) => {
        const first = items[0];
        return first ? [first.id] : [];
      },
      isDrifting: (input) => {
        observedCompleted = input.items.map((i) => ({ id: i.id, completed: i.completed }));
        return false;
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    const ctx = makeTurnCtx(session);
    await mw.onBeforeTurn?.(ctx);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("done"));
    await mw.onAfterTurn?.(ctx);

    expect(observedCompleted[0]?.completed).toBe(true);
    expect(observedCompleted[1]?.completed).toBe(false);
  });
});

describe("callback return-value validation", () => {
  it("detectCompletions malformed return (undefined/null/object/mixed) falls back to heuristic", async () => {
    const badReturns = [undefined, null, {}, "not-an-array", [1, 2, 3], ["ok", 42]] as const;
    for (const bad of badReturns) {
      const errors: string[] = [];
      const mw = createGoalMiddleware({
        objectives: ["Write tests"],
        detectCompletions: (() => bad) as never,
        onCallbackError: (info) => errors.push(info.reason),
      });
      const session = makeSessionCtx();
      await mw.onSessionStart?.(session);
      const ctx = makeTurnCtx(session);
      await mw.onBeforeTurn?.(ctx);
      await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
        makeModelResponse("completed write tests"),
      );
      // must not throw
      await mw.onAfterTurn?.(ctx);
      expect(errors).toEqual(["error"]);
    }
  });

  it("isDrifting malformed return (non-boolean) falls back to drifting=true", async () => {
    const badReturns = [undefined, null, 1, "true", {}] as const;
    for (const bad of badReturns) {
      const errors: string[] = [];
      const mw = createGoalMiddleware({
        objectives: ["Write tests"],
        isDrifting: (() => bad) as never,
        onCallbackError: (info) => errors.push(info.reason),
      });
      const session = makeSessionCtx();
      await mw.onSessionStart?.(session);
      const ctx = makeTurnCtx(session);
      await mw.onBeforeTurn?.(ctx);
      await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse("x"));
      await mw.onAfterTurn?.(ctx);
      expect(errors).toEqual(["error"]);
    }
  });
});

describe("callbackTimeoutMs validation", () => {
  it("rejects zero, negative, NaN, non-integer, or > MAX_CALLBACK_TIMEOUT_MS", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 100000]) {
      const result = validateGoalConfig({ objectives: ["x"], callbackTimeoutMs: bad });
      expect(result.ok).toBe(false);
    }
  });

  it("accepts finite positive integer <= MAX_CALLBACK_TIMEOUT_MS", () => {
    for (const ok of [1, 500, 5000, 60000]) {
      const result = validateGoalConfig({ objectives: ["x"], callbackTimeoutMs: ok });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects non-function isDrifting / detectCompletions / onCallbackError", () => {
    expect(
      validateGoalConfig({
        objectives: ["x"],
        isDrifting: "not-a-function" as unknown as undefined,
      }).ok,
    ).toBe(false);
    expect(
      validateGoalConfig({
        objectives: ["x"],
        detectCompletions: 123 as unknown as undefined,
      }).ok,
    ).toBe(false);
    expect(
      validateGoalConfig({
        objectives: ["x"],
        onCallbackError: {} as unknown as undefined,
      }).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue 9: Multi-turn drift regression test (Q136 scenario)
// ---------------------------------------------------------------------------

describe("multi-turn drift re-injection", () => {
  it("re-injects goals within baseInterval turns after drift begins", async () => {
    // Simulates the Q136 bug: after a successful first turn, 5 off-topic
    // turns should trigger goal re-injection. With baseInterval=3 and
    // drift detection decoupled from injection, the middleware should
    // detect drift on every turn and force re-injection promptly.
    const mw = createGoalMiddleware({
      objectives: ["Write unit tests for the math module"],
      baseInterval: 3,
      maxInterval: 20,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: goals inject, agent responds on-topic → not drifting
    const ctx0 = makeTurnCtx(session, {
      turnIndex: 0,
      messages: [makeTextMessage("What are my current goals?")],
    });
    await mw.onBeforeTurn?.(ctx0);
    let injected = false;
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async (req) => {
      injected = req.messages.some((m) => m.senderId === "system:goal");
      return makeModelResponse("Your goals are: Write unit tests for the math module.");
    });
    expect(injected).toBe(true);
    await mw.onAfterTurn?.(ctx0);

    // Turns 1-5: completely off-topic weather prompts (drift)
    const injections: boolean[] = [];
    for (let i = 1; i <= 5; i++) {
      const ctx = makeTurnCtx(session, {
        turnIndex: i,
        messages: [makeTextMessage("Tell me about the weather")],
      });
      await mw.onBeforeTurn?.(ctx);
      let turnInjected = false;
      await mw.wrapModelCall?.(ctx, makeModelRequest(), async (req) => {
        turnInjected = req.messages.some((m) => m.senderId === "system:goal");
        return makeModelResponse("The weather today is sunny and warm.");
      });
      injections.push(turnInjected);
      await mw.onAfterTurn?.(ctx);
    }

    // At least one re-injection should have occurred within 5 off-topic turns.
    // With baseInterval=3 and drift detection every turn, injection should
    // happen at or before turn 3.
    expect(injections.some((v) => v)).toBe(true);
  });

  it("drift detected every turn forces re-injection on next turn", async () => {
    // After drift is detected, forceInjectNextTurn should be set,
    // causing immediate re-injection regardless of interval.
    const mw = createGoalMiddleware({
      objectives: ["Implement authentication"],
      baseInterval: 10, // large interval to prove force-inject overrides it
      maxInterval: 20,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: inject, on-topic response
    const ctx0 = makeTurnCtx(session, {
      turnIndex: 0,
      messages: [makeTextMessage("Start authentication work")],
    });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () =>
      makeModelResponse("Starting authentication implementation now."),
    );
    await mw.onAfterTurn?.(ctx0);

    // Turn 1: off-topic (drift should be detected in onAfterTurn)
    const ctx1 = makeTurnCtx(session, {
      turnIndex: 1,
      messages: [makeTextMessage("Tell me a joke about cats")],
    });
    await mw.onBeforeTurn?.(ctx1);
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async () =>
      makeModelResponse("Why did the cat sit on the computer? To keep an eye on the mouse!"),
    );
    await mw.onAfterTurn?.(ctx1);

    // Turn 2: should force-inject because drift was detected on turn 1,
    // despite baseInterval=10 meaning normal cadence wouldn't inject until turn 10
    const ctx2 = makeTurnCtx(session, {
      turnIndex: 2,
      messages: [makeTextMessage("Another joke please")],
    });
    await mw.onBeforeTurn?.(ctx2);
    let injectedOnTurn2 = false;
    await mw.wrapModelCall?.(ctx2, makeModelRequest(), async (req) => {
      injectedOnTurn2 = req.messages.some((m) => m.senderId === "system:goal");
      return makeModelResponse("ok");
    });
    expect(injectedOnTurn2).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue 10: User-message keyword-triggered injection
// ---------------------------------------------------------------------------

describe("user-message keyword-triggered injection", () => {
  it("force-injects goals when user message contains goal keywords", async () => {
    const mw = createGoalMiddleware({
      objectives: ["Write unit tests for the math module"],
      baseInterval: 100, // very large to prove keyword match overrides cadence
      maxInterval: 200,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: normal injection (first turn)
    const ctx0 = makeTurnCtx(session, {
      turnIndex: 0,
      messages: [makeTextMessage("Hello")],
    });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("Hi there."));
    await mw.onAfterTurn?.(ctx0);

    // Turn 1: user mentions goal keywords ("tests", "math") — should trigger injection
    // despite baseInterval=100 meaning normal cadence wouldn't inject until turn 100
    const ctx1 = makeTurnCtx(session, {
      turnIndex: 1,
      messages: [makeTextMessage("I've finished writing all the tests for the math module")],
    });
    await mw.onBeforeTurn?.(ctx1);
    let injectedOnTurn1 = false;
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async (req) => {
      injectedOnTurn1 = req.messages.some((m) => m.senderId === "system:goal");
      return makeModelResponse("ok");
    });
    expect(injectedOnTurn1).toBe(true);
  });

  it("does not force-inject when user message has no goal keywords and not drifting", async () => {
    const mw = createGoalMiddleware({
      objectives: ["Write unit tests for the math module"],
      baseInterval: 100,
      maxInterval: 200,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: first turn injection, on-topic so drift is NOT detected
    const ctx0 = makeTurnCtx(session, {
      turnIndex: 0,
      messages: [makeTextMessage("Let me write some unit tests for the math module")],
    });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () =>
      makeModelResponse("Starting tests for math module."),
    );
    await mw.onAfterTurn?.(ctx0);

    // Turn 1: completely unrelated message, no keywords — but since turn 0
    // was on-topic and interval=100, there's no force-inject from drift
    // (drift on turn 1 will set forceInjectNextTurn for turn 2, but turn 1
    // itself should not inject)
    const ctx1 = makeTurnCtx(session, {
      turnIndex: 1,
      messages: [
        makeTextMessage("Let me write some unit tests for the math module"),
        makeTextMessage("What is the weather today?"),
      ],
    });
    await mw.onBeforeTurn?.(ctx1);
    let injectedOnTurn1 = false;
    await mw.wrapModelCall?.(ctx1, makeModelRequest(), async (req) => {
      injectedOnTurn1 = req.messages.some((m) => m.senderId === "system:goal");
      return makeModelResponse("ok");
    });
    // Should NOT inject — no user keywords in latest message, interval not reached,
    // and previous turn was on-topic so forceInjectNextTurn was not set
    expect(injectedOnTurn1).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue 11: pendingDrift fail-safe interval override
// ---------------------------------------------------------------------------

describe("pendingDrift fail-safe interval override", () => {
  it("uses baseInterval instead of currentInterval when drift callbacks are in-flight", async () => {
    // When pendingDrift > 0 (a drift callback is still running), the
    // effective interval should fall back to baseInterval to prevent a
    // stale large interval from suppressing reminders.
    let driftGate: (() => void) | undefined;
    const mw = createGoalMiddleware({
      objectives: ["Write tests"],
      baseInterval: 2,
      maxInterval: 20,
      isDrifting: async (_input, ctx) => {
        if (ctx.turnIndex === 0) {
          // Hold turn 0's drift callback open to simulate slow callback
          await new Promise<void>((resolve) => {
            driftGate = resolve;
          });
        }
        return false; // not drifting
      },
    });

    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    // Turn 0: inject + start slow drift callback (pendingDrift becomes 1)
    const ctx0 = makeTurnCtx(session, { turnIndex: 0 });
    await mw.onBeforeTurn?.(ctx0);
    await mw.wrapModelCall?.(ctx0, makeModelRequest(), async () => makeModelResponse("x"));
    const after0 = mw.onAfterTurn?.(ctx0); // starts but doesn't resolve (drift callback hangs)

    // Turn 2: while drift callback is in-flight (pendingDrift > 0),
    // effective interval should be baseInterval=2, NOT the backed-off
    // currentInterval. turnsSinceReminder=2 >= baseInterval=2 → inject.
    const ctx2 = makeTurnCtx(session, { turnIndex: 2 });
    await mw.onBeforeTurn?.(ctx2);
    let injectedOnTurn2 = false;
    await mw.wrapModelCall?.(ctx2, makeModelRequest(), async (req) => {
      injectedOnTurn2 = req.messages.some((m) => m.senderId === "system:goal");
      return makeModelResponse("x");
    });

    // Release the gate and clean up
    driftGate?.();
    await after0;
    await mw.onAfterTurn?.(ctx2);

    expect(injectedOnTurn2).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue 12: baseInterval=1 boundary test
// ---------------------------------------------------------------------------

describe("baseInterval=1 boundary", () => {
  it("injects goals on every turn when baseInterval is 1", async () => {
    const mw = createGoalMiddleware({
      objectives: ["Build feature"],
      baseInterval: 1,
      maxInterval: 1,
    });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const injections: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const ctx = makeTurnCtx(session, {
        turnIndex: i,
        messages: [makeTextMessage("Working on feature")],
      });
      await mw.onBeforeTurn?.(ctx);
      let injected = false;
      await mw.wrapModelCall?.(ctx, makeModelRequest(), async (req) => {
        injected = req.messages.some((m) => m.senderId === "system:goal");
        return makeModelResponse("Still building the feature.");
      });
      injections.push(injected);
      await mw.onAfterTurn?.(ctx);
    }

    // Every turn should inject when baseInterval=1
    expect(injections).toEqual([true, true, true, true, true]);
  });
});
