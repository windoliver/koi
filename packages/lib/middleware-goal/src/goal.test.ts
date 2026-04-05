import { describe, expect, it, mock } from "bun:test";
import type {
  InboundMessage,
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

import {
  computeNextInterval,
  createGoalMiddleware,
  detectCompletions,
  extractKeywords,
  isDrifting,
  renderGoalBlock,
  validateGoalConfig,
} from "./index.js";

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
  opts?: { turnIndex?: number; messages?: readonly InboundMessage[] },
): TurnContext {
  return {
    session,
    turnIndex: opts?.turnIndex ?? 0,
    turnId: turnId(runId("r1"), opts?.turnIndex ?? 0),
    messages: opts?.messages ?? [],
    metadata: {},
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

  it("excludes short words when long words are present", () => {
    const kw = extractKeywords(["Write unit tests now"]);
    expect(kw.has("now")).toBe(false);
    expect(kw.has("write")).toBe(true);
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

  it("renders completed items", () => {
    const items = [{ text: "Write tests", completed: true }];
    const block = renderGoalBlock(items, "## Goals");
    expect(block).toContain("- [x] Write tests");
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
  it("doubles interval when not drifting", () => {
    expect(computeNextInterval(5, false, 5, 20)).toBe(10);
  });

  it("caps at maxInterval", () => {
    expect(computeNextInterval(15, false, 5, 20)).toBe(20);
  });

  it("resets to baseInterval when drifting", () => {
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

  it("rejects empty objectives", () => {
    const result = validateGoalConfig({ objectives: [] });
    expect(result.ok).toBe(false);
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
    expect(() => createGoalMiddleware({ objectives: [] } as never)).toThrow();
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

    // First call: marks objective as completed
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () =>
      makeModelResponse("I have completed the integration tests."),
    );
    expect(completed).toEqual(["Write integration tests"]);

    // Second call: no completion signal — should NOT revert
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

    // Turn 1: should NOT inject (interval=4 after doubling from 2, only 1 turn since reminder)
    const ctx1 = makeTurnCtx(session, {
      turnIndex: 1,
      messages: [makeTextMessage("Still on auth")],
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
