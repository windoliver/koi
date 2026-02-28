import { describe, expect, it } from "bun:test";
import { canonicalizeMandatePayload } from "./canonicalize.js";

describe("canonicalizeMandatePayload", () => {
  it("is deterministic — same inputs produce same output", () => {
    const fields = {
      agentId: "agent-abc",
      sessionId: "session-xyz",
      systemPrompt: "You are a helpful assistant.",
      objectives: ["Answer questions", "Be concise"],
    };
    expect(canonicalizeMandatePayload(fields)).toBe(canonicalizeMandatePayload(fields));
  });

  it("starts with version prefix v1", () => {
    const result = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: [],
    });
    expect(result.startsWith("v1\n")).toBe(true);
  });

  it("includes agentId and sessionId for replay-attack prevention", () => {
    const base = {
      agentId: "agent-1",
      sessionId: "session-1",
      systemPrompt: "same prompt",
      objectives: [],
    };
    const differentAgent = { ...base, agentId: "agent-2" };
    const differentSession = { ...base, sessionId: "session-2" };

    expect(canonicalizeMandatePayload(base)).not.toBe(canonicalizeMandatePayload(differentAgent));
    expect(canonicalizeMandatePayload(base)).not.toBe(canonicalizeMandatePayload(differentSession));
  });

  it("sorts objectives before hashing — order does not matter", () => {
    const a = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: ["B", "A", "C"],
    });
    const b = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: ["A", "B", "C"],
    });
    expect(a).toBe(b);
  });

  it("different objectives produce different canonical strings", () => {
    const base = { agentId: "a", sessionId: "s", systemPrompt: "p", objectives: ["goal-1"] };
    const other = { ...base, objectives: ["goal-2"] };
    expect(canonicalizeMandatePayload(base)).not.toBe(canonicalizeMandatePayload(other));
  });

  it("handles empty objectives", () => {
    const result = canonicalizeMandatePayload({
      agentId: "a",
      sessionId: "s",
      systemPrompt: "p",
      objectives: [],
    });
    expect(result).toContain("objectives:");
  });

  it("different system prompts produce different canonical strings", () => {
    const base = { agentId: "a", sessionId: "s", systemPrompt: "prompt-A", objectives: [] };
    const other = { ...base, systemPrompt: "prompt-B" };
    expect(canonicalizeMandatePayload(base)).not.toBe(canonicalizeMandatePayload(other));
  });
});
