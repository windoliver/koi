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
    () => <MessageRow message={message} spinnerFrame={0} />,
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
  test("shows tool name with running indicator", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "read_file",
          status: "running",
        },
      ],
      streaming: true,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("read_file");
  });

  test("shows tool name with complete indicator", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "bash",
          status: "complete",
          args: '{"cmd":"ls"}',
          result: "file1.ts\nfile2.ts",
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("bash");
    expect(frame).toContain("file1.ts");
  });

  test("degrades gracefully with non-serializable result", async () => {
    const circular: Record<string, unknown> = { name: "test" };
    circular["self"] = circular;
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "bad_tool",
          status: "complete",
          result: circular,
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("bad_tool");
    expect(frame).toContain("[unrenderable result]");
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

  test("shows tool name with error indicator", async () => {
    const msg: TuiMessage = {
      kind: "assistant",
      id: "assistant-0",
      blocks: [
        {
          kind: "tool_call",
          callId: "call-1",
          toolName: "write_file",
          status: "error",
        },
      ],
      streaming: false,
    };
    const frame = await renderMessage(msg);
    expect(frame).toContain("write_file");
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
        toolName: "grep",
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
    expect(frame).toContain("grep");
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
