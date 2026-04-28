import { describe, expect, test } from "bun:test";
import type {
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";

import { CACHE_HINTS_KEY, createPromptCacheMiddleware, readCacheHints } from "./prompt-cache.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(senderId: string, text: string): InboundMessage {
  return { senderId, timestamp: 0, content: [{ kind: "text", text }] };
}

function bigSystem(): InboundMessage {
  // ~5000 chars → ~1250 tokens, well above default 1024 threshold
  return msg("system", "x".repeat(5000));
}

function makeCtx(): TurnContext {
  return {
    session: {
      agentId: "test",
      sessionId: "s1" as never,
      runId: "r1" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "t1" as never,
    messages: [],
    metadata: {},
  };
}

function captureHandler(): { handler: ModelHandler; captured: ModelRequest[] } {
  const captured: ModelRequest[] = [];
  return {
    handler: async (req) => {
      captured.push(req);
      return { content: "ok", model: req.model ?? "unknown" } satisfies ModelResponse;
    },
    captured,
  };
}

function captureStream(): { handler: ModelStreamHandler; captured: ModelRequest[] } {
  const captured: ModelRequest[] = [];
  return {
    handler: (req) => {
      captured.push(req);
      const iter: AsyncIterable<ModelChunk> = {
        async *[Symbol.asyncIterator]() {
          yield {
            kind: "done",
            response: { content: "ok", model: req.model ?? "unknown" },
          } as ModelChunk;
        },
      };
      return iter;
    },
    captured,
  };
}

function callModel(
  mw: KoiMiddleware,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  if (mw.wrapModelCall === undefined) throw new Error("no wrapModelCall");
  return mw.wrapModelCall(ctx, request, next);
}

function callStream(
  mw: KoiMiddleware,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelStreamHandler,
): AsyncIterable<ModelChunk> {
  if (mw.wrapModelStream === undefined) throw new Error("no wrapModelStream");
  return mw.wrapModelStream(ctx, request, next);
}

async function drain(stream: AsyncIterable<ModelChunk>): Promise<void> {
  for await (const _chunk of stream) void _chunk;
}

function first<T>(arr: readonly T[]): T {
  const x = arr[0];
  if (x === undefined) throw new Error("expected non-empty array");
  return x;
}

function requireFirstMessage(req: ModelRequest): InboundMessage {
  const m = req.messages[0];
  if (m === undefined) throw new Error("expected non-empty messages");
  return m;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("createPromptCacheMiddleware shape", () => {
  const mw = createPromptCacheMiddleware();
  test("name is 'prompt-cache'", () => {
    expect(mw.name).toBe("prompt-cache");
  });
  test("priority is 150", () => {
    expect(mw.priority).toBe(150);
  });
  test("phase is 'resolve'", () => {
    expect(mw.phase).toBe("resolve");
  });
  test("describeCapabilities returns label when enabled", () => {
    expect(mw.describeCapabilities(makeCtx())?.label).toBe("prompt-cache");
  });
  test("describeCapabilities returns undefined when disabled", () => {
    const off = createPromptCacheMiddleware({ enabled: false });
    expect(off.describeCapabilities(makeCtx())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reorder + hints
// ---------------------------------------------------------------------------

describe("reorder + hints", () => {
  test("reorders system before user and attaches hints", async () => {
    const mw = createPromptCacheMiddleware();
    const { handler, captured } = captureHandler();
    const request: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), bigSystem()],
    };

    await callModel(mw, makeCtx(), request, handler);

    expect(first(captured).messages.map((m) => m.senderId)).toEqual(["system", "user:1"]);
    const hints = readCacheHints(first(captured).metadata);
    expect(hints).toBeDefined();
    expect(hints?.provider).toBe("anthropic");
    expect(hints?.lastStableIndex).toBe(0);
    expect(hints?.staticPrefixTokens).toBeGreaterThanOrEqual(1024);
  });

  test("CACHE_HINTS_KEY survives downstream object spread (writes to metadata)", async () => {
    const mw = createPromptCacheMiddleware();
    const { handler, captured } = captureHandler();
    const request: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), bigSystem()],
    };
    await callModel(mw, makeCtx(), request, handler);
    // Simulate downstream middleware spreading the request
    const spread = { ...first(captured) };
    expect(readCacheHints(spread.metadata)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

describe("skip conditions", () => {
  test("disabled: passes request through unchanged", async () => {
    const mw = createPromptCacheMiddleware({ enabled: false });
    const { handler, captured } = captureHandler();
    const request: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), bigSystem()],
    };

    await callModel(mw, makeCtx(), request, handler);
    expect(captured[0]).toBe(request);
  });

  test("known provider not in allow-list: skips reorder + hints", async () => {
    const mw = createPromptCacheMiddleware({ providers: ["anthropic"] });
    const { handler, captured } = captureHandler();
    const request: ModelRequest = {
      model: "gpt-4o",
      messages: [msg("user:1", "u"), bigSystem()],
    };

    await callModel(mw, makeCtx(), request, handler);
    expect(captured[0]).toBe(request);
    expect(readCacheHints(first(captured).metadata)).toBeUndefined();
  });

  test("empty/unknown provider still attaches hints (provider='unknown')", async () => {
    const mw = createPromptCacheMiddleware();
    const { handler, captured } = captureHandler();
    const request: ModelRequest = {
      messages: [msg("user:1", "u"), bigSystem()],
    };

    await callModel(mw, makeCtx(), request, handler);
    const hints = readCacheHints(first(captured).metadata);
    expect(hints?.provider).toBe("unknown");
    expect(requireFirstMessage(first(captured)).senderId).toBe("system");
  });

  test("static prefix below threshold: no hints", async () => {
    const mw = createPromptCacheMiddleware({ staticPrefixMinTokens: 1024 });
    const { handler, captured } = captureHandler();
    const request: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("system", "tiny"), msg("user:1", "u")],
    };

    await callModel(mw, makeCtx(), request, handler);
    expect(captured[0]).toBe(request);
  });

  test("no static messages: no hints", async () => {
    const mw = createPromptCacheMiddleware();
    const { handler, captured } = captureHandler();
    const request: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), msg("assistant", "a")],
    };

    await callModel(mw, makeCtx(), request, handler);
    expect(captured[0]).toBe(request);
  });
});

