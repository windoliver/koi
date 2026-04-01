import { describe, expect, test } from "bun:test";
import { hermesPattern } from "./hermes.js";

describe("hermesPattern", () => {
  test("has correct name", () => {
    expect(hermesPattern.name).toBe("hermes");
  });

  test("detects single tool call", () => {
    const text = '<tool_call>{"name": "get_weather", "arguments": {"city": "London"}}</tool_call>';
    const result = hermesPattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(1);
    expect(result?.toolCalls[0]?.toolName).toBe("get_weather");
    expect(result?.toolCalls[0]?.arguments).toEqual({ city: "London" });
    expect(result?.remainingText).toBe("");
  });

  test("detects multiple tool calls", () => {
    const text = [
      '<tool_call>{"name": "get_weather", "arguments": {"city": "London"}}</tool_call>',
      '<tool_call>{"name": "get_time", "arguments": {"tz": "UTC"}}</tool_call>',
    ].join("\n");
    const result = hermesPattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(2);
    expect(result?.toolCalls[0]?.toolName).toBe("get_weather");
    expect(result?.toolCalls[1]?.toolName).toBe("get_time");
  });

  test("preserves surrounding text", () => {
    const text =
      'Here is the result:\n<tool_call>{"name": "search", "arguments": {"q": "koi"}}</tool_call>\nDone.';
    const result = hermesPattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.remainingText).toBe("Here is the result:\n\nDone.");
  });

  test("returns undefined for text without tool calls", () => {
    const result = hermesPattern.detect("Just some normal text.");
    expect(result).toBeUndefined();
  });

  test("returns undefined for malformed JSON", () => {
    const text = "<tool_call>{not valid json}</tool_call>";
    const result = hermesPattern.detect(text);
    expect(result).toBeUndefined();
  });

  test("returns undefined when JSON lacks name field", () => {
    const text = '<tool_call>{"arguments": {"x": 1}}</tool_call>';
    const result = hermesPattern.detect(text);
    expect(result).toBeUndefined();
  });

  test("returns undefined when JSON lacks arguments field", () => {
    const text = '<tool_call>{"name": "test"}</tool_call>';
    const result = hermesPattern.detect(text);
    expect(result).toBeUndefined();
  });

  test("handles whitespace inside tags", () => {
    const text = '<tool_call>\n  {"name": "search", "arguments": {"q": "test"}}\n</tool_call>';
    const result = hermesPattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls[0]?.toolName).toBe("search");
  });

  test("handles special characters in arguments", () => {
    const text =
      '<tool_call>{"name": "write", "arguments": {"text": "hello\\nworld\\t!"}}</tool_call>';
    const result = hermesPattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls[0]?.arguments).toEqual({ text: "hello\nworld\t!" });
  });

  test("returns undefined for empty name", () => {
    const text = '<tool_call>{"name": "", "arguments": {}}</tool_call>';
    const result = hermesPattern.detect(text);
    expect(result).toBeUndefined();
  });
});
