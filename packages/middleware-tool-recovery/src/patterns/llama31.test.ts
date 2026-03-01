import { describe, expect, test } from "bun:test";
import { llama31Pattern } from "./llama31.js";

describe("llama31Pattern", () => {
  test("has correct name", () => {
    expect(llama31Pattern.name).toBe("llama31");
  });

  test("detects single tool call", () => {
    const text = '<function=get_weather>{"city": "London"}</function>';
    const result = llama31Pattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(1);
    expect(result?.toolCalls[0]?.toolName).toBe("get_weather");
    expect(result?.toolCalls[0]?.arguments).toEqual({ city: "London" });
    expect(result?.remainingText).toBe("");
  });

  test("detects multiple tool calls", () => {
    const text = [
      '<function=get_weather>{"city": "London"}</function>',
      '<function=get_time>{"tz": "UTC"}</function>',
    ].join("\n");
    const result = llama31Pattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls).toHaveLength(2);
    expect(result?.toolCalls[0]?.toolName).toBe("get_weather");
    expect(result?.toolCalls[1]?.toolName).toBe("get_time");
  });

  test("handles tool name with underscores", () => {
    const text = '<function=my_special_tool>{"x": 1}</function>';
    const result = llama31Pattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls[0]?.toolName).toBe("my_special_tool");
  });

  test("handles tool name with dashes", () => {
    const text = '<function=my-tool>{"x": 1}</function>';
    const result = llama31Pattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls[0]?.toolName).toBe("my-tool");
  });

  test("handles empty arguments body", () => {
    const text = "<function=no_args></function>";
    const result = llama31Pattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.toolCalls[0]?.arguments).toEqual({});
  });

  test("preserves surrounding text", () => {
    const text = 'Let me call:\n<function=search>{"q": "koi"}</function>\nDone.';
    const result = llama31Pattern.detect(text);
    expect(result).toBeDefined();
    expect(result?.remainingText).toBe("Let me call:\n\nDone.");
  });

  test("returns undefined for text without tool calls", () => {
    const result = llama31Pattern.detect("Regular text.");
    expect(result).toBeUndefined();
  });

  test("returns undefined for malformed JSON body", () => {
    const text = "<function=test>{bad json}</function>";
    const result = llama31Pattern.detect(text);
    expect(result).toBeUndefined();
  });
});
