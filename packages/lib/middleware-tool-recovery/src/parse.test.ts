import { describe, expect, mock, test } from "bun:test";
import { recoverToolCalls } from "./parse.js";
import { hermesPattern } from "./patterns/hermes.js";
import { jsonFencePattern } from "./patterns/json-fence.js";
import { llama31Pattern } from "./patterns/llama31.js";
import type { RecoveryEvent, ToolCallPattern } from "./types.js";

const allOf = (...names: string[]): ReadonlySet<string> => new Set(names);

describe("recoverToolCalls", () => {
  test("returns undefined when allowedTools is empty", () => {
    const out = recoverToolCalls("anything", [hermesPattern], new Set(), 10);
    expect(out).toBeUndefined();
  });

  test("returns undefined when no pattern matches", () => {
    const out = recoverToolCalls("plain text", [hermesPattern], allOf("foo"), 10);
    expect(out).toBeUndefined();
  });

  test("first matching pattern wins (hermes precedes llama31)", () => {
    const text = '<tool_call>{"name":"foo","arguments":{"x":1}}</tool_call>';
    const out = recoverToolCalls(text, [hermesPattern, llama31Pattern], allOf("foo"), 10);
    expect(out?.toolCalls.length).toBe(1);
    expect(out?.toolCalls[0]?.toolName).toBe("foo");
  });

  test("emits 'rejected' event for tool names not in the allowlist", () => {
    const events: RecoveryEvent[] = [];
    const text =
      '<tool_call>{"name":"good","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"bad","arguments":{}}</tool_call>';
    const out = recoverToolCalls(text, [hermesPattern], allOf("good"), 10, (e) => events.push(e));
    expect(out?.toolCalls.length).toBe(1);
    expect(events.some((e) => e.kind === "rejected" && e.toolName === "bad")).toBe(true);
    expect(events.some((e) => e.kind === "recovered")).toBe(true);
  });

  test("emits 'recovered' event with the winning pattern name", () => {
    const onEvent = mock((_: RecoveryEvent) => undefined);
    const text = '<tool_call>{"name":"foo","arguments":{}}</tool_call>';
    recoverToolCalls(text, [hermesPattern], allOf("foo"), 10, onEvent);
    const recovered = onEvent.mock.calls.find((c) => c[0]?.kind === "recovered");
    expect(recovered).toBeDefined();
  });

  test("caps recovered calls at maxCalls", () => {
    const text = Array.from({ length: 5 })
      .map((_, i) => `<tool_call>{"name":"t${String(i)}","arguments":{}}</tool_call>`)
      .join("");
    const out = recoverToolCalls(text, [hermesPattern], allOf("t0", "t1", "t2", "t3", "t4"), 2);
    expect(out?.toolCalls.length).toBe(2);
    expect(out?.toolCalls.map((c) => c.toolName)).toEqual(["t0", "t1"]);
  });

  test("falls through to next pattern when first pattern's calls are all rejected", () => {
    // Hermes matches but tool name disallowed → try llama31
    const text =
      '<tool_call>{"name":"hermesOnly","arguments":{}}</tool_call>' +
      '<function=allowed>{"y":2}</function>';
    const out = recoverToolCalls(text, [hermesPattern, llama31Pattern], allOf("allowed"), 10);
    expect(out?.toolCalls.length).toBe(1);
    expect(out?.toolCalls[0]?.toolName).toBe("allowed");
  });

  test("returns undefined when every pattern rejects every match", () => {
    const text = '<tool_call>{"name":"nope","arguments":{}}</tool_call>';
    const out = recoverToolCalls(text, [hermesPattern, llama31Pattern], allOf("ok"), 10);
    expect(out).toBeUndefined();
  });

  test("custom pattern is invoked and short-circuits when it returns a result", () => {
    const custom: ToolCallPattern = {
      name: "custom",
      detect: (text) =>
        text.includes("MAGIC")
          ? { toolCalls: [{ toolName: "x", arguments: { v: 1 } }], remainingText: "" }
          : undefined,
    };
    const out = recoverToolCalls("MAGIC here", [custom, hermesPattern], allOf("x"), 10);
    expect(out?.toolCalls[0]?.toolName).toBe("x");
  });

  test("json-fence pattern only treats fences with name+arguments as tool calls", () => {
    const text = '```json\n{"name":"f","arguments":{"a":1}}\n```\n```\n{"unrelated":true}\n```';
    const out = recoverToolCalls(text, [jsonFencePattern], allOf("f"), 10);
    expect(out?.toolCalls.length).toBe(1);
    expect(out?.remainingText).toContain("unrelated");
  });
});
