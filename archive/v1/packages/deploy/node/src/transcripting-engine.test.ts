import { describe, expect, mock, test } from "bun:test";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineState,
  SessionId,
  SessionTranscript,
  TranscriptEntry,
} from "@koi/core";
import { sessionId } from "@koi/core";
import { createTranscriptingEngine } from "./transcripting-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEngine(events: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "test-engine",
    capabilities: { text: true, images: false, files: false, audio: false },
    async *stream(_input: EngineInput): AsyncGenerator<EngineEvent> {
      for (const event of events) {
        yield event;
      }
    },
    async saveState(): Promise<EngineState> {
      return { engineId: "test-engine", data: { saved: true } };
    },
    async loadState(_state: EngineState): Promise<void> {
      // no-op
    },
    async dispose(): Promise<void> {
      // no-op
    },
  };
}

function createMockTranscript(): SessionTranscript & {
  readonly appended: Array<{ sessionId: SessionId; entries: readonly TranscriptEntry[] }>;
} {
  const appended: Array<{ sessionId: SessionId; entries: readonly TranscriptEntry[] }> = [];
  return {
    appended,
    append: mock((sid: SessionId, entries: readonly TranscriptEntry[]) => {
      appended.push({ sessionId: sid, entries });
      return { ok: true as const, value: undefined };
    }),
    load: mock(() => ({
      ok: true as const,
      value: { entries: [], skipped: [] },
    })),
    loadPage: mock(() => ({
      ok: true as const,
      value: { entries: [], total: 0, hasMore: false },
    })),
    compact: mock(() => ({ ok: true as const, value: undefined })),
    remove: mock(() => ({ ok: true as const, value: undefined })),
    close: mock(() => undefined),
  };
}

const testSessionId: SessionId = sessionId("test-session");
const textInput: EngineInput = { kind: "text", text: "hello" };

