// Cache-bust: snapshot regenerated for #1728 plugin summary state field.
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
  toolResult,
  userMsg,
} from "./test-helpers.js";
import type { PluginSummary, TuiAction, TuiAssistantBlock, TuiMessage, TuiState } from "./types.js";
import {
  COMPACT_THRESHOLD,
  MAX_FINISHED_SPAWNS,
  MAX_MESSAGES,
  MAX_TOOL_RESULT_BYTES,
} from "./types.js";

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

  test("tool_call_start args without any deltas are preserved through tool_result", () => {
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
    // tool_result marks complete — this is the authoritative completion event.
    next = reduce(
      next,
      engineEvent({
        kind: "tool_result",
        callId: testCallId("call-1"),
        output: { files: ["a.ts"] },
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.status).toBe("complete");
        expect(block.args).toBe('{"dir":"."}');
        expect(block.result).toBeDefined();
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

  test("tool_call_end keeps tool running (completion happens on tool_result)", () => {
    // tool_call_end fires BEFORE execution (end of arg streaming). The block
    // must stay in "running" state so long-running tools don't appear complete
    // while still executing. tool_result is the authoritative completion event.
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
    const endPayload = {
      toolName: "ls",
      callId: "call-1",
      rawArgs: '{"dir":"."}',
      parsedArgs: { dir: "." },
    };
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_end", callId: testCallId("call-1"), result: endPayload }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.status).toBe("running"); // still running until tool_result
        expect(block.result).toBeUndefined();
        expect(block.args).toBe('{"dir":"."}'); // args preserved
      }
    }
  });

  test("tool_result marks tool as complete with result and duration", () => {
    const startedAt = Date.now() - 100;
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "tool_call",
        callId: "call-1",
        toolName: "ls",
        status: "running",
        startedAt,
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
      runningToolCount: 1,
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "tool_result",
        callId: testCallId("call-1"),
        output: "file1\nfile2",
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.status).toBe("complete");
        expect(block.result).toBeDefined();
        expect(block.durationMs).toBeGreaterThanOrEqual(100);
      }
    }
    expect(next.runningToolCount).toBe(0);
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
    // tool_result fires after execution — this is the authoritative completion event
    state = reduce(
      state,
      engineEvent({
        kind: "tool_result",
        callId: testCallId("call-1"),
        output: { content: "file contents" },
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
        // tool_result populated the result field
        expect(b2.result).toBeDefined();
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
  test("caps tool_call_start initial args at MAX_TOOL_RESULT_BYTES", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const largeValue = "v".repeat(MAX_TOOL_RESULT_BYTES + 100);
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
        expect(block.args?.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
      }
    }
  });

  test("caps tool args at MAX_TOOL_RESULT_BYTES (tail-sliced)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "cat", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    const largeChunk = "x".repeat(MAX_TOOL_RESULT_BYTES + 5000);
    const next = reduce(
      state,
      engineEvent({ kind: "tool_call_delta", callId: testCallId("call-1"), delta: largeChunk }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.args?.length).toBe(MAX_TOOL_RESULT_BYTES);
        expect(block.args?.endsWith("x")).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// tool_execution_started — permission-approval timer reset (#1759)
// ---------------------------------------------------------------------------

describe("reduce — tool_execution_started (approval-timer reset)", () => {
  test("resets startedAt on the running tool block with matching callId", async () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const afterStart = reduce(
      state,
      engineEvent({
        kind: "tool_call_start",
        toolName: "Bash",
        callId: testCallId("call-1"),
      }),
    );
    const msgStart = lastMessage(afterStart);
    if (msgStart.kind !== "assistant") throw new Error("expected assistant");
    const startedBlock = blockAt(msgStart, 0);
    if (startedBlock.kind !== "tool_call") throw new Error("expected tool_call");
    const initialStart = startedBlock.startedAt;
    expect(initialStart).toBeDefined();

    // Simulate user reading the permission prompt — advance wall-clock at
    // least 5ms so the post-approval startedAt is strictly later.
    await new Promise((r) => setTimeout(r, 5));

    const afterApproval = reduce(afterStart, {
      kind: "tool_execution_started",
      callId: "call-1",
    });
    const msgApproved = lastMessage(afterApproval);
    if (msgApproved.kind !== "assistant") throw new Error("expected assistant");
    const approvedBlock = blockAt(msgApproved, 0);
    if (approvedBlock.kind !== "tool_call") throw new Error("expected tool_call");
    expect(approvedBlock.startedAt).toBeDefined();
    expect(approvedBlock.startedAt ?? 0).toBeGreaterThan(initialStart ?? 0);
  });

  test("no-op when no running tool block matches the callId", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const afterStart = reduce(
      state,
      engineEvent({
        kind: "tool_call_start",
        toolName: "fs_read",
        callId: testCallId("call-1"),
      }),
    );
    const afterApproval = reduce(afterStart, {
      kind: "tool_execution_started",
      callId: "call-other", // different call
    });
    // No matching block — state unchanged
    expect(afterApproval).toBe(afterStart);
  });

  test("callId disambiguates queued prompts for the same tool name", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    // Two concurrent Bash calls — both running, only one is being approved
    const blocks: TuiAssistantBlock[] = [
      {
        kind: "tool_call",
        callId: "call-a",
        toolName: "Bash",
        status: "running",
        startedAt: 1_000,
      },
      {
        kind: "tool_call",
        callId: "call-b",
        toolName: "Bash",
        status: "running",
        startedAt: 2_000,
      },
    ];
    const withBoth = stateWith({
      ...state,
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks })],
    });
    // Approve call-a only
    const after = reduce(withBoth, {
      kind: "tool_execution_started",
      callId: "call-a",
    });
    const msg = lastMessage(after);
    if (msg.kind !== "assistant") throw new Error("expected assistant");
    const blockA = blockAt(msg, 0);
    const blockB = blockAt(msg, 1);
    if (blockA.kind !== "tool_call" || blockB.kind !== "tool_call") {
      throw new Error("expected tool_call");
    }
    // call-a reset to recent wall-clock
    expect(blockA.startedAt ?? 0).toBeGreaterThan(1_000);
    // call-b untouched — the other queued prompt
    expect(blockB.startedAt).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// Tool result cap — via tool_result event (not tool_call_end)
// ---------------------------------------------------------------------------

describe("reduce — engine_event — tool result cap", () => {
  test("caps large string result at MAX_TOOL_RESULT_BYTES (truncated: true)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "cat", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
    });
    const largeResult = "r".repeat(MAX_TOOL_RESULT_BYTES + 5000);
    const next = reduce(
      state,
      engineEvent({ kind: "tool_result", callId: testCallId("call-1"), output: largeResult }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.result).toBeDefined();
        expect(block.result?.truncated).toBe(true);
        expect(block.result?.byteSize).toBeGreaterThan(MAX_TOOL_RESULT_BYTES);
        if (typeof block.result?.value === "string") {
          expect(block.result.value.length).toBe(MAX_TOOL_RESULT_BYTES);
        }
      }
    }
  });

  test("caps large object result via JSON serialization (truncated: true)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "big", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
    });
    const bigObj = { data: "x".repeat(MAX_TOOL_RESULT_BYTES + 100) };
    const next = reduce(
      state,
      engineEvent({ kind: "tool_result", callId: testCallId("call-1"), output: bigObj }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.result).toBeDefined();
        expect(block.result?.truncated).toBe(true);
      }
    }
  });

  test("stores small result without truncation (truncated: false)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "ls", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "tool_result",
        callId: testCallId("call-1"),
        output: { files: ["a.ts"] },
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.result?.truncated).toBe(false);
        expect(block.result?.value).toEqual({ files: ["a.ts"] });
      }
    }
  });

  test("handles function output without crashing (unserializable)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "fn", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
    });
    // JSON.stringify(() => {}) returns undefined — must not crash
    const next = reduce(
      state,
      engineEvent({ kind: "tool_result", callId: testCallId("call-1"), output: () => {} }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.result?.value).toBe("[unserializable]");
        expect(block.result?.truncated).toBe(false);
      }
    }
  });

  test("handles symbol output without crashing (unserializable)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "sym", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
    });
    const next = reduce(
      state,
      engineEvent({ kind: "tool_result", callId: testCallId("call-1"), output: Symbol("test") }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.result?.value).toBe("[unserializable]");
      }
    }
  });

  test("tool_result for unknown callId warns and returns same state", () => {
    const state = stateWith({
      messages: [assistantMsg("text", { id: "assistant-0" })],
    });
    const next = reduce(
      state,
      engineEvent({ kind: "tool_result", callId: testCallId("unknown-id"), output: "data" }),
    );
    // No matching block — state unchanged (modulo reference equality via warn path)
    expect(next.messages).toEqual(state.messages);
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
    const largeText = "x".repeat(MAX_TOOL_RESULT_BYTES + 5000);
    const next = reduce(state, engineEvent({ kind: "text_delta", delta: largeText }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "text") {
        expect(block.text.length).toBe(MAX_TOOL_RESULT_BYTES + 5000);
      }
    }
  });

  test("long thinking_delta is preserved in full", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const largeText = "t".repeat(MAX_TOOL_RESULT_BYTES + 3000);
    const next = reduce(state, engineEvent({ kind: "thinking_delta", delta: largeText }));
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "thinking") {
        expect(block.text.length).toBe(MAX_TOOL_RESULT_BYTES + 3000);
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
      {
        kind: "tool_call",
        callId: "call-1",
        toolName: "ls",
        status: "complete",
        result: toolResult("ok"),
      },
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
      {
        kind: "tool_call",
        callId: "call-1",
        toolName: "ls",
        status: "complete",
        result: toolResult("ok"),
      },
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
// set_slash_query
// ---------------------------------------------------------------------------

describe("reduce — set_slash_query", () => {
  test("sets slashQuery to a string", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_slash_query", query: "cl" });
    expect(next.slashQuery).toBe("cl");
  });

  test("sets slashQuery to null", () => {
    const state = { ...createInitialState(), slashQuery: "cl" as string | null };
    const next = reduce(state, { kind: "set_slash_query", query: null });
    expect(next.slashQuery).toBeNull();
  });

  test("returns same reference when query unchanged", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_slash_query", query: null });
    expect(next).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// set_at_query / set_at_results (#10)
// ---------------------------------------------------------------------------

describe("reduce — set_at_query", () => {
  test("sets atQuery to a string", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_at_query", query: "src/m" });
    expect(next.atQuery).toBe("src/m");
  });

  test("sets atQuery to null", () => {
    const state = { ...createInitialState(), atQuery: "src/m" as string | null };
    const next = reduce(state, { kind: "set_at_query", query: null });
    expect(next.atQuery).toBeNull();
  });

  test("returns same reference when query unchanged", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "set_at_query", query: null });
    expect(next).toBe(state);
  });
});