// ---------------------------------------------------------------------------
// readCacheHints
// ---------------------------------------------------------------------------

describe("readCacheHints", () => {
  test("undefined metadata → undefined", () => {
    expect(readCacheHints(undefined)).toBeUndefined();
  });

  test("metadata without key → undefined", () => {
    expect(readCacheHints({ other: "x" })).toBeUndefined();
  });

  test("round-trip with valid hints", () => {
    const hints = { provider: "anthropic", lastStableIndex: 1, staticPrefixTokens: 2048 };
    const meta = { [CACHE_HINTS_KEY]: hints };
    expect(readCacheHints(meta)).toEqual(hints);
  });
});

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

describe("wrapModelStream", () => {
  test("applies same transform to streaming requests", async () => {
    const mw = createPromptCacheMiddleware();
    const { handler, captured } = captureStream();
    const request: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), bigSystem()],
    };

    await drain(callStream(mw, makeCtx(), request, handler));

    expect(first(captured).messages.map((m) => m.senderId)).toEqual(["system", "user:1"]);
    expect(readCacheHints(first(captured).metadata)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Corner cases — stability, threshold boundary, parity across hooks
// ---------------------------------------------------------------------------

describe("corner cases", () => {
  test("reorder is stable across turns: same input → same output (cache-hit precondition)", async () => {
    const mw = createPromptCacheMiddleware();
    const { handler, captured } = captureHandler();
    const requestA: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), bigSystem(), msg("assistant", "a")],
    };
    const requestB: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), bigSystem(), msg("assistant", "a")],
    };

    await callModel(mw, makeCtx(), requestA, handler);
    await callModel(mw, makeCtx(), requestB, handler);

    expect(captured).toHaveLength(2);
    const a = first(captured);
    const b = captured[1];
    if (b === undefined) throw new Error("expected second capture");

    expect(a.messages.map((m) => m.senderId)).toEqual(b.messages.map((m) => m.senderId));
    expect(readCacheHints(a.metadata)).toEqual(readCacheHints(b.metadata));
  });

  test("wrapModelStream and wrapModelCall produce identical hints for the same input", async () => {
    const mw = createPromptCacheMiddleware();
    const callPath = captureHandler();
    const streamPath = captureStream();
    const request: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), bigSystem()],
    };

    await callModel(mw, makeCtx(), request, callPath.handler);
    await drain(callStream(mw, makeCtx(), request, streamPath.handler));

    const a = readCacheHints(first(callPath.captured).metadata);
    const b = readCacheHints(first(streamPath.captured).metadata);
    expect(a).toEqual(b);
    expect(first(callPath.captured).messages).toEqual(first(streamPath.captured).messages);
  });

  test("downstream object spread preserves CACHE_HINTS_KEY across multiple cloning passes", async () => {
    const mw = createPromptCacheMiddleware();
    const { handler, captured } = captureHandler();
    const request: ModelRequest = {
      model: "claude-sonnet-4-5",
      messages: [msg("user:1", "u"), bigSystem()],
    };

    await callModel(mw, makeCtx(), request, handler);
    let r: ModelRequest = first(captured);
    // Three nested spread passes simulate downstream MW chains
    r = { ...r, metadata: { ...r.metadata } };
    r = { ...r, metadata: { ...r.metadata } };
    r = { ...r, metadata: { ...r.metadata } };
    expect(readCacheHints(r.metadata)).toBeDefined();
  });
});
