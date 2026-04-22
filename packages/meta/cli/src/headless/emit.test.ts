import { describe, expect, test } from "bun:test";
import { createEmitter } from "./emit.js";

describe("createEmitter", () => {
  test("writes single NDJSON line terminated with \\n", () => {
    const chunks: string[] = [];
    const emit = createEmitter({
      sessionId: "sess-123",
      write: (s) => chunks.push(s),
    });
    emit({ kind: "assistant_text", text: "hello" });
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0];
    expect(chunk).toBeDefined();
    if (chunk === undefined) return;
    expect(chunk.endsWith("\n")).toBe(true);
    expect(chunk.split("\n").length).toBe(2);
  });

  test("stamps sessionId on every event", () => {
    const chunks: string[] = [];
    const emit = createEmitter({ sessionId: "sess-abc", write: (s) => chunks.push(s) });
    emit({ kind: "assistant_text", text: "x" });
    const first = chunks[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(JSON.parse(first.trimEnd())).toMatchObject({
      sessionId: "sess-abc",
      kind: "assistant_text",
      text: "x",
    });
  });

  test("escapes U+2028 in event payload", () => {
    const chunks: string[] = [];
    const emit = createEmitter({ sessionId: "s", write: (s) => chunks.push(s) });
    emit({ kind: "assistant_text", text: "a\u2028b" });
    const first = chunks[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first).not.toContain("\u2028");
    expect(first).toContain("\\u2028");
  });

  test("result event carries exitCode and ok flag", () => {
    const chunks: string[] = [];
    const emit = createEmitter({ sessionId: "s", write: (s) => chunks.push(s) });
    emit({ kind: "result", ok: false, exitCode: 2, error: "denied" });
    const first = chunks[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(JSON.parse(first.trimEnd())).toEqual({
      kind: "result",
      sessionId: "s",
      ok: false,
      exitCode: 2,
      error: "denied",
    });
  });

  test("session_start carries startedAt timestamp", () => {
    const chunks: string[] = [];
    const emit = createEmitter({ sessionId: "s", write: (s) => chunks.push(s) });
    emit({ kind: "session_start", startedAt: "2026-04-17T00:00:00.000Z" });
    const first = chunks[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const parsed = JSON.parse(first.trimEnd());
    expect(parsed).toMatchObject({
      kind: "session_start",
      sessionId: "s",
      startedAt: "2026-04-17T00:00:00.000Z",
    });
  });

  test("tool_call and tool_result events serialize args and result", () => {
    const chunks: string[] = [];
    const emit = createEmitter({ sessionId: "s", write: (s) => chunks.push(s) });
    emit({ kind: "tool_call", toolName: "Bash", args: { cmd: "ls" } });
    emit({ kind: "tool_result", toolName: "Bash", ok: true, result: "file.txt" });
    expect(chunks).toHaveLength(2);
    const callChunk = chunks[0];
    const resultChunk = chunks[1];
    expect(callChunk).toBeDefined();
    expect(resultChunk).toBeDefined();
    if (callChunk === undefined || resultChunk === undefined) return;
    const call = JSON.parse(callChunk.trimEnd());
    const result = JSON.parse(resultChunk.trimEnd());
    expect(call).toMatchObject({
      kind: "tool_call",
      sessionId: "s",
      toolName: "Bash",
      args: { cmd: "ls" },
    });
    expect(result).toMatchObject({
      kind: "tool_result",
      sessionId: "s",
      toolName: "Bash",
      ok: true,
      result: "file.txt",
    });
  });
});