describe("reduce — set_at_results", () => {
  test("sets atResults to file paths", () => {
    const state = createInitialState();
    const results = ["src/math.ts", "src/main.ts"];
    const next = reduce(state, { kind: "set_at_results", results });
    expect(next.atResults).toEqual(results);
  });

  test("sets atResults to empty array", () => {
    const state = { ...createInitialState(), atResults: ["src/math.ts"] };
    const next = reduce(state, { kind: "set_at_results", results: [] });
    expect(next.atResults).toEqual([]);
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

describe("reduce — set_modal — command palette query round-trip", () => {
  test("query survives permission-prompt interruption and restoration", () => {
    // Simulates the store-level half of the interruption handoff:
    // 1. Palette opened with empty query
    // 2. User types "cl" — palette dispatches query update
    // 3. Permission prompt takes over the modal slot
    // 4. Bridge restores palette with the saved query "cl"
    // Result: modal is command-palette with query "cl"
    let state = createInitialState();

    // Open palette
    state = reduce(state, { kind: "set_modal", modal: { kind: "command-palette", query: "" } });

    // User types "cl"
    state = reduce(state, { kind: "set_modal", modal: { kind: "command-palette", query: "cl" } });
    expect(state.modal).toEqual({ kind: "command-palette", query: "cl" });

    // Permission prompt takes over
    state = reduce(state, {
      kind: "set_modal",
      modal: {
        kind: "permission-prompt",
        prompt: {
          requestId: "r1",
          toolId: "bash",
          input: {},
          reason: "needs approval",
          riskLevel: "low",
        },
      },
    });
    expect(state.modal?.kind).toBe("permission-prompt");

    // Bridge restores palette with the last saved query
    state = reduce(state, { kind: "set_modal", modal: { kind: "command-palette", query: "cl" } });
    expect(state.modal).toEqual({ kind: "command-palette", query: "cl" });

    // Component's effect then promotes local "cle" (typed during interruption)
    // back into the store — simulate that dispatch:
    state = reduce(state, { kind: "set_modal", modal: { kind: "command-palette", query: "cle" } });
    expect(state.modal).toEqual({ kind: "command-palette", query: "cle" });
  });
});

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
// add_info
// ---------------------------------------------------------------------------

describe("reduce — add_info", () => {
  test("appends standalone notice when no active turn", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "add_info", message: "Goal added" });
    expect(next.messages).toHaveLength(1);
    const msg = lastMessage(next);
    expect(msg.kind).toBe("assistant");
    if (msg.kind === "assistant") {
      expect(msg.streaming).toBe(false);
      expect(msg.blocks).toHaveLength(1);
      expect(msg.blocks[0]?.kind).toBe("info");
    }
  });

  // Regression (#1851 Codex review): add_info dispatched mid-turn must not
  // strand the active streaming assistant. Inserting it AFTER the streaming
  // turn would make findLastAssistant target the notice, dropping later
  // tool_result / turn_end events on the floor.
  test("inserts BEFORE active streaming assistant (preserves lifecycle target)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "text", text: "working..." },
      { kind: "tool_call", callId: "call-1", toolName: "bash", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-active", streaming: true, blocks })],
    });
    const next = reduce(state, { kind: "add_info", message: "Goal added" });
    expect(next.messages).toHaveLength(2);
    // Notice inserted FIRST, streaming assistant remains LAST
    const notice = messageAt(next, 0);
    expect(notice.kind).toBe("assistant");
    if (notice.kind === "assistant") {
      expect(notice.streaming).toBe(false);
      expect(notice.blocks[0]?.kind).toBe("info");
    }
    const active = lastMessage(next);
    expect(active.kind).toBe("assistant");
    if (active.kind === "assistant") {
      // Streaming assistant unchanged — tool still running, still streaming
      expect(active.streaming).toBe(true);
      const tool = active.blocks.find((b) => b.kind === "tool_call");
      if (tool?.kind === "tool_call") {
        expect(tool.status).toBe("running");
      }
    }
  });

  test("subsequent tool_result + turn_end target the original streaming assistant", () => {
    // Full lifecycle reproduction of the Codex-flagged scenario:
    // turn_start + tool_call_start + add_info + tool_result + turn_end.
    // Verify the streaming assistant gets the tool_result and turn_end
    // (not the info notice) — this would have been broken before the fix.
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "bash", status: "running" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-active", streaming: true, blocks })],
      runningToolCount: 1,
    });
    const afterInfo = reduce(state, { kind: "add_info", message: "Goal added" });
    // The streaming assistant must still be the LAST message after add_info,
    // so future findLastAssistant calls hit it (not the notice).
    const lastIdx = afterInfo.messages.length - 1;
    const lastAfterInfo = afterInfo.messages[lastIdx];
    expect(lastAfterInfo?.kind).toBe("assistant");
    if (lastAfterInfo?.kind === "assistant") {
      expect(lastAfterInfo.streaming).toBe(true);
      expect(lastAfterInfo.id).toBe("assistant-active");
    }
  });

  // Regression (round 2 Codex): `turn_end` closes `streaming`, but long-
  // running tool_call blocks may still finish later. If add_info is
  // dispatched in that window, inserting it AFTER the now-non-streaming
  // assistant would make findLastAssistant target the notice on the
  // next tool_result, stranding the original tool as `running` and
  // leaking `runningToolCount`.
  test("inserts BEFORE assistant with running tool_call even when streaming=false", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "bash", status: "running" },
    ];
    const state = stateWith({
      // streaming=false simulates post-turn_end state
      messages: [assistantMsg("", { id: "assistant-post-end", streaming: false, blocks })],
      runningToolCount: 1,
    });
    const next = reduce(state, { kind: "add_info", message: "Goal added" });
    expect(next.messages).toHaveLength(2);
    const lastMsg = next.messages[next.messages.length - 1];
    expect(lastMsg?.kind).toBe("assistant");
    if (lastMsg?.kind === "assistant") {
      // Original assistant with running tool stays last — notice was inserted before it
      expect(lastMsg.id).toBe("assistant-post-end");
      const tool = lastMsg.blocks.find((b) => b.kind === "tool_call");
      expect(tool?.kind).toBe("tool_call");
    }
  });

  test("inserts BEFORE assistant with running spawn_call (spawn lifecycle safety)", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "spawn_call",
        agentId: "agent-1",
        agentName: "researcher",
        description: "Research task",
        status: "running",
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-with-spawn", streaming: false, blocks })],
    });
    const next = reduce(state, { kind: "add_info", message: "Info notice" });
    expect(next.messages).toHaveLength(2);
    const lastMsg = next.messages[next.messages.length - 1];
    if (lastMsg?.kind === "assistant") {
      expect(lastMsg.id).toBe("assistant-with-spawn");
    }
  });

  test("appends at end when no assistant has in-flight lifecycle", () => {
    // All tool_calls complete, no streaming, no running spawn — safe to append at end
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "bash", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("done", { id: "assistant-complete", streaming: false, blocks })],
    });
    const next = reduce(state, { kind: "add_info", message: "Info notice" });
    expect(next.messages).toHaveLength(2);
    // Notice appended at end since no in-flight lifecycle
    const lastMsg = next.messages[next.messages.length - 1];
    if (lastMsg?.kind === "assistant") {
      expect(lastMsg.blocks[0]?.kind).toBe("info");
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
    // structuredClone strips SolidJS reactive proxy symbols that leak
    // into snapshots when bunfig.toml preloads the Solid runtime.
    expect(structuredClone(createInitialState())).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// set_session_info
// ---------------------------------------------------------------------------

describe("reduce — set_session_info", () => {
  test("sets sessionInfo from null", () => {
    const state = createInitialState();
    const next = reduce(state, {
      kind: "set_session_info",
      modelName: "claude-opus-4-6",
      provider: "anthropic",
      sessionName: "my-session",
      sessionId: "sid-123",
    });
    expect(next.sessionInfo).toEqual({
      modelName: "claude-opus-4-6",
      provider: "anthropic",
      sessionName: "my-session",
      sessionId: "sid-123",
    });
  });

  test("overwrites existing sessionInfo (idempotent overwrite)", () => {
    const state = stateWith({
      sessionInfo: {
        modelName: "old-model",
        provider: "old-provider",
        sessionName: "old-session",
        sessionId: "old-sid",
      },
    });
    const next = reduce(state, {
      kind: "set_session_info",
      modelName: "new-model",
      provider: "openrouter",
      sessionName: "new-session",
      sessionId: "new-sid",
    });
    expect(next.sessionInfo).toEqual({
      modelName: "new-model",
      provider: "openrouter",
      sessionName: "new-session",
      sessionId: "new-sid",
    });
  });

  test("does not affect other state fields", () => {
    const state = stateWith({ activeView: "sessions", connectionStatus: "connected" });
    const next = reduce(state, {
      kind: "set_session_info",
      modelName: "m",
      provider: "p",
      sessionName: "s",
      sessionId: "x",
    });
    expect(next.activeView).toBe("sessions");
    expect(next.connectionStatus).toBe("connected");
    expect(next.messages).toEqual(state.messages);
  });
});

// ---------------------------------------------------------------------------
// rehydrate_messages
// ---------------------------------------------------------------------------

describe("reduce — rehydrate_messages", () => {
  test("replaces the message list wholesale on resume", () => {
    const state = stateWith({
      messages: [{ kind: "user", id: "pre-1", blocks: [{ kind: "text", text: "stale" }] }],
    });
    const next = reduce(state, {
      kind: "rehydrate_messages",
      messages: [
        {
          senderId: "user",
          timestamp: 1,
          content: [{ kind: "text", text: "hi" }],
        },
        {
          senderId: "assistant",
          timestamp: 2,
          content: [{ kind: "text", text: "hello" }],
        },
      ],
    });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]?.kind).toBe("user");
    expect(next.messages[1]?.kind).toBe("assistant");
  });

  test("converts assistant text blocks to TuiAssistantBlock text", () => {
    const next = reduce(createInitialState(), {
      kind: "rehydrate_messages",
      messages: [
        {
          senderId: "assistant",
          timestamp: 1,
          content: [{ kind: "text", text: "hello" }],
        },
      ],
    });
    const msg = next.messages[0];
    if (msg?.kind !== "assistant") throw new Error("expected assistant");
    expect(msg.blocks[0]).toEqual({ kind: "text", text: "hello" });
    expect(msg.streaming).toBe(false);
  });

  test("folds non-text blocks into a placeholder for assistants", () => {
    const next = reduce(createInitialState(), {
      kind: "rehydrate_messages",
      messages: [
        {
          senderId: "assistant",
          timestamp: 1,
          content: [{ kind: "image", url: "https://example.com/x.png" }],
        },
      ],
    });
    const msg = next.messages[0];
    if (msg?.kind !== "assistant") throw new Error("expected assistant");
    expect(msg.blocks[0]).toEqual({ kind: "text", text: "[image]" });
  });

  test("preserves user content blocks verbatim (no mapping)", () => {
    const block = { kind: "text" as const, text: "verbatim" };
    const next = reduce(createInitialState(), {
      kind: "rehydrate_messages",
      messages: [
        {
          senderId: "user",
          timestamp: 1,
          content: [block],
        },
      ],
    });
    const msg = next.messages[0];
    if (msg?.kind !== "user") throw new Error("expected user");
    expect(msg.blocks).toEqual([block]);
  });

  test("empty rehydrate clears the message list", () => {
    const state = stateWith({
      messages: [{ kind: "user", id: "old", blocks: [{ kind: "text", text: "old" }] }],
    });
    const next = reduce(state, { kind: "rehydrate_messages", messages: [] });
    expect(next.messages).toEqual([]);
  });

  test("skips tool_result (senderId: tool) messages", () => {
    const next = reduce(createInitialState(), {
      kind: "rehydrate_messages",
      messages: [
        {
          senderId: "user",
          timestamp: 1,
          content: [{ kind: "text", text: "hi" }],
        },
        {
          senderId: "tool",
          timestamp: 2,
          content: [{ kind: "text", text: '{"toolId":"memory_store","output":{"stored":true}}' }],
          metadata: { callId: "c1", toolCallId: "c1", toolName: "memory_store" },
        },
        {
          senderId: "assistant",
          timestamp: 3,
          content: [{ kind: "text", text: "done" }],
        },
      ],
    });
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]?.kind).toBe("user");
    expect(next.messages[1]?.kind).toBe("assistant");
  });

  test("skips assistant messages that carry a metadata.toolCalls placeholder", () => {
    const next = reduce(createInitialState(), {
      kind: "rehydrate_messages",
      messages: [
        {
          senderId: "assistant",
          timestamp: 1,
          // resumeFromTranscript stores the first call's UUID here and
          // hides the real payload in metadata.toolCalls — the UI
          // should not render the UUID verbatim.
          content: [{ kind: "text", text: "toolu_vrtx_01V7jrJFaYL5rMqaR5tZtdhQ" }],
          metadata: {
            toolCalls: [
              {
                id: "toolu_vrtx_01V7jrJFaYL5rMqaR5tZtdhQ",
                type: "function",
                function: { name: "memory_store", arguments: "{}" },
              },
            ],
          },
        },
        {
          senderId: "assistant",
          timestamp: 2,
          content: [{ kind: "text", text: "Nice to meet you, Jane!" }],
        },
      ],
    });
    expect(next.messages).toHaveLength(1);
    const msg = next.messages[0];
    if (msg?.kind !== "assistant") throw new Error("expected assistant");
    expect((msg.blocks[0] as { kind: string; text: string }).text).toBe("Nice to meet you, Jane!");
  });
});

