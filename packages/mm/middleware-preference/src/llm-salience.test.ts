import { describe, expect, test } from "bun:test";
import { createLlmSalienceGate } from "./llm-salience.js";

describe("createLlmSalienceGate", () => {
  test("returns true for salient content", async () => {
    const classify = async (_prompt: string): Promise<string> => "Yes";
    const gate = createLlmSalienceGate(classify);

    const result = await gate.isSalient("I prefer dark mode in all editors", "preference");
    expect(result).toBe(true);
  });

  test("returns false for generic acknowledgment", async () => {
    const classify = async (_prompt: string): Promise<string> => "No";
    const gate = createLlmSalienceGate(classify);

    const result = await gate.isSalient("ok thanks", "preference");
    expect(result).toBe(false);
  });

  test("handles mixed-case response", async () => {
    const classify = async (_prompt: string): Promise<string> => "YES, definitely";
    const gate = createLlmSalienceGate(classify);

    const result = await gate.isSalient("I always use 2-space indentation", "preference");
    expect(result).toBe(true);
  });

  test("returns true on malformed response (fail-open)", async () => {
    const classify = async (_prompt: string): Promise<string> => "I cannot determine that";
    const gate = createLlmSalienceGate(classify);

    const result = await gate.isSalient("maybe a preference?", "preference");
    expect(result).toBe(true);
  });

  test("returns true when classifier throws (fail-open)", async () => {
    const classify = async (_prompt: string): Promise<string> => {
      throw new Error("API error");
    };
    const gate = createLlmSalienceGate(classify);

    const result = await gate.isSalient("I prefer Bun over Node", "preference");
    expect(result).toBe(true);
  });
});
