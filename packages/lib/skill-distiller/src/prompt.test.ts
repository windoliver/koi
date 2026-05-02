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

  test("renders tool calls with names AND arguments (so LLM can parameterize)", () => {
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [
        {
          role: "assistant",
          toolCalls: [
            { name: "read_file", argsJson: '{"path":"/etc/foo"}' },
            { name: "write_file", argsJson: '{"path":"/tmp/bar"}' },
          ],
        },
      ],
    };
    const out = renderDistillationPrompt(trace);
    expect(out).toContain('read_file({"path":"/etc/foo"})');
    expect(out).toContain('write_file({"path":"/tmp/bar"})');
  });

  test("clips very long tool args to keep prompt size bounded", () => {
    const longArgs = `{"path":"${"x".repeat(2000)}"}`;
    const trace: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "assistant", toolCalls: [{ name: "read_file", argsJson: longArgs }] }],
    };
    const out = renderDistillationPrompt(trace);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(longArgs.length + 1000);
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