// ---------------------------------------------------------------------------
// set_session_list
// ---------------------------------------------------------------------------

function makeSession(
  id: string,
  lastActivityAt: number,
): {
  readonly id: string;
  readonly name: string;
  readonly lastActivityAt: number;
  readonly messageCount: number;
  readonly preview: string;
} {
  return { id, name: `Session ${id}`, lastActivityAt, messageCount: 5, preview: "preview" };
}

describe("reduce — set_session_list", () => {
  test("stores sessions sorted by lastActivityAt descending", () => {
    const state = createInitialState();
    const sessions = [makeSession("a", 1000), makeSession("b", 3000), makeSession("c", 2000)];
    const next = reduce(state, { kind: "set_session_list", sessions });
    expect(next.sessions[0]?.id).toBe("b");
    expect(next.sessions[1]?.id).toBe("c");
    expect(next.sessions[2]?.id).toBe("a");
  });

  test("empty array stores empty sessions", () => {
    const state = stateWith({ sessions: [makeSession("x", 1000)] });
    const next = reduce(state, { kind: "set_session_list", sessions: [] });
    expect(next.sessions).toHaveLength(0);
  });

  test("exactly 50 (MAX_SESSIONS) items — all stored, no truncation", () => {
    const state = createInitialState();
    const sessions = Array.from({ length: 50 }, (_, i) => makeSession(`s${i}`, i));
    const next = reduce(state, { kind: "set_session_list", sessions });
    expect(next.sessions).toHaveLength(50);
  });

  test("51 (MAX_SESSIONS + 1) items — oldest item dropped", () => {
    const state = createInitialState();
    const sessions = Array.from({ length: 51 }, (_, i) => makeSession(`s${i}`, i));
    const next = reduce(state, { kind: "set_session_list", sessions });
    expect(next.sessions).toHaveLength(50);
    expect(next.sessions.some((s) => s.id === "s0")).toBe(false);
    expect(next.sessions[0]?.id).toBe("s50");
  });

  test("does not mutate incoming sessions array", () => {
    const state = createInitialState();
    const sessions = [makeSession("a", 100), makeSession("b", 200)];
    const copy = sessions.map((s) => ({ ...s }));
    reduce(state, { kind: "set_session_list", sessions });
    expect(sessions).toEqual(copy);
  });

  test("does not affect other state fields", () => {
    const state = stateWith({ activeView: "help", connectionStatus: "connected" });
    const next = reduce(state, { kind: "set_session_list", sessions: [makeSession("x", 1000)] });
    expect(next.activeView).toBe("help");
    expect(next.connectionStatus).toBe("connected");
  });
});

