import { beforeEach, describe, expect, test } from "bun:test";
import type { ActionEntry, ArtifactRef, IssueEntry } from "@koi/core";
import type { Accumulator } from "./accumulator.js";
import { createAccumulator } from "./accumulator.js";

function makeAction(overrides: Partial<ActionEntry> = {}): ActionEntry {
  return {
    kind: "tool_call",
    name: "file_write",
    turnIndex: 0,
    durationMs: 100,
    success: true,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    id: "artifact-1",
    kind: "file",
    uri: "file:///workspace/output.json",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    severity: "warning",
    message: "Rate limit approaching",
    turnIndex: 1,
    resolved: false,
    ...overrides,
  };
}

describe("createAccumulator", () => {
  let acc: Accumulator;

  beforeEach(() => {
    acc = createAccumulator(500);
  });

  test("records model call action entry", () => {
    const action = makeAction({ kind: "model_call", name: "gpt-4" });
    acc.recordAction(action);
    const snap = acc.snapshot();
    expect(snap.actions).toHaveLength(1);
    expect(snap.actions[0]).toEqual(action);
    expect(snap.totalActions).toBe(1);
  });

  test("records tool call action entry", () => {
    const action = makeAction({ kind: "tool_call", name: "file_write" });
    acc.recordAction(action);
    const snap = acc.snapshot();
    expect(snap.actions).toHaveLength(1);
    expect(snap.actions[0]?.kind).toBe("tool_call");
  });

  test("accumulates token usage across calls", () => {
    acc.addTokens(100, 50);
    acc.addTokens(200, 75);
    const snap = acc.snapshot();
    expect(snap.inputTokens).toBe(300);
    expect(snap.outputTokens).toBe(125);
  });

  test("records artifacts", () => {
    const a1 = makeArtifact({ id: "a1" });
    const a2 = makeArtifact({ id: "a2", kind: "data" });
    acc.recordArtifact(a1);
    acc.recordArtifact(a2);
    const snap = acc.snapshot();
    expect(snap.artifacts).toHaveLength(2);
    expect(snap.artifacts[0]?.id).toBe("a1");
    expect(snap.artifacts[1]?.kind).toBe("data");
  });

  test("records issues with severity and resolution", () => {
    const issue = makeIssue({
      severity: "critical",
      resolved: true,
      resolution: "Increased rate limit",
    });
    acc.recordIssue(issue);
    const snap = acc.snapshot();
    expect(snap.issues).toHaveLength(1);
    expect(snap.issues[0]).toEqual(issue);
  });

  test("enforces maxActions bound with FIFO truncation", () => {
    const small = createAccumulator(3);
    for (let i = 0; i < 5; i++) {
      small.recordAction(makeAction({ name: `action-${i}` }));
    }
    const snap = small.snapshot();
    expect(snap.actions).toHaveLength(3);
    expect(snap.actions[0]?.name).toBe("action-2");
    expect(snap.actions[1]?.name).toBe("action-3");
    expect(snap.actions[2]?.name).toBe("action-4");
  });

  test("sets truncated flag on first truncation", () => {
    const small = createAccumulator(2);
    small.recordAction(makeAction({ name: "a" }));
    small.recordAction(makeAction({ name: "b" }));
    expect(small.snapshot().truncated).toBe(false);

    small.recordAction(makeAction({ name: "c" }));
    expect(small.snapshot().truncated).toBe(true);
  });

  test("tracks totalActions even after truncation", () => {
    const small = createAccumulator(2);
    for (let i = 0; i < 10; i++) {
      small.recordAction(makeAction({ name: `a-${i}` }));
    }
    const snap = small.snapshot();
    expect(snap.actions).toHaveLength(2);
    expect(snap.totalActions).toBe(10);
  });

  test("resets all state", () => {
    acc.recordAction(makeAction());
    acc.recordArtifact(makeArtifact());
    acc.recordIssue(makeIssue());
    acc.addTokens(100, 50);
    acc.reset();

    const snap = acc.snapshot();
    expect(snap.actions).toHaveLength(0);
    expect(snap.artifacts).toHaveLength(0);
    expect(snap.issues).toHaveLength(0);
    expect(snap.inputTokens).toBe(0);
    expect(snap.outputTokens).toBe(0);
    expect(snap.totalActions).toBe(0);
    expect(snap.truncated).toBe(false);
  });

  test("snapshot returns immutable copy", () => {
    acc.recordAction(makeAction({ name: "first" }));
    const snap1 = acc.snapshot();

    acc.recordAction(makeAction({ name: "second" }));
    const snap2 = acc.snapshot();

    expect(snap1.actions).toHaveLength(1);
    expect(snap2.actions).toHaveLength(2);
  });
});
