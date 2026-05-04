import { describe, expect, test } from "bun:test";
import { agentId, type DecisionRecord, type HandoffEnvelope, handoffId } from "@koi/core";
import { generateHandoffSummary } from "./summary.js";

function makeEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    id: handoffId("hoff-test"),
    from: agentId("researcher"),
    to: agentId("writer"),
    status: "pending",
    createdAt: 0,
    phase: { completed: "analyzed papers", next: "write survey" },
    context: { results: {}, artifacts: [], decisions: [], warnings: [] },
    metadata: {},
    ...overrides,
  };
}

describe("generateHandoffSummary", () => {
  test("includes phase + sender", () => {
    const out = generateHandoffSummary(makeEnvelope());
    expect(out).toContain("agent `researcher`");
    expect(out).toContain("analyzed papers");
    expect(out).toContain("write survey");
    expect(out).toContain("hoff-test");
  });

  test("includes warnings when present", () => {
    const out = generateHandoffSummary(
      makeEnvelope({
        context: {
          results: {},
          artifacts: [],
          decisions: [],
          warnings: ["source X retracted"],
        },
      }),
    );
    expect(out).toContain("Warnings");
    expect(out).toContain("source X retracted");
  });

  test("counts artifacts and decisions", () => {
    const decision: DecisionRecord = {
      agentId: agentId("researcher"),
      action: "filter",
      reasoning: "low quality",
      timestamp: 0,
    };
    const out = generateHandoffSummary(
      makeEnvelope({
        context: {
          results: {},
          artifacts: [{ id: "a", kind: "data", uri: "file:///x" }],
          decisions: [decision],
          warnings: [],
        },
      }),
    );
    expect(out).toContain("1 artifact");
    expect(out).toContain("1 decision");
  });
});