// ---------------------------------------------------------------------------
// Cumulative metrics on 'done'
// ---------------------------------------------------------------------------

function doneWith(metrics: {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}): TuiAction {
  return engineEvent({
    kind: "done",
    output: {
      content: [],
      stopReason: "completed",
      metrics: {
        totalTokens: metrics.totalTokens,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        turns: 1,
        durationMs: 100,
        ...(metrics.costUsd !== undefined ? { costUsd: metrics.costUsd } : {}),
      },
    },
  });
}

describe("reduce — cumulative metrics on 'done'", () => {
  test("first done: accumulates from zero baseline", () => {
    const state = createInitialState();
    const next = reduce(state, doneWith({ totalTokens: 100, inputTokens: 80, outputTokens: 20 }));
    expect(next.cumulativeMetrics.totalTokens).toBe(100);
    expect(next.cumulativeMetrics.inputTokens).toBe(80);
    expect(next.cumulativeMetrics.outputTokens).toBe(20);
    expect(next.cumulativeMetrics.turns).toBe(1);
  });

  test("second done: adds to existing cumulative totals", () => {
    let state = createInitialState();
    state = reduce(state, doneWith({ totalTokens: 100, inputTokens: 80, outputTokens: 20 }));
    const next = reduce(state, doneWith({ totalTokens: 50, inputTokens: 30, outputTokens: 20 }));
    expect(next.cumulativeMetrics.totalTokens).toBe(150);
    expect(next.cumulativeMetrics.inputTokens).toBe(110);
    expect(next.cumulativeMetrics.outputTokens).toBe(40);
    expect(next.cumulativeMetrics.turns).toBe(2);
  });

  test("done without costUsd: costUsd stays null", () => {
    const state = createInitialState();
    const next = reduce(state, doneWith({ totalTokens: 100, inputTokens: 80, outputTokens: 20 }));
    expect(next.cumulativeMetrics.costUsd).toBeNull();
  });

  test("done with costUsd when prev was null: costUsd becomes that value", () => {
    const state = createInitialState();
    const next = reduce(
      state,
      doneWith({ totalTokens: 100, inputTokens: 80, outputTokens: 20, costUsd: 0.05 }),
    );
    expect(next.cumulativeMetrics.costUsd).toBeCloseTo(0.05);
  });

  test("done with costUsd when prev already has a value: costUsd adds up", () => {
    let state = createInitialState();
    state = reduce(
      state,
      doneWith({ totalTokens: 100, inputTokens: 80, outputTokens: 20, costUsd: 0.05 }),
    );
    const next = reduce(
      state,
      doneWith({ totalTokens: 50, inputTokens: 30, outputTokens: 20, costUsd: 0.03 }),
    );
    expect(next.cumulativeMetrics.costUsd).toBeCloseTo(0.08);
  });

  test("done with costUsd after a no-costUsd turn: treats prior null as 0", () => {
    let state = createInitialState();
    state = reduce(state, doneWith({ totalTokens: 100, inputTokens: 80, outputTokens: 20 }));
    expect(state.cumulativeMetrics.costUsd).toBeNull();
    const next = reduce(
      state,
      doneWith({ totalTokens: 50, inputTokens: 30, outputTokens: 20, costUsd: 0.02 }),
    );
    expect(next.cumulativeMetrics.costUsd).toBeCloseTo(0.02);
  });

  test("turns accumulate from m.turns (single-turn runs: m.turns=1 each)", () => {
    let state = createInitialState();
    for (let i = 0; i < 5; i++) {
      state = reduce(state, doneWith({ totalTokens: 10, inputTokens: 8, outputTokens: 2 }));
    }
    expect(state.cumulativeMetrics.turns).toBe(5);
  });

  test("done with legacy state missing engineTurns: floors at prev.turns, no NaN (backward compat)", () => {
    // Simulate a state restored from before engineTurns was added to the schema.
    // The ?? prev.turns floor preserves history: each prior user turn had ≥1 model call.
    const legacyMetrics = {
      totalTokens: 100,
      inputTokens: 80,
      outputTokens: 20,
      turns: 3,
      // engineTurns deliberately absent — pre-migration state
      costUsd: null,
    };
    const state = stateWith({
      // Cast: simulate a legacy state object that predates engineTurns
      cumulativeMetrics: legacyMetrics as unknown as import("./types.js").CumulativeMetrics,
    });
    const next = reduce(state, doneWith({ totalTokens: 50, inputTokens: 40, outputTokens: 10 }));
    expect(Number.isNaN(next.cumulativeMetrics.engineTurns)).toBe(false);
    // Floor is prev.turns (3), not 0. After one more single-turn run: 3 + 1 = 4.
    expect(next.cumulativeMetrics.engineTurns).toBe(4);
    expect(next.cumulativeMetrics.turns).toBe(4);
    // engineTurns === turns → no false amplification shown in status bar
    expect(next.cumulativeMetrics.engineTurns).toBe(next.cumulativeMetrics.turns);
  });

  test("done with legacy state: subsequent tool-loop run still shows amplification signal", () => {
    // After restoring a legacy session (engineTurns defaults to turns=3),
    // a multi-turn tool-loop run should surface in the status bar.
    const legacyMetrics = {
      totalTokens: 100,
      inputTokens: 80,
      outputTokens: 20,
      turns: 3,
      costUsd: null,
    };
    const state = stateWith({
      cumulativeMetrics: legacyMetrics as unknown as import("./types.js").CumulativeMetrics,
    });
    // Tool-loop run: m.turns = 4 (4 model calls for 1 user request)
    const next = reduce(
      state,
      engineEvent({
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: {
            totalTokens: 400,
            inputTokens: 320,
            outputTokens: 80,
            turns: 4,
            durationMs: 800,
          },
        },
      }),
    );
    expect(next.cumulativeMetrics.turns).toBe(4); // 3 prior + 1 new user turn
    expect(next.cumulativeMetrics.engineTurns).toBe(7); // 3 (floor) + 4 (tool loop)
    // engineTurns > turns → status bar shows amplification signal
    expect(next.cumulativeMetrics.engineTurns).toBeGreaterThan(next.cumulativeMetrics.turns);
  });

  test("done with m.turns === 0: user turns unchanged (interrupted/no-op run)", () => {
    // Engine emits done with turns=0 when interrupted before first model call
    const state = createInitialState();
    const next = reduce(
      state,
      engineEvent({
        kind: "done",
        output: {
          content: [],
          stopReason: "interrupted",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 5 },
        },
      }),
    );
    // No model calls → should not count as a completed user turn
    expect(next.cumulativeMetrics.turns).toBe(0);
    expect(next.cumulativeMetrics.engineTurns).toBe(0);
  });

  test("done with m.turns > 1: user turns = 1, engineTurns = m.turns (multi-turn tool-loop run)", () => {
    // A single user request that caused 3 internal engine turns (tool-call loop)
    const state = createInitialState();
    const next = reduce(
      state,
      engineEvent({
        kind: "done",
        output: {
          content: [],
          stopReason: "completed",
          metrics: {
            totalTokens: 300,
            inputTokens: 240,
            outputTokens: 60,
            turns: 3,
            durationMs: 500,
          },
        },
      }),
    );
    // User round trips: always 1 per done event
    expect(next.cumulativeMetrics.turns).toBe(1);
    // Engine-internal turns: accumulates m.turns (3 model calls for this run)
    expect(next.cumulativeMetrics.engineTurns).toBe(3);
    expect(next.cumulativeMetrics.totalTokens).toBe(300);
  });

  test("done sets agentStatus to idle", () => {
    const state = stateWith({ agentStatus: "processing" });
    const next = reduce(state, doneWith({ totalTokens: 10, inputTokens: 8, outputTokens: 2 }));
    expect(next.agentStatus).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// agentStatus transitions
// ---------------------------------------------------------------------------

describe("reduce — agentStatus", () => {
  test("starts idle", () => {
    expect(createInitialState().agentStatus).toBe("idle");
  });

  test("turn_start sets processing", () => {
    const state = createInitialState();
    const next = reduce(state, engineEvent({ kind: "turn_start", turnIndex: 0 }));
    expect(next.agentStatus).toBe("processing");
  });

  test("turn_end sets idle", () => {
    const state = stateWith({ agentStatus: "processing" });
    const next = reduce(state, engineEvent({ kind: "turn_end", turnIndex: 0 }));
    expect(next.agentStatus).toBe("idle");
  });

  test("add_error sets error when a streaming turn is active", () => {
    const state = stateWith({
      agentStatus: "processing",
      messages: [assistantMsg("text", { streaming: true })],
    });
    const next = reduce(state, { kind: "add_error", code: "E", message: "fail" });
    expect(next.agentStatus).toBe("error");
  });

  test("add_error does not change agentStatus when no active streaming turn", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "add_error", code: "E", message: "fail" });
    expect(next.agentStatus).toBe("idle");
  });

  test("clear_messages resets agentStatus to idle", () => {
    const state = stateWith({ agentStatus: "error", messages: [userMsg("hi")] });
    const next = reduce(state, { kind: "clear_messages" });
    expect(next.agentStatus).toBe("idle");
  });

  test("clear_messages resets planTasks to null (session reset is clean)", () => {
    const state = stateWith({
      planTasks: [{ id: "t1", subject: "Thing", status: "in_progress" }],
      messages: [userMsg("hi")],
    });
    const next = reduce(state, { kind: "clear_messages" });
    expect(next.planTasks).toBeNull();
  });

  test("session-picker modal does not affect agentStatus", () => {
    const state = stateWith({ agentStatus: "processing" });
    const next = reduce(state, { kind: "set_modal", modal: { kind: "session-picker" } });
    expect(next.agentStatus).toBe("processing");
  });
});

