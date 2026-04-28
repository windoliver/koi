import { describe, expect, test } from "bun:test";
import { hermesPattern } from "./hermes.js";
import { jsonFencePattern } from "./json-fence.js";
import { llama31Pattern } from "./llama31.js";
import { BUILTIN_PATTERNS, resolvePatterns } from "./registry.js";

describe("hermesPattern", () => {
  test("extracts a single tool call and strips the tag", () => {
    const text = 'before <tool_call>{"name":"search","arguments":{"q":"koi"}}</tool_call> after';
    const result = hermesPattern.detect(text);
    expect(result?.toolCalls).toEqual([{ toolName: "search", arguments: { q: "koi" } }]);
    expect(result?.remainingText).toBe("before  after");
  });

  test("extracts multiple tool calls in order", () => {
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{"k":1}}</tool_call>';
    const result = hermesPattern.detect(text);
    expect(result?.toolCalls.map((c) => c.toolName)).toEqual(["a", "b"]);
  });

  test("returns undefined when JSON body is malformed", () => {
    const text = "<tool_call>not json</tool_call>";
    expect(hermesPattern.detect(text)).toBeUndefined();
  });

  test("returns undefined when name is missing", () => {
    const text = '<tool_call>{"arguments":{}}</tool_call>';
    expect(hermesPattern.detect(text)).toBeUndefined();
  });

  test("returns undefined when no <tool_call> tags are present", () => {
    expect(hermesPattern.detect("plain text with no tags")).toBeUndefined();
  });
});

describe("llama31Pattern", () => {
  test("extracts tool name from attribute and arguments from body", () => {
    const text = '<function=search>{"q":"koi"}</function>';
    const result = llama31Pattern.detect(text);
    expect(result?.toolCalls).toEqual([{ toolName: "search", arguments: { q: "koi" } }]);
  });

  test("treats empty body as empty arguments object", () => {
    const text = "<function=ping></function>";
    const result = llama31Pattern.detect(text);
    expect(result?.toolCalls).toEqual([{ toolName: "ping", arguments: {} }]);
  });

  test("returns undefined when body JSON is malformed", () => {
    expect(llama31Pattern.detect("<function=x>{bad}</function>")).toBeUndefined();
  });

  test("returns undefined when no <function=...> tags are present", () => {
    expect(llama31Pattern.detect("nothing here")).toBeUndefined();
  });
});

describe("jsonFencePattern", () => {
  test("extracts tool call from a json-tagged fence", () => {
    const text = '```json\n{"name":"search","arguments":{"q":"koi"}}\n```';
    const result = jsonFencePattern.detect(text);
    expect(result?.toolCalls).toEqual([{ toolName: "search", arguments: { q: "koi" } }]);
  });

  test("extracts from untagged fence too", () => {
    const text = '```\n{"name":"x","arguments":{}}\n```';
    const result = jsonFencePattern.detect(text);
    expect(result?.toolCalls).toEqual([{ toolName: "x", arguments: {} }]);
  });

  test("skips fences whose JSON body lacks the tool-call shape", () => {
    // Two fences: first is unrelated JSON (no name/arguments shape), second is a
    // valid tool call. Only the latter is extracted; the former survives in remaining.
    const text = '```\n{"unrelated":true}\n```\nthen\n```json\n{"name":"x","arguments":{}}\n```';
    const result = jsonFencePattern.detect(text);
    expect(result?.toolCalls.length).toBe(1);
    expect(result?.remainingText).toContain("unrelated");
  });

  test("returns undefined when no fences match the tool-call shape", () => {
    expect(jsonFencePattern.detect('```\n{"unrelated":true}\n```')).toBeUndefined();
  });
});

describe("registry", () => {
  test("BUILTIN_PATTERNS exposes the three built-ins by name", () => {
    expect(BUILTIN_PATTERNS.get("hermes")).toBe(hermesPattern);
    expect(BUILTIN_PATTERNS.get("llama31")).toBe(llama31Pattern);
    expect(BUILTIN_PATTERNS.get("json-fence")).toBe(jsonFencePattern);
  });

  test("resolvePatterns returns built-ins for name strings", () => {
    expect(resolvePatterns(["hermes", "json-fence"])).toEqual([hermesPattern, jsonFencePattern]);
  });

  test("resolvePatterns passes custom pattern objects through unchanged", () => {
    const custom = { name: "c", detect: () => undefined };
    expect(resolvePatterns([custom])[0]).toBe(custom);
  });

  test("resolvePatterns throws on unknown built-in name", () => {
    expect(() => resolvePatterns(["mystery"])).toThrow(/Unknown tool recovery pattern/);
  });
});