async function collectEvents(adapter: EngineAdapter, input: EngineInput): Promise<EngineEvent[]> {
  const collected: EngineEvent[] = [];
  for await (const event of adapter.stream(input)) {
    collected.push(event);
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTranscriptingEngine", () => {
  test("text input creates user transcript entry", async () => {
    const events: readonly EngineEvent[] = [{ kind: "turn_end", turnIndex: 0 }];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    await collectEvents(wrapped, textInput);
    await new Promise((r) => setTimeout(r, 10));

    // First append: user entry from text input
    expect(transcript.appended.length).toBeGreaterThanOrEqual(1);
    const userAppend = transcript.appended[0];
    expect(userAppend?.entries).toHaveLength(1);
    expect(userAppend?.entries[0]?.role).toBe("user");
    expect(userAppend?.entries[0]?.content).toBe("hello");
  });

  test("messages input creates user entries from content blocks", async () => {
    const events: readonly EngineEvent[] = [{ kind: "turn_end", turnIndex: 0 }];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    const messagesInput: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "first message" }],
          senderId: "user1",
          timestamp: Date.now(),
        },
        {
          content: [
            { kind: "text", text: "second " },
            { kind: "text", text: "message" },
          ],
          senderId: "user1",
          timestamp: Date.now(),
        },
      ],
    };

    await collectEvents(wrapped, messagesInput);
    await new Promise((r) => setTimeout(r, 10));

    const userAppend = transcript.appended[0];
    expect(userAppend?.entries).toHaveLength(2);
    expect(userAppend?.entries[0]?.role).toBe("user");
    expect(userAppend?.entries[0]?.content).toBe("first message");
    expect(userAppend?.entries[1]?.role).toBe("user");
    expect(userAppend?.entries[1]?.content).toBe("second \nmessage");
  });

  test("text_delta events accumulate into assistant entry on turn_end", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "Hello" },
      { kind: "text_delta", delta: " world" },
      { kind: "turn_end", turnIndex: 0 },
    ];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    await collectEvents(wrapped, textInput);
    await new Promise((r) => setTimeout(r, 10));

    // Find the append with assistant entry (second append, after user entry)
    const assistantAppend = transcript.appended.find((a) =>
      a.entries.some((e) => e.role === "assistant"),
    );
    expect(assistantAppend).toBeDefined();
    const assistantEntry = assistantAppend?.entries.find((e) => e.role === "assistant");
    expect(assistantEntry?.content).toBe("Hello world");
  });

  test("tool_call events create tool_call and tool_result entries", async () => {
    const events: readonly EngineEvent[] = [
      {
        kind: "tool_call_start",
        toolName: "search",
        callId: "tc1" as ReturnType<typeof import("@koi/core").toolCallId>,
        args: { query: "test" },
      },
      {
        kind: "tool_call_end",
        callId: "tc1" as ReturnType<typeof import("@koi/core").toolCallId>,
        result: "found it",
      },
      { kind: "turn_end", turnIndex: 0 },
    ];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    await collectEvents(wrapped, textInput);
    await new Promise((r) => setTimeout(r, 10));

    const toolAppend = transcript.appended.find((a) =>
      a.entries.some((e) => e.role === "tool_call"),
    );
    expect(toolAppend).toBeDefined();

    const toolCallEntry = toolAppend?.entries.find((e) => e.role === "tool_call");
    expect(toolCallEntry).toBeDefined();
    const toolCallData = JSON.parse(toolCallEntry?.content ?? "{}") as Record<string, unknown>;
    expect(toolCallData.toolName).toBe("search");
    expect(toolCallData.callId).toBe("tc1");

    const toolResultEntry = toolAppend?.entries.find((e) => e.role === "tool_result");
    expect(toolResultEntry).toBeDefined();
    const toolResultData = JSON.parse(toolResultEntry?.content ?? "{}") as Record<string, unknown>;
    expect(toolResultData.callId).toBe("tc1");
    expect(toolResultData.result).toBe("found it");
  });

  test("transcript failure does not block stream", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "hi" },
      { kind: "turn_end", turnIndex: 0 },
      { kind: "text_delta", delta: "after" },
    ];
    const failingTranscript = createMockTranscript();
    (failingTranscript.append as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error("disk full")),
    );

    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript: failingTranscript,
    });

    const collected = await collectEvents(wrapped, textInput);
    await new Promise((r) => setTimeout(r, 10));

    // Stream should complete despite transcript failures
    expect(collected).toHaveLength(3);
    expect(collected[2]?.kind).toBe("text_delta");
  });

  test("resume input does not create user entry", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "resumed" },
      { kind: "turn_end", turnIndex: 0 },
    ];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    const resumeInput: EngineInput = {
      kind: "resume",
      state: { engineId: "test", data: {} },
    };

    await collectEvents(wrapped, resumeInput);
    await new Promise((r) => setTimeout(r, 10));

    // No user entries should be created for resume input
    const userAppends = transcript.appended.filter((a) => a.entries.some((e) => e.role === "user"));
    expect(userAppends).toHaveLength(0);

    // But assistant entry should still be created
    const assistantAppend = transcript.appended.find((a) =>
      a.entries.some((e) => e.role === "assistant"),
    );
    expect(assistantAppend).toBeDefined();
    expect(assistantAppend?.entries.find((e) => e.role === "assistant")?.content).toBe("resumed");
  });

  test("done event also flushes accumulated text", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "final answer" },
      {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 100 },
        },
      },
    ];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    await collectEvents(wrapped, textInput);
    await new Promise((r) => setTimeout(r, 10));

    const assistantAppend = transcript.appended.find((a) =>
      a.entries.some((e) => e.role === "assistant"),
    );
    expect(assistantAppend).toBeDefined();
    expect(assistantAppend?.entries.find((e) => e.role === "assistant")?.content).toBe(
      "final answer",
    );
  });

  test("multiple turns create separate entries", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "turn one" },
      { kind: "turn_end", turnIndex: 0 },
      { kind: "text_delta", delta: "turn two" },
      { kind: "turn_end", turnIndex: 1 },
    ];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    await collectEvents(wrapped, textInput);
    await new Promise((r) => setTimeout(r, 10));

    // Find all appends with assistant entries (excluding the initial user append)
    const assistantAppends = transcript.appended.filter((a) =>
      a.entries.some((e) => e.role === "assistant"),
    );
    expect(assistantAppends).toHaveLength(2);
    expect(assistantAppends[0]?.entries.find((e) => e.role === "assistant")?.content).toBe(
      "turn one",
    );
    expect(assistantAppends[1]?.entries.find((e) => e.role === "assistant")?.content).toBe(
      "turn two",
    );
  });

  test("yields all events unmodified", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "hi" },
      { kind: "turn_end", turnIndex: 0 },
      {
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 50 },
        },
      },
    ];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    const collected = await collectEvents(wrapped, textInput);

    expect(collected).toHaveLength(3);
    expect(collected[0]).toStrictEqual(events[0]);
    expect(collected[1]).toStrictEqual(events[1]);
    expect(collected[2]).toStrictEqual(events[2]);
  });

  test("messages input maps senderId to correct transcript role", async () => {
    const events: readonly EngineEvent[] = [{ kind: "turn_end", turnIndex: 0 }];
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(createMockEngine(events), {
      sessionId: testSessionId,
      transcript,
    });

    const messagesInput: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "user says hi" }],
          senderId: "user-123",
          timestamp: Date.now(),
        },
        {
          content: [{ kind: "text", text: "assistant reply" }],
          senderId: "assistant-bot",
          timestamp: Date.now(),
        },
        {
          content: [{ kind: "text", text: "tool output" }],
          senderId: "tool-search",
          timestamp: Date.now(),
        },
        {
          content: [{ kind: "text", text: "system prompt" }],
          senderId: "system",
          timestamp: Date.now(),
        },
      ],
    };

    await collectEvents(wrapped, messagesInput);
    await new Promise((r) => setTimeout(r, 10));

    const append = transcript.appended[0];
    expect(append?.entries).toHaveLength(4);
    expect(append?.entries[0]?.role).toBe("user");
    expect(append?.entries[1]?.role).toBe("assistant");
    expect(append?.entries[2]?.role).toBe("tool_result");
    expect(append?.entries[3]?.role).toBe("system");
  });

  test("delegates optional properties to inner", () => {
    const inner = createMockEngine([]);
    const transcript = createMockTranscript();
    const wrapped = createTranscriptingEngine(inner, {
      sessionId: testSessionId,
      transcript,
    });

    expect(wrapped.engineId).toBe("test-engine");
    expect(wrapped.saveState).toBeDefined();
    expect(wrapped.loadState).toBeDefined();
    expect(wrapped.dispose).toBeDefined();
  });
});
