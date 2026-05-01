import { describe, expect, test } from "bun:test";
import { PROMPT_VERSION, renderDistillationPrompt } from "./prompt.js";
import type { DistillationTrace } from "./types.js";

describe("renderDistillationPrompt", () => {
  test("includes traceId and turn count", () => {
    const trace: DistillationTrace = {
      traceId: "abc",
      turns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
    };
    const out = renderDistillationPrompt(trace);
    expect(out).toContain("id=abc");
    expect(out).toContain("turns=2");
  });

  test("renders tool calls by name", () => {
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [
        {
          role: "assistant",
          toolCalls: [
            { name: "read_file", argsJson: "{}" },
            { name: "write_file", argsJson: "{}" },
          ],
        },
      ],
    };
    expect(renderDistillationPrompt(trace)).toContain("read_file, write_file");
  });

  test("truncates very long turn text", () => {
    const longText = "x".repeat(5000);
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "user", text: longText }],
    };
    const out = renderDistillationPrompt(trace);
    expect(out.length).toBeLessThan(longText.length + 500);
    expect(out).toContain("…");
  });

  test("PROMPT_VERSION is exported and stable", () => {
    expect(PROMPT_VERSION).toBe("1");
  });
});
