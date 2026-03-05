import { describe, expect, test } from "bun:test";
import { createLlmSalienceGate } from "./llm-salience.js";

describe("createLlmSalienceGate", () => {
  test("returns true when LLM says yes", async () => {
    const classify = async (_prompt: string): Promise<string> => "Yes, this is a preference";
    const gate = createLlmSalienceGate(classify);
    expect(await gate.isSalient("I prefer dark mode", "preference")).toBe(true);
  });

  test("returns false when LLM says no", async () => {
    const classify = async (_prompt: string): Promise<string> => "No, this is just a greeting";
    const gate = createLlmSalienceGate(classify);
    expect(await gate.isSalient("Hello there!", "preference")).toBe(false);
  });

  test("fail-open: returns true on malformed response", async () => {
    const classify = async (_prompt: string): Promise<string> => "maybe something";
    const gate = createLlmSalienceGate(classify);
    expect(await gate.isSalient("hmm", undefined)).toBe(true);
  });

  test("fail-open: returns true when classify throws", async () => {
    const classify = async (_prompt: string): Promise<string> => {
      throw new Error("API down");
    };
    const gate = createLlmSalienceGate(classify);
    expect(await gate.isSalient("anything", "preference")).toBe(true);
  });

  test("includes category hint in prompt", async () => {
    let capturedPrompt = ""; // let: capture variable
    const classify = async (prompt: string): Promise<string> => {
      capturedPrompt = prompt;
      return "Yes";
    };
    const gate = createLlmSalienceGate(classify);
    await gate.isSalient("dark mode", "preference");
    expect(capturedPrompt).toContain("(category: preference)");
  });
});
