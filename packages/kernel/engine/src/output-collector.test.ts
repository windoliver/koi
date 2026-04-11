/**
 * Tests for output collectors — ensure they read tool execution output from
 * `tool_result` events, not the AccumulatedToolCall metadata in `tool_call_end`.
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, ToolCallId } from "@koi/core";
import { createTextCollector, createVerdictCollector } from "./output-collector.js";

const callId = (s: string): ToolCallId => s as ToolCallId;

describe("createTextCollector", () => {
  test("captures tool_result output for tool-only child agents", () => {
    const collector = createTextCollector();
    const events: EngineEvent[] = [
      { kind: "turn_start", turnIndex: 0 },
      { kind: "tool_call_start", toolName: "fs_read", callId: callId("c1") },
      {
        kind: "tool_call_end",
        callId: callId("c1"),
        // This is AccumulatedToolCall metadata, NOT the execution output.
        // The collector should IGNORE this and wait for tool_result.
        result: {
          toolName: "fs_read",
          callId: "c1",
          rawArgs: '{"path":"/foo"}',
          parsedArgs: { path: "/foo" },
        },
      },
      {
        kind: "tool_result",
        callId: callId("c1"),
        // This is the actual execution output — the file contents.
        output: "file contents here",
      },
      { kind: "turn_end", turnIndex: 0 },
    ];

    for (const e of events) collector.observe(e);
    // Output should be the tool result content, NOT the AccumulatedToolCall JSON
    expect(collector.output()).toBe("file contents here");
  });

  test("prefers text_delta over tool_result", () => {
    const collector = createTextCollector();
    const events: EngineEvent[] = [
      { kind: "text_delta", delta: "narrated response" },
      { kind: "tool_call_start", toolName: "fs_read", callId: callId("c1") },
      {
        kind: "tool_call_end",
        callId: callId("c1"),
        result: { toolName: "fs_read", callId: "c1", rawArgs: "{}", parsedArgs: {} },
      },
      { kind: "tool_result", callId: callId("c1"), output: "tool output" },
    ];

    for (const e of events) collector.observe(e);
    expect(collector.output()).toBe("narrated response");
  });

  test("stringifies object tool_result output", () => {
    const collector = createTextCollector();
    const events: EngineEvent[] = [
      { kind: "tool_call_start", toolName: "glob", callId: callId("c1") },
      {
        kind: "tool_call_end",
        callId: callId("c1"),
        result: { toolName: "glob", callId: "c1", rawArgs: "{}", parsedArgs: {} },
      },
      {
        kind: "tool_result",
        callId: callId("c1"),
        output: { matches: ["a.ts", "b.ts"] },
      },
    ];

    for (const e of events) collector.observe(e);
    expect(collector.output()).toBe(JSON.stringify({ matches: ["a.ts", "b.ts"] }));
  });
});

describe("createVerdictCollector", () => {
  test("captures verdict tool output from tool_result, not tool_call_end metadata", () => {
    const collector = createVerdictCollector("HookVerdict");
    const events: EngineEvent[] = [
      { kind: "tool_call_start", toolName: "HookVerdict", callId: callId("c1") },
      {
        kind: "tool_call_end",
        callId: callId("c1"),
        // Metadata, should be ignored.
        result: {
          toolName: "HookVerdict",
          callId: "c1",
          rawArgs: '{"ok":true}',
          parsedArgs: { ok: true },
        },
      },
      {
        kind: "tool_result",
        callId: callId("c1"),
        output: { ok: true, reason: "looks good" },
      },
    ];

    for (const e of events) collector.observe(e);
    expect(collector.output()).toBe(JSON.stringify({ ok: true, reason: "looks good" }));
  });

  test("ignores non-verdict tool results when required tool is set", () => {
    const collector = createVerdictCollector("HookVerdict");
    const events: EngineEvent[] = [
      { kind: "tool_call_start", toolName: "OtherTool", callId: callId("c1") },
      {
        kind: "tool_call_end",
        callId: callId("c1"),
        result: { toolName: "OtherTool", callId: "c1", rawArgs: "{}", parsedArgs: {} },
      },
      { kind: "tool_result", callId: callId("c1"), output: "ignored" },
      { kind: "text_delta", delta: "narrated" },
    ];

    for (const e of events) collector.observe(e);
    // No verdict captured → falls back to text
    expect(collector.output()).toBe("narrated");
  });

  test("stops capturing after verdict tool completes", () => {
    const collector = createVerdictCollector("HookVerdict");
    const events: EngineEvent[] = [
      { kind: "tool_call_start", toolName: "HookVerdict", callId: callId("c1") },
      {
        kind: "tool_call_end",
        callId: callId("c1"),
        result: { toolName: "HookVerdict", callId: "c1", rawArgs: "{}", parsedArgs: {} },
      },
      { kind: "tool_result", callId: callId("c1"), output: "verdict captured" },
      { kind: "text_delta", delta: "should be ignored" },
    ];

    for (const e of events) collector.observe(e);
    expect(collector.output()).toBe("verdict captured");
  });
});
