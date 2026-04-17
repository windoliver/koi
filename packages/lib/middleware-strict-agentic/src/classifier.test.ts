import { describe, expect, test } from "bun:test";
import { classifyTurn } from "./classifier.js";
import { resolveStrictAgenticConfig } from "./config.js";

const resolved = resolveStrictAgenticConfig({});

describe("classifyTurn", () => {
  test("action when toolCallCount > 0", () => {
    const r = classifyTurn({ toolCallCount: 1, outputText: "" }, resolved);
    expect(r.kind).toBe("action");
  });

  test("action short-circuits — even planning text ignored", () => {
    const r = classifyTurn(
      { toolCallCount: 2, outputText: "I will now proceed to do a thing" },
      resolved,
    );
    expect(r.kind).toBe("action");
  });

  test("user-question when no tool calls and trailing ?", () => {
    const r = classifyTurn(
      { toolCallCount: 0, outputText: "Do you want me to proceed?" },
      resolved,
    );
    expect(r.kind).toBe("user-question");
  });

  test("explicit-done when output mentions done", () => {
    const r = classifyTurn({ toolCallCount: 0, outputText: "All green — done." }, resolved);
    expect(r.kind).toBe("explicit-done");
  });

  test("filler when no tool calls, no question, no done marker", () => {
    const r = classifyTurn(
      { toolCallCount: 0, outputText: "I will now proceed to edit the file." },
      resolved,
    );
    expect(r.kind).toBe("filler");
  });

  test("blank / whitespace-only output with no tool calls is filler (degraded response)", () => {
    // Silent-failure guard: a model stopping with no text AND no tool calls
    // has done nothing. Even though it is not planning language, the gate
    // must NOT bless it as success — otherwise degraded-adapter paths can
    // ship an empty completion and pass through.
    expect(classifyTurn({ toolCallCount: 0, outputText: "" }, resolved).kind).toBe("filler");
    expect(classifyTurn({ toolCallCount: 0, outputText: "   " }, resolved).kind).toBe("filler");
    expect(classifyTurn({ toolCallCount: 0, outputText: "\n\t  " }, resolved).kind).toBe("filler");
    // But a blank-text turn with tool calls is action (the work happened).
    expect(classifyTurn({ toolCallCount: 1, outputText: "" }, resolved).kind).toBe("action");
  });

  test("plain substantive answer is action, not filler", () => {
    // Regression: a concise final answer like "10" after prior tool use
    // has toolCallCount=0 and no completion keyword, but it is NOT plan
    // language and must not be re-prompted.
    expect(classifyTurn({ toolCallCount: 0, outputText: "10" }, resolved).kind).toBe("action");
    expect(classifyTurn({ toolCallCount: 0, outputText: "Updated 3 files" }, resolved).kind).toBe(
      "action",
    );
    expect(classifyTurn({ toolCallCount: 0, outputText: "The answer is 42." }, resolved).kind).toBe(
      "action",
    );
  });

  test("user-question wins over done marker when both match", () => {
    // question check runs before done check
    const r = classifyTurn({ toolCallCount: 0, outputText: "Is this task done?" }, resolved);
    expect(r.kind).toBe("user-question");
  });

  test("custom predicate wins", () => {
    const custom = resolveStrictAgenticConfig({
      isExplicitDone: (s) => s.includes("FINI"),
    });
    const r = classifyTurn({ toolCallCount: 0, outputText: "FINI." }, custom);
    expect(r.kind).toBe("explicit-done");
  });
});
