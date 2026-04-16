/**
 * MessageRow component tests — behavioral assertions via testRender + captureCharFrame.
 *
 * Tests cover:
 * - User message rendering (text + non-text blocks)
 * - Assistant message with text block
 * - Assistant message with thinking block
 * - Assistant message with tool call in each status
 * - Assistant message with error block
 * - System message rendering
 * - Multi-block assistant message
 */

import { testRender } from "@opentui/solid";
import { describe, expect, test } from "bun:test";
import { createInitialState } from "../state/initial.js";
import { toolResult } from "../state/test-helpers.js";
import { createStore } from "../state/store.js";
import type { TuiAssistantBlock, TuiMessage } from "../state/types.js";
import { StoreContext } from "../store-context.js";
import { MessageRow } from "./message-row.js";

const RENDER_OPTS = { width: 80, height: 24 };

/** Create a callId and pre-populate expandedToolCallIds so tool result body is visible. */
const EXPANDED_CALL_ID = "call-1";

async function renderMessage(
  message: TuiMessage,
  opts = RENDER_OPTS,
): Promise<string> {
  // Provide StoreContext with expandedToolCallIds so ToolCallBlock renders result body.
  const store = createStore({
    ...createInitialState(),
    expandedToolCallIds: new Set([EXPANDED_CALL_ID]),
  });
  const { captureCharFrame, renderOnce, renderer } = await testRender(
    () => (
      <StoreContext.Provider value={store}>
        <MessageRow message={message} spinnerFrame={() => 0} />
      </StoreContext.Provider>
    ),
    opts,
  );
  await renderOnce();
  const frame = captureCharFrame();
  renderer.destroy();
  return frame;
}

// ---------------------------------------------------------------------------
// User messages
// ---------------------------------------------------------------------------

describe("MessageRow — user", () => {
  test("renders user message text", async () => {
    const msg: TuiMessage = {
      kind: "user",
      id: "user-1",
      blocks: [{ kind: "text", text: "hello world" }],
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("You:");
    expect(frame).toContain("hello world");
  });

  test("renders non-text content blocks with fallbacks", async () => {
    const msg: TuiMessage = {
      kind: "user",
      id: "user-1",
      blocks: [
        { kind: "text", text: "Check this:" },
        { kind: "file", url: "/tmp/data.csv", mimeType: "text/csv", name: "data.csv" },
        { kind: "image", url: "/tmp/photo.png", alt: "a photo" },
        { kind: "button", label: "Click me", action: "submit" },
        { kind: "custom", type: "widget", data: {} },
      ],
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Check this:");
    expect(frame).toContain("data.csv");
    expect(frame).toContain("a photo");
    expect(frame).toContain("Click me");
    expect(frame).toContain("widget");
  });
});

// ---------------------------------------------------------------------------
// Assistant messages
// ---------------------------------------------------------------------------

describe("MessageRow — assistant text", () => {
  test("renders assistant text block", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [{ kind: "text", text: "I can help with that." }],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("I can help with that.");
  });
});

describe("MessageRow — assistant thinking", () => {
  test("renders thinking block with dimmed style", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [{ kind: "thinking", text: "Let me analyze this." }],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Let me analyze this.");
  });
});

describe("MessageRow — assistant tool_call", () => {
  test("shows raw tool name while running (structured display only on completion)", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "fs_read",
          status: "running",
        },
      ],
      streaming: true,
    };
    const frame = await renderMessage(msg);
    // Decision 7A: raw tool name during streaming, structured on completion
    expect(frame).toContain("fs_read");
  });

  test("shows mapped title and result on completion", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "Bash",
          status: "complete",
          args: '{"command":"ls"}',
          result: toolResult("file1.ts\nfile2.ts"),
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    // Structured display: "Shell" title with "ls" subtitle
    expect(frame).toContain("Shell");
    expect(frame).toContain("ls");
    expect(frame).toContain("file1.ts");
  });

  test("renders [unserializable] sentinel from reducer", async () => {
    // capToolResult stores "[unserializable]" for non-serializable values.
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "bad_tool",
          status: "complete",
          result: toolResult("[unserializable]"),
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("bad_tool");
    expect(frame).toContain("[unserializable]");
  });

  test("renders large tool result (truncated ToolResultData) without crashing", async () => {
    // Results exceeding MAX_TOOL_RESULT_BYTES are stored with truncated: true.
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "big_tool",
          status: "complete",
          result: { value: "x".repeat(10_000), byteSize: 2_000_000, truncated: true },
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg, { width: 80, height: 800 });
    expect(frame).toContain("big_tool");
  });

  test("shows mapped title with error indicator", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "fs_write",
          status: "error",
          args: '{"file_path":"output.txt"}',
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    // Error status still shows structured display (args are available)
    expect(frame).toContain("Write");
    expect(frame).toContain("output.txt");
  });
});

