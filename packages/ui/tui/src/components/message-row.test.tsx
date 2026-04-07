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
import type { TuiAssistantBlock, TuiMessage } from "../state/types.js";
import { MessageRow } from "./message-row.js";

const RENDER_OPTS = { width: 80, height: 24 };

async function renderMessage(
  message: TuiMessage,
  opts = RENDER_OPTS,
): Promise<string> {
  const { captureCharFrame, renderOnce, renderer } = await testRender(
    () => <MessageRow message={message} spinnerFrame={() => 0} />,
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
          callId: "call-1",
          toolName: "Bash",
          status: "complete",
          args: '{"command":"ls"}',
          result: "file1.ts\nfile2.ts",
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

  test("renders pre-serialized error sentinel from reducer", async () => {
    // The reducer's capResult() converts non-serializable values to "[unserializable]".
    // The component receives `result` as a string — this tests the sentinel display.
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "bad_tool",
          status: "complete",
          result: "[unserializable]",
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("bad_tool");
    expect(frame).toContain("[unserializable]");
  });

  test("renders pre-capped tool result from reducer", async () => {
    // Results are capped at reducer level (capResult). This test verifies
    // that a bounded result renders without crashing.
    const cappedResult = "x".repeat(50_000);
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "big_tool",
          status: "complete",
          result: cappedResult,
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
        callId: "call-1",
        toolName: "Grep",
        status: "complete",
        args: '{"pattern":"foo"}',
        result: "found in bar.ts",
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
          callId: "call-1",
          toolName: "my_custom_tool",
          status: "complete",
          args: '{"input":"hello","count":3}',
          result: "done",
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("my_custom_tool");
    expect(frame).toContain("done");
  });

  test("MCP tool with server prefix renders raw name", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-mcp-2",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "golden-mcp__weather",
          status: "complete",
          args: '{"location":"SF"}',
          result: "sunny, 72°F",
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("golden-mcp__weather");
    expect(frame).toContain("sunny");
  });

  test("structured display with subtitle for known tool", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-structured",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "Glob",
          status: "complete",
          args: '{"pattern":"src/**/*.ts"}',
          result: "src/index.ts\nsrc/app.ts",
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
          callId: "call-1",
          toolName: "fs_edit",
          status: "complete",
          args: '{"file_path":"src/app.ts","old_string":"x","new_string":"y"}',
          result: "1 hunk applied",
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("Edit");
    expect(frame).toContain("src/app.ts");
  });
});