// ---------------------------------------------------------------------------
// plan_update / task_progress
// ---------------------------------------------------------------------------

describe("reduce — plan_update", () => {
  test("sets planTasks from event", () => {
    const state = createInitialState();
    const next = reduce(
      state,
      engineEvent({
        kind: "plan_update",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        tasks: [
          {
            id: "t1" as import("@koi/core").TaskItemId,
            subject: "Do thing",
            status: "pending",
            dependencies: [],
          },
          {
            id: "t2" as import("@koi/core").TaskItemId,
            subject: "Other",
            status: "in_progress",
            activeForm: "Working",
            dependencies: [],
          },
        ],
        timestamp: 1000,
      }),
    );
    expect(next.planTasks).toHaveLength(2);
    expect(next.planTasks?.[0]?.status).toBe("pending");
    expect(next.planTasks?.[1]?.activeForm).toBe("Working");
  });

  test("replaces planTasks on subsequent plan_update", () => {
    const state = stateWith({ planTasks: [{ id: "t1", subject: "Old", status: "pending" }] });
    const next = reduce(
      state,
      engineEvent({
        kind: "plan_update",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        tasks: [
          {
            id: "t2" as import("@koi/core").TaskItemId,
            subject: "New",
            status: "completed",
            dependencies: [],
          },
        ],
        timestamp: 2000,
      }),
    );
    expect(next.planTasks).toHaveLength(1);
    expect(next.planTasks?.[0]?.id).toBe("t2");
  });

  test("includes blockedBy from event", () => {
    const state = createInitialState();
    const next = reduce(
      state,
      engineEvent({
        kind: "plan_update",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        tasks: [
          {
            id: "t1" as import("@koi/core").TaskItemId,
            subject: "Failed",
            status: "failed",
            dependencies: [],
          },
          {
            id: "t2" as import("@koi/core").TaskItemId,
            subject: "Blocked",
            status: "pending",
            blockedBy: "t1" as import("@koi/core").TaskItemId,
            dependencies: [],
          },
        ],
        timestamp: 1000,
      }),
    );
    expect(next.planTasks?.[1]?.blockedBy).toBe("t1");
  });
});

