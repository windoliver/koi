/**
 * Regression tests for createSessionTranscriptMiddleware.
 *
 * Covers:
 * - Successful completion appends text + tool-call entries
 * - Done-only adapter (no text_delta) uses done.response.content
 * - Aborted/erroring stream does NOT append any entries
 */

import { describe, expect, test } from "bun:test";
import type { ModelChunk, ModelRequest, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { createSessionTranscriptMiddleware } from "../middleware/session-transcript.js";
import { createInMemoryTranscript } from "../transcript/memory-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SID = sessionId("mw-test-session");

function makeTurnContext(turnIndex = 0): TurnContext {
  return {
    session: { agentId: "test-agent", sessionId: SID, runId: runId("r"), metadata: {} },
    turnIndex,
    turnId: turnId("t"),
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(text = "hello"): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text", text }],
        senderId: "user",
        timestamp: 1000,
      },
    ],
    tools: [],
    model: "test-model",
    systemPrompt: undefined,
  };
}

async function* makeChunks(chunks: ModelChunk[]): AsyncIterable<ModelChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function drainStream(stream: AsyncIterable<ModelChunk>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of stream) {
    // drain
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionTranscriptMiddleware — completion semantics", () => {
  test("successful stream with text_delta + done appends assistant entry", async () => {
    const transcript = createInMemoryTranscript();
    const mw = createSessionTranscriptMiddleware({ transcript, sessionId: SID });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "Hello " },
      { kind: "text_delta", delta: "world" },
      { kind: "done", response: { content: "Hello world", model: "m" } },
    ];

    if (!mw.wrapModelStream) throw new Error("wrapModelStream not defined");
    const stream = mw.wrapModelStream(makeTurnContext(), makeModelRequest(), () =>
      makeChunks(chunks),
    );
    await drainStream(stream);

    // Let fire-and-forget appends settle
    await new Promise((r) => setTimeout(r, 10));

    const result = await transcript.load(SID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // user entry + assistant entry
      expect(result.value.entries.length).toBe(2);
      const assistantEntry = result.value.entries.find((e) => e.role === "assistant");
      expect(assistantEntry?.content).toBe("Hello world");
    }
  });

  test("done-only adapter (no text_delta) falls back to done.response.content", async () => {
    const transcript = createInMemoryTranscript();
    const mw = createSessionTranscriptMiddleware({ transcript, sessionId: SID });

    const chunks: ModelChunk[] = [
      // No text_delta — adapter emits content only in the done chunk
      { kind: "done", response: { content: "Full response", model: "m" } },
    ];

    if (!mw.wrapModelStream) throw new Error("wrapModelStream not defined");
    const stream = mw.wrapModelStream(makeTurnContext(), makeModelRequest(), () =>
      makeChunks(chunks),
    );
    await drainStream(stream);
    await new Promise((r) => setTimeout(r, 10));

    const result = await transcript.load(SID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const assistantEntry = result.value.entries.find((e) => e.role === "assistant");
      expect(assistantEntry?.content).toBe("Full response");
    }
  });

  test("aborted stream (error before done) does NOT append assistant entry", async () => {
    const transcript = createInMemoryTranscript();
    const mw = createSessionTranscriptMiddleware({ transcript, sessionId: SID });

    async function* abortedStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "partial..." };
      throw new Error("stream aborted");
    }

    if (!mw.wrapModelStream) throw new Error("wrapModelStream not defined");
    const stream = mw.wrapModelStream(makeTurnContext(), makeModelRequest(), abortedStream);
    try {
      await drainStream(stream);
    } catch {
      // expected — the stream throws
    }
    await new Promise((r) => setTimeout(r, 10));

    const result = await transcript.load(SID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the user entry should exist — no assistant entry from the aborted stream
      const assistantEntry = result.value.entries.find((e) => e.role === "assistant");
      expect(assistantEntry).toBeUndefined();
    }
  });

  test("stream with tool calls records tool_call entry", async () => {
    const transcript = createInMemoryTranscript();
    const mw = createSessionTranscriptMiddleware({ transcript, sessionId: SID });

    const chunks: ModelChunk[] = [
      { kind: "tool_call_start", toolName: "Glob", callId: "call-1" as never },
      { kind: "tool_call_delta", callId: "call-1" as never, delta: '{"pattern":"**/*.ts"}' },
      { kind: "tool_call_end", callId: "call-1" as never },
      { kind: "done", response: { content: "", model: "m" } },
    ];

    if (!mw.wrapModelStream) throw new Error("wrapModelStream not defined");
    const stream = mw.wrapModelStream(makeTurnContext(), makeModelRequest(), () =>
      makeChunks(chunks),
    );
    await drainStream(stream);
    await new Promise((r) => setTimeout(r, 10));

    const result = await transcript.load(SID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const toolEntry = result.value.entries.find((e) => e.role === "tool_call");
      expect(toolEntry).toBeDefined();
      if (toolEntry !== undefined) {
        const parsed = JSON.parse(toolEntry.content) as Array<{ toolName: string; args: string }>;
        expect(parsed[0]?.toolName).toBe("Glob");
        expect(parsed[0]?.args).toBe('{"pattern":"**/*.ts"}');
      }
    }
  });

  test("done with error stopReason does NOT append assistant entry", async () => {
    const transcript = createInMemoryTranscript();
    const mw = createSessionTranscriptMiddleware({ transcript, sessionId: SID });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "partial..." },
      { kind: "done", response: { content: "partial...", model: "m", stopReason: "error" } },
    ];

    if (!mw.wrapModelStream) throw new Error("wrapModelStream not defined");
    const stream = mw.wrapModelStream(makeTurnContext(), makeModelRequest(), () =>
      makeChunks(chunks),
    );
    await drainStream(stream);

    const result = await transcript.load(SID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // "error" stopReason → semantic-retry will retry; do not persist
      const assistantEntry = result.value.entries.find((e) => e.role === "assistant");
      expect(assistantEntry).toBeUndefined();
    }
  });

  test("done with hook_blocked stopReason does NOT append assistant entry", async () => {
    const transcript = createInMemoryTranscript();
    const mw = createSessionTranscriptMiddleware({ transcript, sessionId: SID });

    const chunks: ModelChunk[] = [
      { kind: "done", response: { content: "", model: "m", stopReason: "hook_blocked" } },
    ];

    if (!mw.wrapModelStream) throw new Error("wrapModelStream not defined");
    const stream = mw.wrapModelStream(makeTurnContext(), makeModelRequest(), () =>
      makeChunks(chunks),
    );
    await drainStream(stream);

    const result = await transcript.load(SID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const assistantEntry = result.value.entries.find((e) => e.role === "assistant");
      expect(assistantEntry).toBeUndefined();
    }
  });
});
