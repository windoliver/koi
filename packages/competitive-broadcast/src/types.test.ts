import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core/ecs";
import { isProposal, proposalId } from "./types.js";

describe("proposalId", () => {
  test("creates a branded ProposalId from a string", () => {
    const id = proposalId("p-1");
    expect(id).toBe(proposalId("p-1"));
    // branded type is compile-time only — runtime value is the string
    expect(typeof id).toBe("string");
    expect(id as string).toBe("p-1");
  });

  test("preserves distinct values", () => {
    const a = proposalId("a");
    const b = proposalId("b");
    expect(a).not.toBe(b);
  });
});

describe("isProposal", () => {
  const validProposal = {
    id: proposalId("p-1"),
    agentId: agentId("agent-1"),
    output: "result text",
    durationMs: 100,
    submittedAt: Date.now(),
  };

  test("returns true for a valid proposal", () => {
    expect(isProposal(validProposal)).toBe(true);
  });

  test("returns true for a proposal with optional fields", () => {
    const withOptional = {
      ...validProposal,
      salience: 0.8,
      metadata: { source: "test" },
    };
    expect(isProposal(withOptional)).toBe(true);
  });

  test("returns false for null", () => {
    expect(isProposal(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isProposal(undefined)).toBe(false);
  });

  test("returns false for a non-object", () => {
    expect(isProposal("string")).toBe(false);
    expect(isProposal(42)).toBe(false);
    expect(isProposal(true)).toBe(false);
  });

  test("returns false when id is missing", () => {
    const { id: _, ...rest } = validProposal;
    expect(isProposal(rest)).toBe(false);
  });

  test("returns false when agentId is missing", () => {
    const { agentId: _, ...rest } = validProposal;
    expect(isProposal(rest)).toBe(false);
  });

  test("returns false when output is missing", () => {
    const { output: _, ...rest } = validProposal;
    expect(isProposal(rest)).toBe(false);
  });

  test("returns false when durationMs is missing", () => {
    const { durationMs: _, ...rest } = validProposal;
    expect(isProposal(rest)).toBe(false);
  });

  test("returns false when submittedAt is missing", () => {
    const { submittedAt: _, ...rest } = validProposal;
    expect(isProposal(rest)).toBe(false);
  });

  test("returns false when id is not a string", () => {
    expect(isProposal({ ...validProposal, id: 123 })).toBe(false);
  });

  test("returns false for an empty object", () => {
    expect(isProposal({})).toBe(false);
  });
});