describe("reduce — task_progress", () => {
  test("updates matching task status", () => {
    const state = stateWith({
      planTasks: [
        { id: "t1", subject: "Thing", status: "pending" },
        { id: "t2", subject: "Other", status: "pending" },
      ],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "task_progress",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        taskId: "t1" as import("@koi/core").TaskItemId,
        subject: "Thing",
        previousStatus: "pending",
        status: "in_progress",
        activeForm: "Working",
        timestamp: 1000,
      }),
    );
    expect(next.planTasks?.[0]?.status).toBe("in_progress");
    expect(next.planTasks?.[0]?.activeForm).toBe("Working");
    expect(next.planTasks?.[1]?.status).toBe("pending");
  });

  test("upserts new task when planTasks is null", () => {
    const state = createInitialState();
    const next = reduce(
      state,
      engineEvent({
        kind: "task_progress",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        taskId: "t1" as import("@koi/core").TaskItemId,
        subject: "New task",
        previousStatus: "pending",
        status: "pending",
        timestamp: 1000,
      }),
    );
    expect(next.planTasks).toHaveLength(1);
    expect(next.planTasks?.[0]?.subject).toBe("New task");
  });

  test("upserts new task when task ID not found", () => {
    const state = stateWith({ planTasks: [{ id: "t1", subject: "Existing", status: "pending" }] });
    const next = reduce(
      state,
      engineEvent({
        kind: "task_progress",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        taskId: "t2" as import("@koi/core").TaskItemId,
        subject: "New",
        previousStatus: "pending",
        status: "pending",
        timestamp: 1000,
      }),
    );
    expect(next.planTasks).toHaveLength(2);
  });

  test("clears blockedBy when task moves out of pending", () => {
    const state = stateWith({
      planTasks: [{ id: "t1", subject: "Blocked", status: "pending", blockedBy: "t0" }],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "task_progress",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        taskId: "t1" as import("@koi/core").TaskItemId,
        subject: "Blocked",
        previousStatus: "pending",
        status: "in_progress",
        timestamp: 1000,
      }),
    );
    expect(next.planTasks?.[0]?.blockedBy).toBeUndefined();
  });

  test("preserves blockedBy when task stays pending", () => {
    const state = stateWith({
      planTasks: [{ id: "t1", subject: "Blocked", status: "pending", blockedBy: "t0" }],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "task_progress",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        taskId: "t1" as import("@koi/core").TaskItemId,
        subject: "Blocked",
        previousStatus: "pending",
        status: "pending",
        timestamp: 1000,
      }),
    );
    expect(next.planTasks?.[0]?.blockedBy).toBe("t0");
  });

  test("updates subject from event", () => {
    const state = stateWith({ planTasks: [{ id: "t1", subject: "Old", status: "in_progress" }] });
    const next = reduce(
      state,
      engineEvent({
        kind: "task_progress",
        agentId: "agent-1" as import("@koi/core/ecs").AgentId,
        taskId: "t1" as import("@koi/core").TaskItemId,
        subject: "New Subject",
        previousStatus: "in_progress",
        status: "in_progress",
        activeForm: "Updated",
        timestamp: 1000,
      }),
    );
    expect(next.planTasks?.[0]?.subject).toBe("New Subject");
    expect(next.planTasks?.[0]?.activeForm).toBe("Updated");
  });
});

// ---------------------------------------------------------------------------
// tool_result event
// ---------------------------------------------------------------------------

describe("reduce — engine_event — tool_result", () => {
  test("stores ToolResultData on the matching block", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "ls", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "tool_result",
        callId: testCallId("call-1"),
        output: { files: ["a.ts"] },
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.result).toBeDefined();
        expect(block.result?.value).toEqual({ files: ["a.ts"] });
        expect(block.result?.truncated).toBe(false);
        expect(block.result?.byteSize).toBeGreaterThan(0);
      }
    }
  });

  test("tool_result stores string output as-is", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "echo", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
    });
    const next = reduce(
      state,
      engineEvent({ kind: "tool_result", callId: testCallId("call-1"), output: "hello world" }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const block = blockAt(msg, 0);
      if (block.kind === "tool_call") {
        expect(block.result?.value).toBe("hello world");
        expect(block.result?.truncated).toBe(false);
      }
    }
  });

  test("tool_result for unknown callId returns same state reference", () => {
    const state = stateWith({
      messages: [assistantMsg("text", { id: "assistant-0" })],
    });
    const next = reduce(
      state,
      engineEvent({ kind: "tool_result", callId: testCallId("no-such-call"), output: "data" }),
    );
    // No matching block — same messages array (reducer returns same state on warn path)
    expect(next.messages).toEqual(state.messages);
  });
});

// ---------------------------------------------------------------------------
// Spawn events (spawn_requested, agent_status_changed, agent_spawned)
// ---------------------------------------------------------------------------