describe("MessageRow — assistant error block", () => {
  test("renders error with code and message", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [{ kind: "error", code: "RATE_LIMIT", message: "Too many requests" }],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("RATE_LIMIT");
    expect(frame).toContain("Too many requests");
  });
});

// ---------------------------------------------------------------------------
// System messages
// ---------------------------------------------------------------------------

describe("MessageRow — system", () => {
  test("renders system message text", async () => {
    const msg: TuiMessage = {
      kind: "system",
      id: "system-1",
      text: "Welcome to Koi",
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Welcome to Koi");
  });
});

// ---------------------------------------------------------------------------
// Multi-block assistant message
// ---------------------------------------------------------------------------

describe("MessageRow — multi-block", () => {
  test("renders multiple block types in order", async () => {
    const blocks: readonly TuiAssistantBlock[] = [
      { kind: "thinking", text: "Analyzing..." },
      { kind: "text", text: "Here is my response." },
      {
        kind: "tool_call",
        callId: EXPANDED_CALL_ID,
        toolName: "Grep",
        status: "complete",
        args: '{"pattern":"foo"}',
        result: toolResult("found in bar.ts"),
      },
    ];
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks,
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Analyzing...");
    expect(frame).toContain("Here is my response.");
    expect(frame).toContain("Search");
  });
});

describe("MessageRow — StatusIndicator characters", () => {
  test("running tool shows a Braille spinner character", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-running",
      blocks: [{ kind: "tool_call", callId: "call-1", toolName: "ls", status: "running" }],
      streaming: true,
    };
    const frame = await renderMessage(msg);
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(frame)).toBe(true);
  });

  test("complete tool shows ✓ indicator", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-complete",
      blocks: [{ kind: "tool_call", callId: "call-1", toolName: "ls", status: "complete" }],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("✓");
  });

  test("error tool shows ✗ indicator", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-error",
      blocks: [{ kind: "tool_call", callId: "call-1", toolName: "ls", status: "error" }],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("✗");
  });
});

// ---------------------------------------------------------------------------
// Unknown / MCP tool rendering (Issue 11)
// ---------------------------------------------------------------------------

describe("MessageRow — unknown/MCP tool rendering", () => {
  test("unknown tool uses raw name as title on completion", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-mcp",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "my_custom_tool",
          status: "complete",
          args: '{"input":"hello","count":3}',
          result: toolResult("done"),
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("my_custom_tool");
    expect(frame).toContain("done");
  });

  test("MCP tool with server prefix renders Server ▸ subtitle label", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-mcp-2",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "golden-mcp__weather",
          status: "complete",
          args: '{"location":"SF"}',
          result: toolResult("sunny, 72°F"),
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    // MCP tools render as "Server ▸ subtitle" (capitalized server name)
    expect(frame).toContain("Golden-mcp");
    expect(frame).toContain("sunny");
  });

  test("structured display with subtitle for known tool", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-structured",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "Glob",
          status: "complete",
          args: '{"pattern":"src/**/*.ts"}',
          result: toolResult("src/index.ts\nsrc/app.ts"),
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Glob");
    expect(frame).toContain("src/**/*.ts");
  });

  test("fs_edit shows 'Edit' title with file path subtitle", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-edit",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "fs_edit",
          status: "complete",
          args: '{"file_path":"src/app.ts","old_string":"x","new_string":"y"}',
          result: toolResult("1 hunk applied"),
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Edit");
    expect(frame).toContain("src/app.ts");
  });

  test("Bash JSON result extracts exitCode chip and stdout body", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-bash-json",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "Bash",
          status: "complete",
          args: '{"command":"echo hi"}',
          result: toolResult({ stdout: "hi", stderr: "", exitCode: 0, durationMs: 5 }),
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Shell");
    expect(frame).toContain("exitCode=0");
    expect(frame).toContain("hi");
  });

  test("web_fetch result shows status chip", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-fetch",
      blocks: [
        {
          kind: "tool_call",
          callId: EXPANDED_CALL_ID,
          toolName: "web_fetch",
          status: "complete",
          args: '{"url":"https://example.com"}',
          result: toolResult({
            status: 200,
            statusText: "OK",
            contentType: "text/html",
            body: "Example Domain",
            format: "text",
            truncated: false,
            finalUrl: "https://example.com",
          }),
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Fetch");
    expect(frame).toContain("status=200");
    expect(frame).toContain("Example Domain");
  });
});
