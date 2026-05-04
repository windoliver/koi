import { describe, expect, test } from "bun:test";
import { validateAcceptInput, validateArtifactRefs, validatePrepareInput } from "./validate.js";

describe("validatePrepareInput", () => {
  test("rejects missing completed", () => {
    const r = validatePrepareInput({ to: "x", next: "do y" });
    expect(r.ok).toBe(false);
  });

  test("rejects providing both to and capability", () => {
    const r = validatePrepareInput({
      to: "x",
      capability: "deploy",
      completed: "a",
      next: "b",
    });
    expect(r.ok).toBe(false);
  });

  test("rejects providing neither to nor capability", () => {
    const r = validatePrepareInput({ completed: "a", next: "b" });
    expect(r.ok).toBe(false);
  });

  test("accepts valid direct target input", () => {
    const r = validatePrepareInput({
      to: "agent-b",
      completed: "phase 1",
      next: "phase 2",
      results: { score: 1 },
      warnings: ["watch out"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.to).toBe("agent-b");
      expect(r.value.results).toEqual({ score: 1 });
    }
  });

  test("accepts capability-based input", () => {
    const r = validatePrepareInput({
      capability: "deploy",
      completed: "a",
      next: "b",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.capability).toBe("deploy");
  });
});

describe("validateAcceptInput", () => {
  test("requires handoff_id", () => {
    expect(validateAcceptInput({}).ok).toBe(false);
  });
  test("returns the id", () => {
    const r = validateAcceptInput({ handoff_id: "abc" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.handoffId).toBe("abc");
  });
});

describe("validateArtifactRefs", () => {
  test("warns on unsupported scheme", () => {
    const warnings = validateArtifactRefs([
      { id: "a", kind: "data", uri: "https://example.com/x" },
    ]);
    expect(warnings.length).toBe(1);
  });

  test("accepts file:// without warning", () => {
    const warnings = validateArtifactRefs([{ id: "a", kind: "data", uri: "file:///tmp/x.json" }]);
    expect(warnings.length).toBe(0);
  });

  test("warns on empty uri", () => {
    const warnings = validateArtifactRefs([{ id: "a", kind: "data", uri: "" }]);
    expect(warnings.length).toBe(1);
  });
});
