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

describe("computeDraftHash — stability (description is wording, not behavior)", () => {
  test("ignores description wording", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({ ...baseDraft, description: "Wholly different prose." });
    expect(a).toBe(b);
  });

  test("ignores parameter description prose (description is not contract)", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({
      ...baseDraft,
      parameters: [{ name: "title", description: "wholly different prose", required: true }],
    });
    expect(a).toBe(b);
  });

  test("trigger order does not matter", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({ ...baseDraft, triggers: ["clean up pr", "format pr"] });
    expect(a).toBe(b);
  });
});

describe("computeDraftHash — sensitivity (behavior changes must change identity)", () => {
  test("differs when tool order differs", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({
      ...baseDraft,
      toolSequence: ["git_commit", "read_file", "write_file"],
    });
    expect(a).not.toBe(b);
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

  test("differs when triggers differ", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({ ...baseDraft, triggers: ["a wholly new entry phrase"] });
    expect(a).not.toBe(b);
  });

  test("differs when parameter names differ", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({
      ...baseDraft,
      parameters: [{ name: "renamed", description: "PR title", required: true }],
    });
    expect(a).not.toBe(b);
  });

  test("differs when parameter required flag flips (contract change)", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({
      ...baseDraft,
      parameters: [{ name: "title", description: "PR title", required: false }],
    });
    expect(a).not.toBe(b);
  });

  test("differs when expectedInputs differ", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({ ...baseDraft, expectedInputs: ["different contract"] });
    expect(a).not.toBe(b);
  });

  test("differs when expectedOutputs differ", () => {
    const a = computeDraftHash(baseDraft);
    const b = computeDraftHash({ ...baseDraft, expectedOutputs: ["different contract"] });
    expect(a).not.toBe(b);
  });
});

describe("computeSourceHash — content provenance", () => {
  test("identical for byte-identical traces", () => {
    const turns = [{ role: "user" as const, text: "hi" }];
    const a: DistillationTrace = { traceId: "t1", sessionId: "s1", turns };
    const b: DistillationTrace = { traceId: "t1", sessionId: "s1", turns: [...turns] };
    expect(computeSourceHash(a)).toBe(computeSourceHash(b));
  });

  test("differs when turn text differs (same IDs, same shape)", () => {
    const a: DistillationTrace = {
      traceId: "t1",
      sessionId: "s1",
      turns: [{ role: "user", text: "first" }],
    };
    const b: DistillationTrace = {
      traceId: "t1",
      sessionId: "s1",
      turns: [{ role: "user", text: "second" }],
    };
    expect(computeSourceHash(a)).not.toBe(computeSourceHash(b));
  });

  test("differs when tool call args differ (redaction / mutation detection)", () => {
    const a: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "assistant", toolCalls: [{ name: "read_file", argsJson: '{"path":"a"}' }] }],
    };
    const b: DistillationTrace = {
      traceId: "t",
      turns: [{ role: "assistant", toolCalls: [{ name: "read_file", argsJson: '{"path":"b"}' }] }],
    };
    expect(computeSourceHash(a)).not.toBe(computeSourceHash(b));
  });

  test("differs when traceId differs", () => {
    const a: DistillationTrace = { traceId: "a", turns: [{ role: "user" }] };
    const b: DistillationTrace = { traceId: "b", turns: [{ role: "user" }] };
    expect(computeSourceHash(a)).not.toBe(computeSourceHash(b));
  });

  test("treats missing sessionId equivalent to empty string (both normalize to '')", () => {
    const noSession: DistillationTrace = { traceId: "t", turns: [{ role: "user" }] };
    const emptySession: DistillationTrace = {
      traceId: "t",
      sessionId: "",
      turns: [{ role: "user" }],
    };
    expect(computeSourceHash(noSession)).toBe(computeSourceHash(emptySession));
  });
});
