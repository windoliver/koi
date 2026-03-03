import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { extractMessageText, normalizeRunAgentInput } from "./normalize.js";

// Minimal RunAgentInput factory for tests
function makeInput(
  overrides: Partial<RunAgentInput> & { messages?: RunAgentInput["messages"] },
): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [],
    tools: [],
    context: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractMessageText
// ---------------------------------------------------------------------------

describe("extractMessageText", () => {
  test("string content is returned as-is", () => {
    expect(extractMessageText("hello world")).toBe("hello world");
  });

  test("text blocks are concatenated", () => {
    expect(
      extractMessageText([
        { type: "text", text: "foo" },
        { type: "text", text: "bar" },
      ]),
    ).toBe("foobar");
  });

  test("non-text blocks are skipped", () => {
    expect(extractMessageText([{ type: "image" }, { type: "text", text: "hello" }])).toBe("hello");
  });

  test("empty array returns empty string", () => {
    expect(extractMessageText([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// normalizeRunAgentInput — stateful mode
// ---------------------------------------------------------------------------

describe("normalizeRunAgentInput (stateful)", () => {
  test("extracts last user message", () => {
    const input = makeInput({
      messages: [
        { id: "1", role: "user", content: "hello" },
        { id: "2", role: "assistant", content: "hi" },
        { id: "3", role: "user", content: "how are you?" },
      ],
    });

    const result = normalizeRunAgentInput(input, "stateful");
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "how are you?" }]);
    expect(result?.threadId).toBe("thread-1");
    expect(result?.metadata?.runId).toBe("run-1");
  });

  test("returns null when no user messages exist", () => {
    const input = makeInput({
      messages: [{ id: "1", role: "assistant", content: "hi" }],
    });
    expect(normalizeRunAgentInput(input, "stateful")).toBeNull();
  });

  test("returns null on empty messages array", () => {
    const input = makeInput({ messages: [] });
    expect(normalizeRunAgentInput(input, "stateful")).toBeNull();
  });

  test("last message is assistant — returns the user message before it", () => {
    const input = makeInput({
      messages: [
        { id: "1", role: "user", content: "what is 2+2?" },
        { id: "2", role: "assistant", content: "4" },
      ],
    });
    const result = normalizeRunAgentInput(input, "stateful");
    expect(result?.content).toEqual([{ kind: "text", text: "what is 2+2?" }]);
  });

  test("includes state in metadata.aguiState", () => {
    const input = makeInput({
      messages: [{ id: "1", role: "user", content: "hi" }],
      state: { counter: 5 },
    });
    const result = normalizeRunAgentInput(input, "stateful");
    expect(result?.metadata?.aguiState).toEqual({ counter: 5 });
  });

  test("omits aguiState when state is null", () => {
    const input = makeInput({
      messages: [{ id: "1", role: "user", content: "hi" }],
      state: null,
    });
    const result = normalizeRunAgentInput(input, "stateful");
    expect(result?.metadata?.aguiState).toBeUndefined();
  });

  test("handles content-block array in user message", () => {
    const input = makeInput({
      messages: [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    const result = normalizeRunAgentInput(input, "stateful");
    expect(result?.content).toEqual([{ kind: "text", text: "Hello world" }]);
  });
});

// ---------------------------------------------------------------------------
// normalizeRunAgentInput — stateless mode
// ---------------------------------------------------------------------------

describe("normalizeRunAgentInput (stateless)", () => {
  test("flattens all text messages into labeled blocks", () => {
    const input = makeInput({
      messages: [
        { id: "1", role: "user", content: "hello" },
        { id: "2", role: "assistant", content: "hi" },
        { id: "3", role: "user", content: "how are you?" },
      ],
    });

    const result = normalizeRunAgentInput(input, "stateless");
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([
      { kind: "text", text: "[user]: hello" },
      { kind: "text", text: "[assistant]: hi" },
      { kind: "text", text: "[user]: how are you?" },
    ]);
  });

  test("skips tool messages", () => {
    const input = makeInput({
      messages: [
        { id: "1", role: "user", content: "run a tool" },
        { id: "2", role: "tool", content: "tool result", toolCallId: "tc-1" },
      ],
    });
    const result = normalizeRunAgentInput(input, "stateless");
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toEqual({ kind: "text", text: "[user]: run a tool" });
  });

  test("returns null on empty messages array", () => {
    const input = makeInput({ messages: [] });
    expect(normalizeRunAgentInput(input, "stateless")).toBeNull();
  });

  test("returns null when all messages are non-text roles (e.g., only tool messages)", () => {
    const input = makeInput({
      messages: [{ id: "1", role: "tool", content: "result", toolCallId: "tc-1" }],
    });
    expect(normalizeRunAgentInput(input, "stateless")).toBeNull();
  });

  test("skips messages with empty content", () => {
    const input = makeInput({
      messages: [
        { id: "1", role: "user", content: "" },
        { id: "2", role: "user", content: "actual question" },
      ],
    });
    const result = normalizeRunAgentInput(input, "stateless");
    // Empty content message is filtered out
    expect(result?.content).toHaveLength(1);
    expect(result?.content[0]).toEqual({ kind: "text", text: "[user]: actual question" });
  });
});
