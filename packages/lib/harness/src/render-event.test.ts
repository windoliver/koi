import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { renderEngineEvent, shouldRender } from "./render-event.js";

// ---------------------------------------------------------------------------
// shouldRender
// ---------------------------------------------------------------------------

describe("shouldRender", () => {
  test("text_delta always renders", () => {
    const e: EngineEvent = { kind: "text_delta", delta: "hello" };
    expect(shouldRender(e, false)).toBe(true);
    expect(shouldRender(e, true)).toBe(true);
  });

  test("done always renders", () => {
    const e: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "completed",
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 100 },
      },
    };
    expect(shouldRender(e, false)).toBe(true);
    expect(shouldRender(e, true)).toBe(true);
  });

  test("thinking_delta only renders in verbose mode", () => {
    const e: EngineEvent = { kind: "thinking_delta", delta: "..." };
    expect(shouldRender(e, false)).toBe(false);
    expect(shouldRender(e, true)).toBe(true);
  });

  test("tool_call_start only renders in verbose mode", () => {
    const e: EngineEvent = { kind: "tool_call_start", toolName: "Read", callId: "c1" as never };
    expect(shouldRender(e, false)).toBe(false);
    expect(shouldRender(e, true)).toBe(true);
  });

  test("tool_call_end only renders in verbose mode", () => {
    const e: EngineEvent = { kind: "tool_call_end", callId: "c1" as never, result: null };
    expect(shouldRender(e, false)).toBe(false);
    expect(shouldRender(e, true)).toBe(true);
  });

  test("tool_result only renders in verbose mode", () => {
    const e: EngineEvent = {
      kind: "tool_result",
      callId: "c1" as never,
      toolName: "Bash",
      output: { stdout: "hello" },
    };
    expect(shouldRender(e, false)).toBe(false);
    expect(shouldRender(e, true)).toBe(true);
  });

  test("tool_call_delta never renders", () => {
    const e: EngineEvent = { kind: "tool_call_delta", callId: "c1" as never, delta: "x" };
    expect(shouldRender(e, false)).toBe(false);
    expect(shouldRender(e, true)).toBe(false);
  });

  test("custom never renders", () => {
    const e: EngineEvent = { kind: "custom", type: "debug", data: {} };
    expect(shouldRender(e, false)).toBe(false);
    expect(shouldRender(e, true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderEngineEvent
// ---------------------------------------------------------------------------

describe("renderEngineEvent", () => {
  test("text_delta returns delta string", () => {
    const e: EngineEvent = { kind: "text_delta", delta: "hello world" };
    expect(renderEngineEvent(e, false)).toBe("hello world");
  });

  test("empty text_delta returns null", () => {
    const e: EngineEvent = { kind: "text_delta", delta: "" };
    expect(renderEngineEvent(e, false)).toBeNull();
  });

  test("done with empty content returns newline", () => {
    const e: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "completed",
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
      },
    };
    expect(renderEngineEvent(e, false)).toBe("\n");
  });

  test("done with text content renders text + newline (non-streaming engines)", () => {
    // Regression: non-streaming engines emit full reply in done.output.content
    // without prior text_delta events — should not silently produce blank output.
    const e: EngineEvent = {
      kind: "done",
      output: {
        content: [{ kind: "text", text: "The answer is 4." }],
        stopReason: "completed",
        metrics: { totalTokens: 10, inputTokens: 5, outputTokens: 5, turns: 1, durationMs: 0 },
      },
    };
    expect(renderEngineEvent(e, false)).toBe("The answer is 4.\n");
  });

  test("thinking_delta returns null when not verbose", () => {
    const e: EngineEvent = { kind: "thinking_delta", delta: "thinking" };
    expect(renderEngineEvent(e, false)).toBeNull();
  });

  test("thinking_delta includes prefix when verbose", () => {
    const e: EngineEvent = { kind: "thinking_delta", delta: "thinking" };
    const result = renderEngineEvent(e, true);
    expect(result).not.toBeNull();
    expect(result).toContain("thinking");
  });

  test("tool_call_start returns null when not verbose", () => {
    const e: EngineEvent = { kind: "tool_call_start", toolName: "Read", callId: "c1" as never };
    expect(renderEngineEvent(e, false)).toBeNull();
  });

  test("tool_call_start includes tool name when verbose", () => {
    const e: EngineEvent = { kind: "tool_call_start", toolName: "Read", callId: "c1" as never };
    const result = renderEngineEvent(e, true);
    expect(result).not.toBeNull();
    expect(result).toContain("Read");
  });

  test("tool_result returns null when not verbose", () => {
    const e: EngineEvent = {
      kind: "tool_result",
      callId: "c1" as never,
      toolName: "Bash",
      output: "hello",
    };
    expect(renderEngineEvent(e, false)).toBeNull();
  });

  test("tool_result includes tool name when verbose", () => {
    const e: EngineEvent = {
      kind: "tool_result",
      callId: "c1" as never,
      toolName: "Bash",
      output: "hello",
    };
    const result = renderEngineEvent(e, true);
    expect(result).not.toBeNull();
    expect(result).toContain("Bash");
  });
});
