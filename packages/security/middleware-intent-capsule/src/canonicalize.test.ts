import { describe, expect, it } from "bun:test";
import { canonicalizeMandatePayload } from "./canonicalize.js";

describe("canonicalizeMandatePayload", () => {
  it("produces deterministic output for known inputs", () => {
    const result = canonicalizeMandatePayload({
      agentId: "agent-1",
      sessionId: "sess-42",
      systemPrompt: "You are a coding assistant.",
      objectives: ["answer questions", "write tests"],
    });
    expect(result).toBe(
      "v1\nagentId:agent-1\nsessionId:sess-42\nsystemPrompt:You are a coding assistant.\nobjectives:answer questions\nwrite tests",
    );
  });

  it("sorts objectives lexicographically before joining", () => {
    const a = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: ["write tests", "answer questions"],
    });
    const b = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: ["answer questions", "write tests"],
    });
    expect(a).toBe(b);
  });

  it("handles empty objectives", () => {
    const result = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: [],
    });
    expect(result).toBe("v1\nagentId:a\nsessionId:s\nsystemPrompt:p\nobjectives:");
  });

  it("different systemPrompt produces different payload", () => {
    const a = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "mission A",
      objectives: [],
    });
    const b = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "mission B",
      objectives: [],
    });
    expect(a).not.toBe(b);
  });

  it("different sessionId produces different payload", () => {
    const a = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s1",
      systemPrompt: "p",
      objectives: [],
    });
    const b = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s2",
      systemPrompt: "p",
      objectives: [],
    });
    expect(a).not.toBe(b);
  });
});
