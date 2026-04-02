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

  it("excludes short words", () => {
    const kw = extractKeywords(["Do it now"]);
    expect(kw.size).toBe(0);
  });

  it("lowercases and strips punctuation", () => {
    const kw = extractKeywords(["Implement auth-flow!"]);
    expect(kw.has("implement")).toBe(true);
    expect(kw.has("authflow")).toBe(true);
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
    const handler: ModelHandler = async () =>
      makeModelResponse("I have completed the integration tests.");

    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);
    expect(completed).toEqual(["Write integration tests"]);
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

  it("injects goals on streamed model call", async () => {
    const mw = createGoalMiddleware({ objectives: ["Build feature A"] });
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
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
});
