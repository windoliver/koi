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

  test("filler pattern wins over trailing `?` — cannot bypass gate by appending a question mark", () => {
    // Regression: "I will update the file now?" previously classified as
    // user-question because the trailing `?` predicate ran first. A model
    // could escape the gate by appending `?` to any plan-only reply. Filler
    // detection now runs BEFORE the question exemption so planning language
    // still blocks.
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "I will update the file now?" }, resolved).kind,
    ).toBe("filler");
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "I'll go ahead and make the change?" }, resolved)
        .kind,
    ).toBe("filler");
    // A genuine question without planning language is still user-question.
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "Should I go ahead with this?" }, resolved).kind,
    ).toBe("user-question");
  });

  test("let me <verb> is filler, but `let me know ...` is not (benign exclusion)", () => {
    // Common first-person planning like "Let me inspect the file." must
    // block. The benign "let me know ..." form — asking the user for input
    // — is explicitly excluded via negative lookahead.
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "Let me inspect the file." }, resolved).kind,
    ).toBe("filler");
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "Let me check the logs." }, resolved).kind,
    ).toBe("filler");
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "Let me now run the migration." }, resolved)
        .kind,
    ).toBe("filler");
    // Benign form: asking the user for input.
    expect(
      classifyTurn(
        { toolCallCount: 0, outputText: "Let me know when the build is ready." },
        resolved,
      ).kind,
    ).toBe("action");
  });

  test("ambiguous standalone tokens like `let's` and `next step` do NOT trigger filler", () => {
    // Regression: the default filler regex previously matched bare "let's"
    // and "next step", blocking legitimate recommendations or summaries that
    // use those phrases.
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "Let's keep the current schema." }, resolved)
        .kind,
    ).toBe("action");
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "Next step is deployment approval." }, resolved)
        .kind,
    ).toBe("action");
    expect(
      classifyTurn(
        { toolCallCount: 0, outputText: "Let me know when the build is ready." },
        resolved,
      ).kind,
    ).toBe("action");
  });

  test("filler pattern wins over explicit-done — a plan-only reply cannot bypass the gate by appending a completion keyword", () => {
    // Regression: "Here is my plan. Plan completed." previously classified as
    // explicit-done because the last clause contains "completed" with no
    // negation and no forward-work. That let the model bypass the guardrail
    // by tacking on a done-phrase at the end of plan-only text. Now the
    // filler match runs FIRST, so any output with planning language blocks
    // even if it also contains a completion keyword.
    expect(
      classifyTurn({ toolCallCount: 0, outputText: "Here is my plan. Plan completed." }, resolved)
        .kind,
    ).toBe("filler");
    expect(
      classifyTurn(
        { toolCallCount: 0, outputText: "I will make the change. Analysis finished." },
        resolved,
      ).kind,
    ).toBe("filler");
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
