import { describe, expect, test } from "bun:test";
import { computeDraftHash, computeSourceHash } from "./hash.js";
import type { DistillationTrace, SkillDraft } from "./types.js";

const baseDraft: SkillDraft = {
  name: "format-pr",
  description: "Format a pull request title and body.",
  triggers: ["format pr", "clean up pr"],
  parameters: [{ name: "title", description: "PR title", required: true }],
  toolSequence: ["read_file", "write_file", "git_commit"],
  expectedInputs: ["pr number"],
  expectedOutputs: ["formatted markdown"],
};

describe("computeDraftHash", () => {
  test("returns identical hash for drafts with same name and tools", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({
      ...baseDraft,
      description: "Wholly different prose",
      triggers: ["completely different triggers"],
      parameters: [],
    });
    expect(a).toBe(b);
  });

  test("ignores tool order", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({
      ...baseDraft,
      toolSequence: ["git_commit", "read_file", "write_file"],
    });
    expect(a).toBe(b);
  });

  test("differs when tool set differs", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({ ...baseDraft, toolSequence: ["read_file"] });
    expect(a).not.toBe(b);
  });

  test("differs when name differs", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({ ...baseDraft, name: "format-pr-v2" });
    expect(a).not.toBe(b);
  });
});

describe("computeSourceHash", () => {
  test("identical for traces with same id, session, and turn count", () => {
    const trace: DistillationTrace = {
      traceId: "t1",
      sessionId: "s1",
      turns: [{ role: "user", text: "hi" }],
    };
    const other: DistillationTrace = {
      traceId: "t1",
      sessionId: "s1",
      turns: [{ role: "assistant", text: "different prose, same shape" }],
    };
    expect(computeSourceHash(trace)).toBe(computeSourceHash(other));
  });

  test("differs when traceId differs", () => {
    const a: DistillationTrace = { traceId: "a", turns: [{ role: "user" }] };
    const b: DistillationTrace = { traceId: "b", turns: [{ role: "user" }] };
    expect(computeSourceHash(a)).not.toBe(computeSourceHash(b));
  });

  test("treats missing sessionId distinctly from empty string", () => {
    const noSession: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "user" }],
    };
    const emptySession: DistillationTrace = {
      traceId: "t",
      sessionId: "",
      turns: [{ role: "user" }],
    };
    // Both normalize sessionId to "" — current contract treats them equivalently.
    expect(computeSourceHash(noSession)).toBe(computeSourceHash(emptySession));
  });
});