describe("reduce — engine_event — spawn", () => {
  test("spawn_requested creates spawn_call block and activeSpawns entry", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: true, blocks: [] })],
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "spawn_requested",
        childAgentId: "child-1" as import("@koi/core/ecs").AgentId,
        request: {
          agentName: "researcher",
          description: "Find information",
          signal: new AbortController().signal,
        },
      }),
    );
    const msg = lastMessage(next);
    expect(msg.kind).toBe("assistant");
    if (msg.kind === "assistant") {
      const spawnBlock = msg.blocks.find((b) => b.kind === "spawn_call");
      expect(spawnBlock).toBeDefined();
      if (spawnBlock?.kind === "spawn_call") {
        expect(spawnBlock.agentId).toBe("child-1");
        expect(spawnBlock.agentName).toBe("researcher");
        expect(spawnBlock.status).toBe("running");
      }
    }
    expect(next.activeSpawns.has("child-1")).toBe(true);
    expect(next.activeSpawns.get("child-1")?.agentName).toBe("researcher");
  });

  test("agent_status_changed (completed) updates spawn block and removes from activeSpawns", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "spawn_call",
        agentId: "child-1",
        agentName: "researcher",
        description: "Find information",
        status: "running",
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
      activeSpawns: new Map([
        [
          "child-1",
          {
            agentName: "researcher",
            description: "Find information",
            startedAt: Date.now() - 1000,
          },
        ],
      ]),
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "agent_status_changed",
        agentId: "child-1" as import("@koi/core/ecs").AgentId,
        agentName: "researcher",
        status: "terminated",
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const spawnBlock = msg.blocks.find((b) => b.kind === "spawn_call");
      if (spawnBlock?.kind === "spawn_call") {
        // "terminated" ProcessState → display "complete"
        expect(spawnBlock.status).toBe("complete");
        expect(spawnBlock.stats).toBeDefined();
      }
    }
    expect(next.activeSpawns.has("child-1")).toBe(false);
  });

  test("agent_status_changed (terminated) sets status to complete and removes from activeSpawns", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "spawn_call",
        agentId: "child-2",
        agentName: "worker",
        description: "Do work",
        status: "running",
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
      activeSpawns: new Map([
        ["child-2", { agentName: "worker", description: "Do work", startedAt: Date.now() - 500 }],
      ]),
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "agent_status_changed",
        agentId: "child-2" as import("@koi/core/ecs").AgentId,
        agentName: "worker",
        status: "terminated",
      }),
    );
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const spawnBlock = msg.blocks.find((b) => b.kind === "spawn_call");
      if (spawnBlock?.kind === "spawn_call") {
        // "terminated" ProcessState → display "complete" (single terminal state)
        expect(spawnBlock.status).toBe("complete");
      }
    }
    expect(next.activeSpawns.has("child-2")).toBe(false);
  });

  test("set_spawn_terminal with outcome='failed' renders spawn block as failed", () => {
    // Regression for round 6 adversarial review: previously the bridge collapsed
    // complete/failed into "terminated" → always rendered as "complete".
    // The new set_spawn_terminal action preserves the outcome.
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "spawn_call",
        agentId: "child-fail",
        agentName: "failer",
        description: "will fail",
        status: "running",
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
      activeSpawns: new Map([
        [
          "child-fail",
          { agentName: "failer", description: "will fail", startedAt: Date.now() - 200 },
        ],
      ]),
    });
    const next = reduce(state, {
      kind: "set_spawn_terminal",
      agentId: "child-fail",
      outcome: "failed",
    });
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const spawnBlock = msg.blocks.find((b) => b.kind === "spawn_call");
      expect(spawnBlock?.kind).toBe("spawn_call");
      if (spawnBlock?.kind === "spawn_call") {
        expect(spawnBlock.status).toBe("failed");
        expect(spawnBlock.stats).toBeDefined();
      }
    }
    expect(next.activeSpawns.has("child-fail")).toBe(false);
  });

  test("set_spawn_terminal with outcome='complete' renders spawn block as complete", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "spawn_call",
        agentId: "child-ok",
        agentName: "worker",
        description: "will succeed",
        status: "running",
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
      activeSpawns: new Map([
        [
          "child-ok",
          { agentName: "worker", description: "will succeed", startedAt: Date.now() - 500 },
        ],
      ]),
    });
    const next = reduce(state, {
      kind: "set_spawn_terminal",
      agentId: "child-ok",
      outcome: "complete",
    });
    const msg = lastMessage(next);
    if (msg.kind === "assistant") {
      const spawnBlock = msg.blocks.find((b) => b.kind === "spawn_call");
      if (spawnBlock?.kind === "spawn_call") {
        expect(spawnBlock.status).toBe("complete");
      }
    }
    expect(next.activeSpawns.has("child-ok")).toBe(false);
  });

  test("set_spawn_terminal is a no-op when agentId is not in activeSpawns", () => {
    const state = createInitialState();
    const next = reduce(state, {
      kind: "set_spawn_terminal",
      agentId: "unknown",
      outcome: "failed",
    });
    expect(next).toBe(state);
  });

  test("agent_status_changed (running) is a no-op for non-terminal status", () => {
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0" })],
      activeSpawns: new Map([
        ["child-3", { agentName: "w", description: "w", startedAt: Date.now() }],
      ]),
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "agent_status_changed",
        agentId: "child-3" as import("@koi/core/ecs").AgentId,
        agentName: "w",
        status: "running",
      }),
    );
    expect(next).toBe(state);
  });

  test("agent_spawned is a no-op", () => {
    const state = createInitialState();
    const next = reduce(
      state,
      engineEvent({
        kind: "agent_spawned",
        agentId: "child-4" as import("@koi/core/ecs").AgentId,
        agentName: "worker-4",
      }),
    );
    expect(next).toBe(state);
  });

  // Regression for #1792: /agents view showed "No active agents" immediately
  // after successful spawns — no history retained.
  test("set_spawn_terminal appends SpawnRecord to finishedSpawns with outcome", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "spawn_call",
        agentId: "child-hist-1",
        agentName: "historian",
        description: "research the past",
        status: "running",
      },
    ];
    const startedAt = Date.now() - 1250;
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
      activeSpawns: new Map([
        ["child-hist-1", { agentName: "historian", description: "research the past", startedAt }],
      ]),
    });
    const next = reduce(state, {
      kind: "set_spawn_terminal",
      agentId: "child-hist-1",
      outcome: "failed",
    });
    expect(next.finishedSpawns.length).toBe(1);
    const rec = next.finishedSpawns[0];
    expect(rec).toBeDefined();
    if (rec) {
      expect(rec.agentId).toBe("child-hist-1");
      expect(rec.agentName).toBe("historian");
      expect(rec.description).toBe("research the past");
      expect(rec.outcome).toBe("failed");
      expect(rec.startedAt).toBe(startedAt);
      expect(rec.durationMs).toBeGreaterThanOrEqual(1250);
      expect(rec.finishedAt).toBeGreaterThanOrEqual(rec.startedAt);
    }
  });

  test("agent_status_changed (terminated) appends SpawnRecord with outcome=complete", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "spawn_call",
        agentId: "child-hist-2",
        agentName: "worker",
        description: "Do work",
        status: "running",
      },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
      activeSpawns: new Map([
        [
          "child-hist-2",
          { agentName: "worker", description: "Do work", startedAt: Date.now() - 10 },
        ],
      ]),
    });
    const next = reduce(
      state,
      engineEvent({
        kind: "agent_status_changed",
        agentId: "child-hist-2" as import("@koi/core/ecs").AgentId,
        agentName: "worker",
        status: "terminated",
      }),
    );
    expect(next.finishedSpawns.length).toBe(1);
    expect(next.finishedSpawns[0]?.agentId).toBe("child-hist-2");
    expect(next.finishedSpawns[0]?.outcome).toBe("complete");
  });

  test("finishedSpawns is ordered most-recent-first and capped at MAX_FINISHED_SPAWNS", () => {
    let state: TuiState = createInitialState();
    // Push 25 terminal spawns; the buffer should retain the last 20 in
    // most-recent-first order.
    for (let i = 0; i < 25; i++) {
      const id = `child-${i}`;
      const withBlock: readonly TuiAssistantBlock[] = [
        {
          kind: "spawn_call",
          agentId: id,
          agentName: `a${i}`,
          description: `d${i}`,
          status: "running",
        },
      ];
      state = stateWith({
        ...state,
        messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks: withBlock })],
        activeSpawns: new Map([
          [id, { agentName: `a${i}`, description: `d${i}`, startedAt: Date.now() - 1 }],
        ]),
      });
      state = reduce(state, { kind: "set_spawn_terminal", agentId: id, outcome: "complete" });
    }
    expect(state.finishedSpawns.length).toBe(MAX_FINISHED_SPAWNS);
    // Newest at index 0, oldest retained at the tail.
    expect(state.finishedSpawns[0]?.agentId).toBe("child-24");
    expect(state.finishedSpawns[MAX_FINISHED_SPAWNS - 1]?.agentId).toBe("child-5");
  });

  // Regression: agent_status_changed(terminated) arrives before set_spawn_terminal(failed).
  // The authoritative failure outcome must not be lost.
  test("set_spawn_terminal overwrites agent_status_changed record when it arrives second", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      {
        kind: "spawn_call",
        agentId: "child-race-1",
        agentName: "racer",
        description: "race condition test",
        status: "running",
      },
    ];
    const startedAt = Date.now() - 500;
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", streaming: false, blocks })],
      activeSpawns: new Map([
        ["child-race-1", { agentName: "racer", description: "race condition test", startedAt }],
      ]),
    });

    // Step 1: generic termination arrives first — records as "complete"
    const afterGeneric = reduce(
      state,
      engineEvent({
        kind: "agent_status_changed",
        agentId: "child-race-1" as import("@koi/core/ecs").AgentId,
        agentName: "racer",
        status: "terminated",
      }),
    );
    expect(afterGeneric.finishedSpawns.length).toBe(1);
    expect(afterGeneric.finishedSpawns[0]?.outcome).toBe("complete");
    expect(afterGeneric.activeSpawns.has("child-race-1")).toBe(false);

    // Step 2: authoritative terminal arrives — must overwrite to "failed"
    const afterTerminal = reduce(afterGeneric, {
      kind: "set_spawn_terminal",
      agentId: "child-race-1",
      outcome: "failed",
    });
    expect(afterTerminal.finishedSpawns.length).toBe(1);
    expect(afterTerminal.finishedSpawns[0]?.outcome).toBe("failed");
    expect(afterTerminal.finishedSpawns[0]?.agentId).toBe("child-race-1");

    // Block status should also be updated to "failed"
    const lastMsg = afterTerminal.messages[afterTerminal.messages.length - 1];
    expect(lastMsg?.kind).toBe("assistant");
    if (lastMsg?.kind === "assistant") {
      const spawnBlock = lastMsg.blocks.find(
        (b) => b.kind === "spawn_call" && b.agentId === "child-race-1",
      );
      expect(spawnBlock).toBeDefined();
      if (spawnBlock && spawnBlock.kind === "spawn_call") {
        expect(spawnBlock.status).toBe("failed");
      }
    }
  });

  // Regression: clear_messages must reset finishedSpawns so /agents doesn't
  // leak stale history into fresh sessions.
  test("clear_messages resets finishedSpawns to empty", () => {
    const state = stateWith({
      finishedSpawns: [
        {
          agentId: "child-old",
          agentName: "stale",
          description: "should be gone",
          startedAt: Date.now() - 5000,
          finishedAt: Date.now() - 4000,
          durationMs: 1000,
          outcome: "complete",
        },
      ],
    });
    expect(state.finishedSpawns.length).toBe(1);
    const next = reduce(state, { kind: "clear_messages" });
    expect(next.finishedSpawns).toEqual([]);
  });

  // Regression: set_spawn_terminal corrects finishedSpawns even when the
  // spawn_call block is no longer in the last assistant message.
  test("set_spawn_terminal corrects finishedSpawns even when block is missing from messages", () => {
    // Simulate: agent_status_changed already cleared activeSpawns and recorded
    // a "complete" entry, then messages were compacted/cleared so the spawn_call
    // block is gone. set_spawn_terminal(failed) must still correct the record.
    const state = stateWith({
      messages: [assistantMsg("some later text", { id: "assistant-1", streaming: false })],
      finishedSpawns: [
        {
          agentId: "child-gone-1",
          agentName: "ghost",
          description: "vanished block",
          startedAt: Date.now() - 2000,
          finishedAt: Date.now() - 1000,
          durationMs: 1000,
          outcome: "complete",
        },
      ],
    });
    const next = reduce(state, {
      kind: "set_spawn_terminal",
      agentId: "child-gone-1",
      outcome: "failed",
    });
    expect(next.finishedSpawns.length).toBe(1);
    expect(next.finishedSpawns[0]?.outcome).toBe("failed");
    expect(next.finishedSpawns[0]?.agentId).toBe("child-gone-1");
  });

  // clear_messages no-op guard must consider finishedSpawns
  test("clear_messages is not a no-op when only finishedSpawns is populated", () => {
    const state = stateWith({
      finishedSpawns: [
        {
          agentId: "child-only",
          agentName: "lonely",
          description: "only spawn data",
          startedAt: Date.now() - 1000,
          finishedAt: Date.now(),
          durationMs: 1000,
          outcome: "complete",
        },
      ],
    });
    const next = reduce(state, { kind: "clear_messages" });
    expect(next).not.toBe(state);
    expect(next.finishedSpawns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// expand_tool / collapse_tool / toggle_all_tools_expanded
// ---------------------------------------------------------------------------

describe("reduce — expand_tool / collapse_tool", () => {
  test("expand_tool adds callId to expandedToolCallIds", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "expand_tool", callId: "call-1" });
    expect(next.expandedToolCallIds.has("call-1")).toBe(true);
  });

  test("expand_tool is idempotent (already expanded returns same state)", () => {
    const state = stateWith({ expandedToolCallIds: new Set(["call-1"]) });
    const next = reduce(state, { kind: "expand_tool", callId: "call-1" });
    expect(next).toBe(state);
  });

  test("collapse_tool removes callId from expandedToolCallIds", () => {
    const state = stateWith({ expandedToolCallIds: new Set(["call-1", "call-2"]) });
    const next = reduce(state, { kind: "collapse_tool", callId: "call-1" });
    expect(next.expandedToolCallIds.has("call-1")).toBe(false);
    expect(next.expandedToolCallIds.has("call-2")).toBe(true);
  });

  test("collapse_tool is idempotent (already collapsed returns same state)", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "collapse_tool", callId: "missing" });
    expect(next).toBe(state);
  });

  test("clear_messages resets expandedToolCallIds to empty set", () => {
    const state = stateWith({
      messages: [userMsg("hi")],
      expandedToolCallIds: new Set(["call-1", "call-2"]),
    });
    const next = reduce(state, { kind: "clear_messages" });
    expect(next.expandedToolCallIds.size).toBe(0);
  });

  test("clear_messages resets activeSpawns to empty map", () => {
    const state = stateWith({
      messages: [userMsg("hi")],
      activeSpawns: new Map([["child-1", { agentName: "w", description: "w", startedAt: 0 }]]),
    });
    const next = reduce(state, { kind: "clear_messages" });
    expect(next.activeSpawns.size).toBe(0);
  });
});

