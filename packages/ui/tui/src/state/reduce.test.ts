import { describe, expect, test } from "bun:test";
import { createInitialState } from "./initial.js";
import { reduce } from "./reduce.js";
import {
  assistantMsg,
  blockAt,
  engineEvent,
  lastAssistantText,
  lastMessage,
  messageAt,
  stateWith,
  systemMsg,
  testCallId,
  userMsg,
} from "./test-helpers.js";
import type { TuiAssistantBlock, TuiMessage } from "./types.js";
import { COMPACT_THRESHOLD, MAX_MESSAGES, MAX_TOOL_OUTPUT_CHARS } from "./types.js";

// ---------------------------------------------------------------------------
// Shared output fixture for "done" events
// ---------------------------------------------------------------------------

const DONE_OUTPUT = {
  content: [] as const,
  stopReason: "completed" as const,
  metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
};

// ---------------------------------------------------------------------------
// add_user_message
// ---------------------------------------------------------------------------

describe("reduce — add_user_message", () => {
  test("appends user message to empty list", () => {
    const state = createInitialState();
    const next = reduce(state, {
      kind: "add_user_message",
      id: "user-1",
      blocks: [{ kind: "text", text: "hello" }],
    });
    expect(next.messages).toHaveLength(1);
    const msg = messageAt(next, 0);
    expect(msg.kind).toBe("user");
    expect(msg.id).toBe("user-1");
    if (msg.kind === "user") {
      expect(msg.blocks[0]).toEqual({ kind: "text", text: "hello" });
    }
  });

  test("preserves existing messages", () => {
    const state = stateWith({ messages: [systemMsg("welcome")] });
    const next = reduce(state, {
      kind: "add_user_message",
      id: "user-1",
      blocks: [{ kind: "text", text: "hi" }],
    });
    expect(next.messages).toHaveLength(2);
    expect(messageAt(next, 0).kind).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// engine_event — turn_start / turn_end / done
// ---------------------------------------------------------------------------

describe("reduce — engine_event — turn lifecycle", () => {
  test("turn_start creates a new streaming assistant message", () => {
    const state = createInitialState();
    const next = reduce(state, engineEvent({ kind: "turn_start", turnIndex: 0 }));
    expect(next.messages).toHaveLength(1);
    const msg = lastMessage(next);
    expect(msg.kind).toBe("assistant");
    expect(msg.id).toBe("assistant-0");
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(true);
      expect(msg.blocks).toHaveLength(0);
    }
  });

  test("turn_end marks assistant message as not streaming", () => {
    const state = stateWith({
      messages: [assistantMsg("hello", { id: "assistant-0", streaming: true })],
    });
    const next = reduce(state, engineEvent({ kind: "turn_end", turnIndex: 0 }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
    }
  });

  test("done marks streaming false on current assistant message", () => {
    const state = stateWith({
      messages: [assistantMsg("result", { id: "assistant-0", streaming: true })],
    });
    const next = reduce(state, engineEvent({ kind: "done", output: DONE_OUTPUT }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
    }
  });

  test("turn_start without prior turn_end auto-closes previous turn", () => {
    const state = stateWith({
      messages: [assistantMsg("first", { id: "assistant-0", streaming: true })],
    });
    const next = reduce(state, engineEvent({ kind: "turn_start", turnIndex: 1 }));
    expect(next.messages).toHaveLength(2);
    const first = messageAt(next, 0);
    if (first.kind === "assistant") {
      expect(first.streaming).toBe(false);
    }
    const second = messageAt(next, 1);
    if (second.kind === "assistant") {
      expect(second.streaming).toBe(true);
      expect(second.id).toBe("assistant-1");
    }
  });

  test("turn_start finalizes running tool calls from previous turn as error", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "text", text: "calling tool" },
      { kind: "tool_call", callId: "call-1", toolName: "bash", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const next = reduce(state, engineEvent({ kind: "turn_start", turnIndex: 1 }));
    expect(next.messages).toHaveLength(2);
    const prev = messageAt(next, 0);
    if (prev.kind === "assistant") {
      expect(prev.streaming).toBe(false);
      const tool = prev.blocks.find((b) => b.kind === "tool_call");
      if (tool?.kind === "tool_call") {
        expect(tool.status).toBe("error");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// engine_event — text_delta
// ---------------------------------------------------------------------------

describe("reduce — engine_event — text_delta", () => {
  test("appends delta to current assistant message text block", () => {
    const state = stateWith({
      messages: [assistantMsg("hello", { id: "assistant-0", streaming: true })],
    });
    const next = reduce(state, engineEvent({ kind: "text_delta", delta: " world" }));
    expect(lastAssistantText(next)).toBe("hello world");
  });

  test("creates text block on assistant with no blocks", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const next = reduce(state, engineEvent({ kind: "text_delta", delta: "hi" }));
    expect(lastAssistantText(next)).toBe("hi");
  });

  test("concatenates multiple deltas", () => {
    let state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    state = reduce(state, engineEvent({ kind: "text_delta", delta: "one" }));
    state = reduce(state, engineEvent({ kind: "text_delta", delta: " two" }));
    state = reduce(state, engineEvent({ kind: "text_delta", delta: " three" }));
    expect(lastAssistantText(state)).toBe("one two three");
  });
});

// ---------------------------------------------------------------------------
// engine_event — thinking_delta
// ---------------------------------------------------------------------------

describe("reduce — engine_event — thinking_delta", () => {
  test("creates thinking block on assistant message", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const next = reduce(state, engineEvent({ kind: "thinking_delta", delta: "let me think" }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      expect(msg.blocks).toHaveLength(1);
      const block = blockAt(msg, 0);
      expect(block.kind).toBe("thinking");
      if (block.kind === "thinking") {
        expect(block.text).toBe("let me think");
      }
    }
  });

  test("empty thinking_delta is a no-op", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const next = reduce(state, engineEvent({ kind: "thinking_delta", delta: "" }));
    expect(next).toBe(state);
  });

  test("appends to existing thinking block", () => {
    const state = stateWith({
      messages: [
        assistantMsg("", {
          id: "assistant-0",
          streaming: true,
          blocks: [{ kind: "thinking", text: "hmm" }],
        }),
      ],
    });
    const next = reduce(state, engineEvent({ kind: "thinking_delta", delta: "..." }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "thinking") {
        expect(block.text).toBe("hmm...");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// engine_event — tool_call lifecycle
// ---------------------------------------------------------------------------

describe("reduce — engine_event — tool_call", () => {
  test("tool_call_start adds running tool block", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "tool_call_start",
        toolName: "read_file",
        callId: testCallId("call-1"),
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      expect(msg.blocks).toHaveLength(1);
      const block = blockAt(msg, 0);
      expect(block.kind).toBe("tool_call");
      if (block.kind === "tool_call") {
        expect(block.toolName).toBe("read_file");
        expect(block.callId).toBe("call-1");
        expect(block.status).toBe("running");
        expect(block.args).toBeUndefined();
        expect(block.result).toBeUndefined();
      }
    }
  });

  test("tool_call_start with args captures initial arguments", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "tool_call_start",
        toolName: "read_file",
        callId: testCallId("call-1"),
        args: { path: "foo.ts" },
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.args).toBe('{"path":"foo.ts"}');
      }
    }
  });

  test("tool_call_start args without any deltas are preserved through tool_call_end", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    let next = reduce(
      state,
      engineEvent({
        kind: "tool_call_start",
        toolName: "ls",
        callId: testCallId("call-1"),
        args: { dir: "." },
      }),
    );
    // No tool_call_delta events — args came on start
    next = reduce(
      next,
      engineEvent({
        kind: "tool_call_end",
        callId: testCallId("call-1"),
        result: { files: ["a.ts"] },
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.status).toBe("complete");
        expect(block.args).toBe('{"dir":"."}');
        expect(block.result).toBe('{"files":["a.ts"]}');
      }
    }
  });

  test("tool_call_delta accumulates argument fragments into args", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "read_file", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    let next = reduce(
      state,
      engineEvent({ kind: "tool_call_delta", callId: testCallId("call-1"), delta: '{"path":' }),
    );
    next = reduce(
      next,
      engineEvent({ kind: "tool_call_delta", callId: testCallId("call-1"), delta: '"foo.ts"}' }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.args).toBe('{"path":"foo.ts"}');
      }
    }
  });

  test("tool_call_end marks tool as complete and stores result", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "tool_call",
        callId: "call-1",
        toolName: "ls",
        status: "running",
        args: '{"dir":"."}',
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const toolResult = {
      toolName: "ls",
      callId: "call-1",
      rawArgs: '{"dir":"."}',
      parsedArgs: { dir: "." },
    };
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_end", callId: testCallId("call-1"), result: toolResult }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.status).toBe("complete");
        expect(block.result).toBe(JSON.stringify(toolResult));
        expect(block.args).toBe('{"dir":"."}'); // args preserved
      }
    }
  });

  test("interleaved text_delta and tool_call_delta accumulate to separate blocks", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "text", text: "analyzing" },
      { kind: "tool_call", callId: "call-1", toolName: "grep", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    let next = reduce(
      state,
      engineEvent({ kind: "tool_call_delta", callId: testCallId("call-1"), delta: "found: x" }),
    );
    // text_delta after tool_call creates a NEW text block (not appending to pre-tool text)
    next = reduce(next, engineEvent({ kind: "text_delta", delta: "..." }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      // Original text block is untouched
      expect(blockAt(msg, 0)).toEqual({ kind: "text", text: "analyzing" });
      // Tool block has accumulated arg fragments
      const toolBlock = msg.blocks.find((b) => b.kind === "tool_call");
      if (toolBlock?.kind === "tool_call") {
        expect(toolBlock.args).toBe("found: x");
      }
      // New text block was created after the tool
      expect(msg.blocks).toHaveLength(3);
      expect(blockAt(msg, 2)).toEqual({ kind: "text", text: "..." });
    }
  });

  test("duplicate callId updates existing tool block", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "tool_call",
        callId: "call-1",
        toolName: "bash",
        status: "running",
        args: '{"cmd":"old"}',
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "tool_call_start",
        toolName: "bash",
        callId: testCallId("call-1"),
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      // Should have same number of blocks (updated, not duplicated)
      const toolBlocks = msg.blocks.filter((b) => b.kind === "tool_call" && b.callId === "call-1");
      expect(toolBlocks).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// engine_event — full tool call lifecycle integration
// ---------------------------------------------------------------------------

describe("reduce — engine_event — full lifecycle", () => {
  test("turn_start → text → thinking → tool_start → tool_delta → tool_end → text → turn_end", () => {
    let state = createInitialState();

    // 1. Turn starts
    state = reduce(state, engineEvent({ kind: "turn_start", turnIndex: 0 }));
    expect(state.messages).toHaveLength(1);

    // 2. Thinking first
    state = reduce(state, engineEvent({ kind: "thinking_delta", delta: "Let me " }));
    state = reduce(state, engineEvent({ kind: "thinking_delta", delta: "analyze this." }));

    // 3. Text response
    state = reduce(state, engineEvent({ kind: "text_delta", delta: "I'll read " }));
    state = reduce(state, engineEvent({ kind: "text_delta", delta: "the file." }));

    // 4. Tool call
    state = reduce(
      state,
      engineEvent({
        kind: "tool_call_start",
        toolName: "read_file",
        callId: testCallId("call-1"),
      }),
    );
    state = reduce(
      state,
      engineEvent({ kind: "tool_call_delta", callId: testCallId("call-1"), delta: '{"path":' }),
    );
    state = reduce(
      state,
      engineEvent({
        kind: "tool_call_delta",
        callId: testCallId("call-1"),
        delta: '"src/index.ts"}',
      }),
    );
    state = reduce(
      state,
      engineEvent({
        kind: "tool_call_end",
        callId: testCallId("call-1"),
        result: { content: "file contents" },
      }),
    );

    // 5. Post-tool text
    state = reduce(state, engineEvent({ kind: "text_delta", delta: "Here's what I found." }));

    // 6. Turn ends
    state = reduce(state, engineEvent({ kind: "turn_end", turnIndex: 0 }));

    // Assert final message shape
    const msg = lastMessage(state);
    expect(msg.kind).toBe("assistant");
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
      expect(msg.blocks).toHaveLength(4); // thinking, text, tool_call, text

      const [b0, b1, b2, b3] = msg.blocks;
      expect(b0?.kind).toBe("thinking");
      if (b0?.kind === "thinking") expect(b0.text).toBe("Let me analyze this.");

      expect(b1?.kind).toBe("text");
      if (b1?.kind === "text") expect(b1.text).toBe("I'll read the file.");

      expect(b2?.kind).toBe("tool_call");
      if (b2?.kind === "tool_call") {
        expect(b2.toolName).toBe("read_file");
        expect(b2.status).toBe("complete");
        expect(b2.args).toBe('{"path":"src/index.ts"}');
        expect(b2.result).toBe('{"content":"file contents"}');
      }

      expect(b3?.kind).toBe("text");
      if (b3?.kind === "text") expect(b3.text).toBe("Here's what I found.");
    }
  });
});

// ---------------------------------------------------------------------------
// engine_event — tool output cap
// ---------------------------------------------------------------------------

describe("reduce — engine_event — tool args cap", () => {
  test("caps tool_call_start initial args at MAX_TOOL_OUTPUT_CHARS", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const largeValue = "v".repeat(MAX_TOOL_OUTPUT_CHARS + 100);
    const next = reduce(
      state,
      engineEvent({
        kind: "tool_call_start",
        toolName: "big_tool",
        callId: testCallId("call-1"),
        args: { data: largeValue },
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.args).toBeDefined();
        expect(block.args?.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
      }
    }
  });

  test("caps tool args at MAX_TOOL_OUTPUT_CHARS (tail-sliced)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "cat", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const largeChunk = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 5000);
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_delta", callId: testCallId("call-1"), delta: largeChunk }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.args?.length).toBe(MAX_TOOL_OUTPUT_CHARS);
        expect(block.args?.endsWith("x")).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tool result cap
// ---------------------------------------------------------------------------

describe("reduce — engine_event — tool result cap", () => {
  test("caps tool_call_end result at MAX_TOOL_OUTPUT_CHARS", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "cat", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const largeResult = "r".repeat(MAX_TOOL_OUTPUT_CHARS + 5000);
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_end", callId: testCallId("call-1"), result: largeResult }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(typeof block.result).toBe("string");
        expect((block.result as string).length).toBe(MAX_TOOL_OUTPUT_CHARS);
      }
    }
  });

  test("caps non-string tool result via JSON serialization", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "big", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const bigObj = { data: "x".repeat(MAX_TOOL_OUTPUT_CHARS + 100) };
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_end", callId: testCallId("call-1"), result: bigObj }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(typeof block.result).toBe("string");
        expect((block.result as string).length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
      }
    }
  });

  test("handles function result without crashing", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "fn", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    // JSON.stringify(() => {}) returns undefined — must not crash
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_end", callId: testCallId("call-1"), result: () => {} }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.status).toBe("complete");
        expect(block.result).toBe("[unserializable]");
      }
    }
  });

  test("handles symbol result without crashing", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "sym", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_end", callId: testCallId("call-1"), result: Symbol("test") }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.status).toBe("complete");
        expect(block.result).toBe("[unserializable]");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Text blocks are NOT capped (user-facing content)
// ---------------------------------------------------------------------------

describe("reduce — text blocks unbounded", () => {
  test("long text_delta is preserved in full", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const largeText = "x".repeat(MAX_TOOL_OUTPUT_CHARS + 5000);
    const next = reduce(state, engineEvent({ kind: "text_delta", delta: largeText }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "text") {
        expect(block.text.length).toBe(MAX_TOOL_OUTPUT_CHARS + 5000);
      }
    }
  });

  test("long thinking_delta is preserved in full", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const largeText = "t".repeat(MAX_TOOL_OUTPUT_CHARS + 3000);
    const next = reduce(state, engineEvent({ kind: "thinking_delta", delta: largeText }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "thinking") {
        expect(block.text.length).toBe(MAX_TOOL_OUTPUT_CHARS + 3000);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases — orphan events
// ---------------------------------------------------------------------------

describe("reduce — edge cases", () => {
  test("text_delta before turn_start creates implicit assistant message", () => {
    const state = createInitialState();
    const next = reduce(state, engineEvent({ kind: "text_delta", delta: "orphan" }));
    expect(next.messages).toHaveLength(1);
    const msg = lastMessage(next);
    expect(msg.kind).toBe("assistant");
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(true);
      expect(msg.blocks).toHaveLength(1);
    }
    expect(lastAssistantText(next)).toBe("orphan");
  });

  test("tool_call_end without tool_call_start is a no-op", () => {
    const state = stateWith({
      messages: [assistantMsg("text", { id: "assistant-0", streaming: true })],
    });
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_end", callId: testCallId("unknown"), result: "x" }),
    );
    expect(next.messages).toEqual(state.messages);
  });

  test("tool_call_delta for unknown callId is a no-op", () => {
    const state = stateWith({
      messages: [assistantMsg("text", { id: "assistant-0", streaming: true })],
    });
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_delta", callId: testCallId("unknown"), delta: "data" }),
    );
    expect(next.messages).toEqual(state.messages);
  });

  test("empty text_delta is a no-op", () => {
    const state = stateWith({
      messages: [assistantMsg("hello", { id: "assistant-0", streaming: true })],
    });
    const next = reduce(state, engineEvent({ kind: "text_delta", delta: "" }));
    expect(next).toBe(state);
  });

  test("done mid-tool-call sets streaming=false and marks running tools as error", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "bash", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const next = reduce(state, engineEvent({ kind: "done", output: DONE_OUTPUT }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
      const tool = msg.blocks.find((b) => b.kind === "tool_call");
      if (tool?.kind === "tool_call") {
        expect(tool.status).toBe("error");
      }
    }
  });

  test("done with completed tools leaves them as complete", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "ls", status: "complete", result: "ok" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const next = reduce(state, engineEvent({ kind: "done", output: DONE_OUTPUT }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
      const tool = msg.blocks.find((b) => b.kind === "tool_call");
      if (tool?.kind === "tool_call") {
        expect(tool.status).toBe("complete");
      }
    }
  });

  test("done with mixed tool statuses only marks running ones as error", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "ls", status: "complete", result: "ok" },
      { kind: "tool_call", callId: "call-2", toolName: "bash", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const next = reduce(state, engineEvent({ kind: "done", output: DONE_OUTPUT }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const tool1 = msg.blocks.find((b) => b.kind === "tool_call" && b.callId === "call-1");
      const tool2 = msg.blocks.find((b) => b.kind === "tool_call" && b.callId === "call-2");
      if (tool1?.kind === "tool_call") expect(tool1.status).toBe("complete");
      if (tool2?.kind === "tool_call") expect(tool2.status).toBe("error");
    }
  });

  test("ignored engine events return same state reference", () => {
    const state = createInitialState();
    const next = reduce(state, engineEvent({ kind: "custom", type: "unknown", data: {} }));
    expect(next).toBe(state);
  });

  test("discovery:miss returns same state reference", () => {
    const state = createInitialState();
    const next = reduce(
      state,
      engineEvent({ kind: "discovery:miss", resolverSource: "test", timestamp: 0 }),
    );
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// set_view
// ---------------------------------------------------------------------------

describe("reduce — set_view", () => {
  test("transitions to new view", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_view", view: "sessions" });
    expect(next.activeView).toBe("sessions");
  });

  test("same view returns same reference", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_view", view: "conversation" });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// set_modal
// ---------------------------------------------------------------------------

describe("reduce — set_modal", () => {
  test("sets command-palette modal", () => {
    const state = createInitialState();
    const next = reduce(state, {
      kind: "set_modal",
      modal: { kind: "command-palette", query: "" },
    });
    expect(next.modal).toEqual({ kind: "command-palette", query: "" });
    expect(next.activeView).toBe("conversation");
  });

  test("sets permission-prompt modal", () => {
    const state = createInitialState();
    const next = reduce(state, {
      kind: "set_modal",
      modal: {
        kind: "permission-prompt",
        prompt: {
          requestId: "req-1",
          toolId: "bash",
          input: {},
          reason: "Tool requires approval",
          riskLevel: "medium",
        },
      },
    });
    expect(next.modal?.kind).toBe("permission-prompt");
  });

  test("dismisses modal with null", () => {
    const state = stateWith({
      modal: { kind: "command-palette", query: "test" },
    });
    const next = reduce(state, { kind: "set_modal", modal: null });
    expect(next.modal).toBeNull();
  });

  test("null to null returns same reference", () => {
    const state = createInitialState(); // modal starts as null
    const next = reduce(state, { kind: "set_modal", modal: null });
    expect(next).toBe(state);
  });

  test("dismiss preserves active view", () => {
    const state = stateWith({
      activeView: "sessions",
      modal: { kind: "command-palette", query: "" },
    });
    const next = reduce(state, { kind: "set_modal", modal: null });
    expect(next.activeView).toBe("sessions");
  });

  test("permission prompt while streaming preserves messages", () => {
    const state = stateWith({
      messages: [assistantMsg("streaming...", { streaming: true })],
    });
    const next = reduce(state, {
      kind: "set_modal",
      modal: {
        kind: "permission-prompt",
        prompt: {
          requestId: "req-1",
          toolId: "bash",
          input: {},
          reason: "Tool requires approval",
          riskLevel: "medium",
        },
      },
    });
    expect(next.messages).toHaveLength(1);
    expect(next.modal?.kind).toBe("permission-prompt");
  });
});

// ---------------------------------------------------------------------------
// permission_response
// ---------------------------------------------------------------------------

const TEST_PROMPT = {
  requestId: "req-1",
  toolId: "bash",
  input: { cmd: "rm -rf" },
  reason: "Tool requires approval",
  riskLevel: "high" as const,
};

describe("reduce — permission_response", () => {
  test("dismisses modal when requestId matches active prompt", () => {
    const state = stateWith({
      modal: { kind: "permission-prompt", prompt: TEST_PROMPT },
    });
    const next = reduce(state, {
      kind: "permission_response",
      requestId: "req-1",
      decision: { kind: "allow" },
    });
    expect(next.modal).toBeNull();
  });

  test("dismiss preserves all other state fields", () => {
    const state = stateWith({
      messages: [userMsg("hello")],
      activeView: "sessions",
      connectionStatus: "connected",
      layoutTier: "wide",
      zoomLevel: 2,
      modal: { kind: "permission-prompt", prompt: TEST_PROMPT },
    });
    const next = reduce(state, {
      kind: "permission_response",
      requestId: "req-1",
      decision: { kind: "deny", reason: "not allowed" },
    });
    expect(next.modal).toBeNull();
    expect(next.messages).toHaveLength(1);
    expect(next.activeView).toBe("sessions");
    expect(next.connectionStatus).toBe("connected");
    expect(next.layoutTier).toBe("wide");
    expect(next.zoomLevel).toBe(2);
  });

  test("always-allow decision dismisses modal", () => {
    const state = stateWith({
      modal: { kind: "permission-prompt", prompt: TEST_PROMPT },
    });
    const next = reduce(state, {
      kind: "permission_response",
      requestId: "req-1",
      decision: { kind: "always-allow", scope: "session" },
    });
    expect(next.modal).toBeNull();
  });

  test("stale requestId is a no-op (returns same reference)", () => {
    const state = stateWith({
      modal: { kind: "permission-prompt", prompt: TEST_PROMPT },
    });
    const next = reduce(state, {
      kind: "permission_response",
      requestId: "req-STALE",
      decision: { kind: "allow" },
    });
    expect(next).toBe(state);
  });

  test("response without active permission modal is a no-op", () => {
    const state = createInitialState();
    const next = reduce(state, {
      kind: "permission_response",
      requestId: "req-1",
      decision: { kind: "allow" },
    });
    expect(next).toBe(state);
  });

  test("response when command-palette is active is a no-op", () => {
    const state = stateWith({
      modal: { kind: "command-palette", query: "test" },
    });
    const next = reduce(state, {
      kind: "permission_response",
      requestId: "req-1",
      decision: { kind: "allow" },
    });
    expect(next).toBe(state);
  });

  test("response preserves streaming messages during permission flow", () => {
    const state = stateWith({
      messages: [assistantMsg("streaming...", { streaming: true })],
      modal: { kind: "permission-prompt", prompt: TEST_PROMPT },
    });
    const next = reduce(state, {
      kind: "permission_response",
      requestId: "req-1",
      decision: { kind: "allow" },
    });
    expect(next.modal).toBeNull();
    expect(next.messages).toHaveLength(1);
    const msg = messageAt(next, 0);
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// set_connection_status
// ---------------------------------------------------------------------------

describe("reduce — set_connection_status", () => {
  test("transitions connection status", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_connection_status", status: "connected" });
    expect(next.connectionStatus).toBe("connected");
  });

  test("same status returns same reference", () => {
    const state = stateWith({ connectionStatus: "connected" });
    const next = reduce(state, { kind: "set_connection_status", status: "connected" });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// set_layout
// ---------------------------------------------------------------------------

describe("reduce — set_layout", () => {
  test("transitions layout tier", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_layout", tier: "wide" });
    expect(next.layoutTier).toBe("wide");
  });

  test("same layout returns same reference", () => {
    const state = stateWith({ layoutTier: "normal" });
    const next = reduce(state, { kind: "set_layout", tier: "normal" });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// set_zoom
// ---------------------------------------------------------------------------

describe("reduce — set_zoom", () => {
  test("transitions zoom level", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_zoom", level: 2 });
    expect(next.zoomLevel).toBe(2);
  });

  test("same zoom level returns same reference", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_zoom", level: 1 });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// add_error
// ---------------------------------------------------------------------------

describe("reduce — add_error", () => {
  test("adds error block and closes streaming", () => {
    const state = stateWith({
      messages: [assistantMsg("text", { id: "assistant-0", streaming: true })],
    });
    const next = reduce(state, {
      kind: "add_error",
      code: "RATE_LIMIT",
      message: "API rate limit exceeded",
    });
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
      expect(msg.blocks).toHaveLength(2); // original text + error
      const errorBlock = msg.blocks.find((b) => b.kind === "error");
      if (errorBlock?.kind === "error") {
        expect(errorBlock.code).toBe("RATE_LIMIT");
        expect(errorBlock.message).toBe("API rate limit exceeded");
      }
    }
  });

  test("creates implicit assistant message if none exists", () => {
    const state = createInitialState();
    const next = reduce(state, {
      kind: "add_error",
      code: "CONNECTION",
      message: "Lost connection",
    });
    expect(next.messages).toHaveLength(1);
    const msg = lastMessage(next);
    expect(msg.kind).toBe("assistant");
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
      expect(msg.blocks).toHaveLength(1);
      const block = blockAt(msg, 0);
      expect(block.kind).toBe("error");
    }
  });

  test("creates new assistant when last message is user (not misattributed)", () => {
    const state = stateWith({
      messages: [
        assistantMsg("old response", { id: "assistant-0", streaming: false }),
        userMsg("follow-up question", "user-1"),
      ],
    });
    const next = reduce(state, {
      kind: "add_error",
      code: "TRANSPORT",
      message: "Connection lost",
    });
    // Error should be on a NEW assistant, not the old one
    expect(next.messages).toHaveLength(3);
    const oldAssistant = messageAt(next, 0);
    if (oldAssistant.kind === "assistant") {
      expect(oldAssistant.blocks.every((b) => b.kind !== "error")).toBe(true);
    }
    const errorAssistant = messageAt(next, 2);
    expect(errorAssistant.kind).toBe("assistant");
    if (errorAssistant.kind === "assistant") {
      expect(errorAssistant.streaming).toBe(false);
      const errorBlock = errorAssistant.blocks.find((b) => b.kind === "error");
      expect(errorBlock?.kind).toBe("error");
    }
  });

  test("finalizes running tool calls before appending error", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "text", text: "calling tool" },
      { kind: "tool_call", callId: "call-1", toolName: "bash", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const next = reduce(state, {
      kind: "add_error",
      code: "TRANSPORT",
      message: "Connection lost",
    });
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
      const tool = msg.blocks.find((b) => b.kind === "tool_call");
      if (tool?.kind === "tool_call") {
        expect(tool.status).toBe("error");
      }
      const errorBlock = msg.blocks.find((b) => b.kind === "error");
      if (errorBlock?.kind === "error") {
        expect(errorBlock.code).toBe("TRANSPORT");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// clear_messages
// ---------------------------------------------------------------------------

describe("reduce — clear_messages", () => {
  test("resets messages to empty", () => {
    const state = stateWith({
      messages: [userMsg("a"), assistantMsg("b"), systemMsg("c")],
    });
    const next = reduce(state, { kind: "clear_messages" });
    expect(next.messages).toHaveLength(0);
  });

  test("preserves all other state fields", () => {
    const state = stateWith({
      messages: [userMsg("a")],
      activeView: "sessions",
      modal: { kind: "command-palette", query: "x" },
      connectionStatus: "connected",
      layoutTier: "wide",
      zoomLevel: 2,
    });
    const next = reduce(state, { kind: "clear_messages" });
    expect(next.activeView).toBe("sessions");
    expect(next.modal).toEqual({ kind: "command-palette", query: "x" });
    expect(next.connectionStatus).toBe("connected");
    expect(next.layoutTier).toBe("wide");
    expect(next.zoomLevel).toBe(2);
  });

  test("clear on already empty returns same reference", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "clear_messages" });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

describe("reduce — message compaction", () => {
  test("no compaction below threshold", () => {
    const messages: readonly TuiMessage[] = Array.from({ length: MAX_MESSAGES }, (_, i) =>
      userMsg(`msg-${i}`, `user-${i}`),
    );
    const state = stateWith({ messages });
    const next = reduce(state, {
      kind: "add_user_message",
      id: "user-new",
      blocks: [{ kind: "text", text: "new" }],
    });
    expect(next.messages).toHaveLength(MAX_MESSAGES + 1);
  });

  test("compacts when reaching threshold", () => {
    const messages: readonly TuiMessage[] = Array.from({ length: COMPACT_THRESHOLD }, (_, i) =>
      userMsg(`msg-${i}`, `user-${i}`),
    );
    const state = stateWith({ messages });
    const next = reduce(state, {
      kind: "add_user_message",
      id: "user-final",
      blocks: [{ kind: "text", text: "trigger" }],
    });
    expect(next.messages).toHaveLength(MAX_MESSAGES);
  });

  test("newest messages survive compaction", () => {
    const messages: readonly TuiMessage[] = Array.from({ length: COMPACT_THRESHOLD }, (_, i) =>
      userMsg(`msg-${i}`, `user-${i}`),
    );
    const state = stateWith({ messages });
    const next = reduce(state, {
      kind: "add_user_message",
      id: "user-final",
      blocks: [{ kind: "text", text: "trigger" }],
    });
    const last = lastMessage(next);
    expect(last.id).toBe("user-final");
  });

  test("hysteresis: no re-compaction until threshold reached again", () => {
    const messages: readonly TuiMessage[] = Array.from({ length: MAX_MESSAGES }, (_, i) =>
      userMsg(`msg-${i}`, `user-${i}`),
    );
    let state = stateWith({ messages });

    // Add 99 more — 1099 < 1100, should not compact
    for (let i = 0; i < 99; i++) {
      state = reduce(state, {
        kind: "add_user_message",
        id: `new-${i}`,
        blocks: [{ kind: "text", text: `new-${i}` }],
      });
    }
    expect(state.messages).toHaveLength(MAX_MESSAGES + 99);

    // One more reaches 1100 → compacts
    state = reduce(state, {
      kind: "add_user_message",
      id: "trigger",
      blocks: [{ kind: "text", text: "trigger" }],
    });
    expect(state.messages).toHaveLength(MAX_MESSAGES);
  });

  test("turn_start compacts when messages reach threshold", () => {
    const messages: readonly TuiMessage[] = Array.from({ length: COMPACT_THRESHOLD }, (_, i) =>
      userMsg(`msg-${i}`, `user-${i}`),
    );
    const state = stateWith({ messages });
    // turn_start appends an assistant message → should trigger compaction
    const next = reduce(state, engineEvent({ kind: "turn_start", turnIndex: 0 }));
    expect(next.messages.length).toBeLessThanOrEqual(MAX_MESSAGES + 1);
    // The new assistant message should be present
    const last = lastMessage(next);
    expect(last.kind).toBe("assistant");
  });

  test("orphan text_delta compacts when messages reach threshold", () => {
    const messages: readonly TuiMessage[] = Array.from({ length: COMPACT_THRESHOLD }, (_, i) =>
      userMsg(`msg-${i}`, `user-${i}`),
    );
    const state = stateWith({ messages });
    // Orphan delta creates an implicit assistant message → should trigger compaction
    const next = reduce(state, engineEvent({ kind: "text_delta", delta: "orphan" }));
    expect(next.messages.length).toBeLessThanOrEqual(MAX_MESSAGES + 1);
    expect(lastAssistantText(next)).toBe("orphan");
  });

  test("engine-event-only traffic stays bounded", () => {
    let state = createInitialState();
    // Simulate 1200 turns of engine-only traffic (no add_user_message)
    for (let i = 0; i < 1200; i++) {
      state = reduce(state, engineEvent({ kind: "turn_start", turnIndex: i }));
      state = reduce(state, engineEvent({ kind: "text_delta", delta: `turn ${i}` }));
      state = reduce(state, engineEvent({ kind: "turn_end", turnIndex: i }));
    }
    expect(state.messages.length).toBeLessThanOrEqual(COMPACT_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// Initial state snapshot
// ---------------------------------------------------------------------------

describe("createInitialState", () => {
  test("initial state shape", () => {
    expect(createInitialState()).toMatchSnapshot();
  });
});
