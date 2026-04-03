import { describe, expect, it } from "bun:test";
import type { ActionEntry } from "@koi/core";

import { createAccumulator } from "./accumulator.js";

function makeAction(name: string, turn = 0): ActionEntry {
  return {
    kind: "tool_call",
    name,
    turnIndex: turn,
    durationMs: 10,
    success: true,
  };
}

describe("createAccumulator", () => {
  it("records actions and returns them in snapshot", () => {
    const acc = createAccumulator(10);
    acc.recordAction(makeAction("a"));
    acc.recordAction(makeAction("b"));
    const snap = acc.snapshot();
    expect(snap.actions).toHaveLength(2);
    expect(snap.totalActions).toBe(2);
    expect(snap.truncated).toBe(false);
  });

  it("truncates when exceeding maxActions", () => {
    const acc = createAccumulator(3);
    acc.recordAction(makeAction("a"));
    acc.recordAction(makeAction("b"));
    acc.recordAction(makeAction("c"));
    acc.recordAction(makeAction("d"));
    acc.recordAction(makeAction("e"));

    const snap = acc.snapshot();
    expect(snap.actions).toHaveLength(3);
    expect(snap.totalActions).toBe(5);
    expect(snap.truncated).toBe(true);
    // Should contain the 3 most recent
    expect(snap.actions.map((a) => a.name)).toEqual(["c", "d", "e"]);
  });

  it("accumulates tokens", () => {
    const acc = createAccumulator(10);
    acc.addTokens(100, 50);
    acc.addTokens(200, 100);
    const snap = acc.snapshot();
    expect(snap.inputTokens).toBe(300);
    expect(snap.outputTokens).toBe(150);
  });

  it("records issues", () => {
    const acc = createAccumulator(10);
    acc.recordIssue({
      severity: "warning",
      message: "test issue",
      turnIndex: 0,
      resolved: false,
    });
    const snap = acc.snapshot();
    expect(snap.issues).toHaveLength(1);
    expect(snap.issues[0]?.message).toBe("test issue");
  });

  it("records artifacts", () => {
    const acc = createAccumulator(10);
    acc.recordArtifact({ id: "a1", kind: "file", uri: "file://output.txt" });
    const snap = acc.snapshot();
    expect(snap.artifacts).toHaveLength(1);
  });

  it("returns defensive copies in snapshot", () => {
    const acc = createAccumulator(10);
    acc.recordAction(makeAction("a"));
    const snap1 = acc.snapshot();
    acc.recordAction(makeAction("b"));
    const snap2 = acc.snapshot();
    expect(snap1.actions).toHaveLength(1);
    expect(snap2.actions).toHaveLength(2);
  });

  it("handles exact capacity without truncation", () => {
    const acc = createAccumulator(3);
    acc.recordAction(makeAction("a"));
    acc.recordAction(makeAction("b"));
    acc.recordAction(makeAction("c"));
    const snap = acc.snapshot();
    expect(snap.actions).toHaveLength(3);
    expect(snap.truncated).toBe(false);
    expect(snap.totalActions).toBe(3);
  });

  it("bounds issues with ring buffer", () => {
    const acc = createAccumulator(3);
    for (let i = 0; i < 5; i++) {
      acc.recordIssue({
        severity: "warning",
        message: `issue-${String(i)}`,
        turnIndex: i,
        resolved: false,
      });
    }
    const snap = acc.snapshot();
    expect(snap.issues).toHaveLength(3);
    expect(snap.totalIssues).toBe(5);
    // Should retain the 3 most recent
    expect(snap.issues.map((i) => i.message)).toEqual(["issue-2", "issue-3", "issue-4"]);
  });

  it("caps artifacts at maximum", () => {
    const acc = createAccumulator(10);
    for (let i = 0; i < 150; i++) {
      acc.recordArtifact({ id: `a${String(i)}`, kind: "file", uri: `file://${String(i)}` });
    }
    const snap = acc.snapshot();
    expect(snap.artifacts).toHaveLength(100);
  });
});