describe("reduce — toggle_all_tools_expanded", () => {
  test("expands all when some are unexpanded", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "ls", status: "complete" },
      { kind: "tool_call", callId: "call-2", toolName: "cat", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", blocks })],
      expandedToolCallIds: new Set(["call-1"]), // call-2 is unexpanded
    });
    const next = reduce(state, { kind: "toggle_all_tools_expanded" });
    expect(next.expandedToolCallIds.has("call-1")).toBe(true);
    expect(next.expandedToolCallIds.has("call-2")).toBe(true);
  });

  test("collapses all when all are already expanded", () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "tool_call", callId: "call-1", toolName: "ls", status: "complete" },
      { kind: "tool_call", callId: "call-2", toolName: "cat", status: "complete" },
    ];
    const state = stateWith({
      messages: [assistantMsg("", { id: "assistant-0", blocks })],
      expandedToolCallIds: new Set(["call-1", "call-2"]),
    });
    const next = reduce(state, { kind: "toggle_all_tools_expanded" });
    expect(next.expandedToolCallIds.size).toBe(0);
  });

  test("no-op when there are no tool calls", () => {
    const state = createInitialState();
    const next = reduce(state, { kind: "toggle_all_tools_expanded" });
    // No tool calls → expands all (empty set) which equals current empty set
    expect(next.expandedToolCallIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// set_trajectory_data
// ---------------------------------------------------------------------------

describe("reduce — set_trajectory_data", () => {
  const makeStep = (
    overrides: Partial<import("./types.js").TrajectoryStepSummary> & {
      readonly stepIndex: number;
      readonly kind: string;
      readonly identifier: string;
      readonly timestamp: number;
    },
  ): import("./types.js").TrajectoryStepSummary => ({
    turnIndex: 1,
    durationMs: undefined,
    outcome: undefined,
    requestText: undefined,
    responseText: undefined,
    errorText: undefined,
    tokens: undefined,
    middlewareSpan: undefined,
    ...overrides,
  });

  test("stores trajectory steps", () => {
    const state = createInitialState();
    const steps = [
      makeStep({
        stepIndex: 0,
        kind: "model_call",
        identifier: "gpt-4",
        durationMs: 500,
        outcome: "success",
        timestamp: 1000,
      }),
      makeStep({
        stepIndex: 1,
        kind: "tool_call",
        identifier: "Glob",
        durationMs: 50,
        outcome: "success",
        timestamp: 1500,
      }),
    ];
    const next = reduce(state, { kind: "set_trajectory_data", steps });
    expect(next.trajectorySteps).toHaveLength(2);
    expect(next.trajectorySteps[0]?.identifier).toBe("gpt-4");
    expect(next.trajectorySteps[1]?.identifier).toBe("Glob");
  });

  test("replaces existing trajectory data", () => {
    const state = stateWith({
      trajectorySteps: [
        makeStep({
          stepIndex: 0,
          kind: "model_call",
          identifier: "old",
          durationMs: 100,
          outcome: "success",
          timestamp: 500,
        }),
      ],
    });
    const next = reduce(state, { kind: "set_trajectory_data", steps: [] });
    expect(next.trajectorySteps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// set_plugin_summary
// ---------------------------------------------------------------------------

describe("reduce — set_plugin_summary", () => {
  test("sets pluginSummary when dispatched", () => {
    const summary: PluginSummary = {
      loaded: [
        { name: "hello-plugin", version: "0.0.1", description: "A test plugin", source: "user" },
      ],
      errors: [],
    };
    const next = reduce(createInitialState(), { kind: "set_plugin_summary", summary });
    expect(next.pluginSummary).toEqual(summary);
  });

  test("returns same state when summary is identical reference", () => {
    const summary: PluginSummary = { loaded: [], errors: [] };
    const state = { ...createInitialState(), pluginSummary: summary };
    const next = reduce(state, { kind: "set_plugin_summary", summary });
    expect(next).toBe(state);
  });
});
