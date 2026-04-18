import { describe, expect, test } from "bun:test";
import { normalizeUsage } from "./normalize-usage.js";

describe("normalizeUsage", () => {
  test("returns all-zero when usage is undefined", () => {
    expect(normalizeUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  test("maps L0 ModelResponse.usage fields", () => {
    const got = normalizeUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
    });
    expect(got).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
      reasoningTokens: 0,
    });
  });

  test("missing cache fields default to 0", () => {
    const got = normalizeUsage({ inputTokens: 8, outputTokens: 4 });
    expect(got.cacheReadTokens).toBe(0);
    expect(got.cacheWriteTokens).toBe(0);
  });

  test("reads reasoningTokens from metadata when present", () => {
    const got = normalizeUsage({ inputTokens: 1, outputTokens: 2 }, { reasoningTokens: 7 });
    expect(got.reasoningTokens).toBe(7);
  });

  test("non-number reasoningTokens metadata ignored", () => {
    const got = normalizeUsage({ inputTokens: 1, outputTokens: 2 }, { reasoningTokens: "oops" });
    expect(got.reasoningTokens).toBe(0);
  });
});
