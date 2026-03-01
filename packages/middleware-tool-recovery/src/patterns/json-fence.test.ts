import { describe, expect, test } from "bun:test";
import { jsonFencePattern } from "./json-fence.js";

describe("jsonFencePattern", () => {
  test("has correct name", () => {
    expect(jsonFencePattern.name).toBe("json-fence");
  });

  test("detects tool call in json fence", () => {
    const text = '```json\n{"name": "get_weather", "arguments": {"city": "London"}}\n```';
    const result = jsonFencePattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(1);
    expect(result?.toolCalls[0]?.toolName).toBe("get_weather");
    expect(result?.toolCalls[0]?.arguments).toEqual({ city: "London" });
  });

  test("detects tool call in fence without json tag", () => {
    const text = '```\n{"name": "search", "arguments": {"q": "test"}}\n```';
    const result = jsonFencePattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls[0]?.toolName).toBe("search");
  });

  test("detects multiple tool calls", () => {
    const text = [
      '```json\n{"name": "get_weather", "arguments": {"city": "London"}}\n```',
      '```json\n{"name": "get_time", "arguments": {"tz": "UTC"}}\n```',
    ].join("\n");
    const result = jsonFencePattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(2);
  });

  test("skips non-tool-call JSON fences", () => {
    const text = '```json\n{"data": [1, 2, 3]}\n```';
    const result = jsonFencePattern.detect(text);
    expect(result).toBeUndefined();
  });

  test("handles mixed tool-call and non-tool-call fences", () => {
    const text = [
      "Some text",
      '```json\n{"data": [1, 2, 3]}\n```',
      '```json\n{"name": "search", "arguments": {"q": "koi"}}\n```',
    ].join("\n");
    const result = jsonFencePattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(1);
    expect(result?.toolCalls[0]?.toolName).toBe("search");
  });

  test("preserves surrounding text", () => {
    const text = 'Here:\n```json\n{"name": "search", "arguments": {"q": "koi"}}\n```\nDone.';
    const result = jsonFencePattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.remainingText).toBe("Here:\n\nDone.");
  });

  test("returns undefined for text without fences", () => {
    const result = jsonFencePattern.detect("No code fences here.");
    expect(result).toBeUndefined();
  });

  test("returns undefined for malformed JSON in fence", () => {
    const text = "```json\n{bad json}\n```";
    const result = jsonFencePattern.detect(text);
    expect(result).toBeUndefined();
  });

  test("returns undefined when name is missing from JSON", () => {
    const text = '```json\n{"arguments": {"x": 1}}\n```';
    const result = jsonFencePattern.detect(text);
    expect(result).toBeUndefined();
  });

  test("returns undefined when arguments is missing from JSON", () => {
    const text = '```json\n{"name": "test"}\n```';
    const result = jsonFencePattern.detect(text);
    expect(result).toBeUndefined();
  });
});
