/**
 * Tests for MessageRow — renders different ChatMessage variants.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@koi/dashboard-client";
import { testRender } from "@opentui/react/test-utils";
import { MessageRow } from "./message-row.js";

describe("MessageRow", () => {
  test("renders user message with prompt indicator", async () => {
    const msg: ChatMessage = { kind: "user", text: "Hello world", timestamp: Date.now() };
    const { captureCharFrame, renderOnce } = await testRender(
      <MessageRow message={msg} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Hello world");
  });

  test("renders assistant message as plain text without syntaxStyle", async () => {
    const msg: ChatMessage = { kind: "assistant", text: "I can help with that.", timestamp: Date.now() };
    const { captureCharFrame, renderOnce } = await testRender(
      <MessageRow message={msg} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("I can help with that.");
  });

  test("renders tool_call message with function name and args", async () => {
    const msg: ChatMessage = {
      kind: "tool_call",
      toolCallId: "tc1",
      name: "readFile",
      args: '{"path": "/etc/hosts"}',
      result: undefined,
      timestamp: Date.now(),
    };
    const { captureCharFrame, renderOnce } = await testRender(
      <MessageRow message={msg} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("readFile");
    expect(frame).toContain("/etc/hosts");
  });

  test("renders tool_call result when present", async () => {
    const msg: ChatMessage = {
      kind: "tool_call",
      toolCallId: "tc2",
      name: "getTime",
      args: "{}",
      result: "12:30 PM",
      timestamp: Date.now(),
    };
    const { captureCharFrame, renderOnce } = await testRender(
      <MessageRow message={msg} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("getTime");
    expect(frame).toContain("12:30 PM");
  });

  test("renders lifecycle event in italic", async () => {
    const msg: ChatMessage = {
      kind: "lifecycle",
      event: "Agent state: idle \u2192 running",
      timestamp: Date.now(),
    };
    const { captureCharFrame, renderOnce } = await testRender(
      <MessageRow message={msg} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Agent state: idle");
  });

  test("truncates long tool args", async () => {
    const longArgs = "x".repeat(300);
    const msg: ChatMessage = {
      kind: "tool_call",
      toolCallId: "tc3",
      name: "bigFunc",
      args: longArgs,
      result: undefined,
      timestamp: Date.now(),
    };
    const { captureCharFrame, renderOnce } = await testRender(
      <MessageRow message={msg} />,
      { width: 80, height: 10 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).not.toContain(longArgs);
    expect(frame).toContain("bigFunc");
  });
});
