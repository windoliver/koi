import { describe, expect, test } from "bun:test";
import type { DenialRecord, DenialSource } from "../denial-tracker.js";
import { createDenialTracker } from "../denial-tracker.js";

function makeDenial(
  toolId: string,
  turnIndex: number = 0,
  source: "policy" | "backend-error" | "approval" | "escalation" = "policy",
): DenialRecord {
  return {
    toolId,
    reason: `Tool "${toolId}" denied`,
    timestamp: 1000 + turnIndex,
    principal: "agent:test",
    turnIndex,
    source,
  };
}

describe("createDenialTracker", () => {
  test("starts empty", () => {
    const tracker = createDenialTracker();
    expect(tracker.count()).toBe(0);
    expect(tracker.getAll()).toEqual([]);
  });

  test("records and retrieves denials", () => {
    const tracker = createDenialTracker();
    tracker.record(makeDenial("bash", 0));
    tracker.record(makeDenial("rm", 1));

    expect(tracker.count()).toBe(2);
    expect(tracker.getAll()).toHaveLength(2);
    expect(tracker.getAll()[0]?.toolId).toBe("bash");
    expect(tracker.getAll()[1]?.toolId).toBe("rm");
  });

  test("filters by tool", () => {
    const tracker = createDenialTracker();
    tracker.record(makeDenial("bash", 0));
    tracker.record(makeDenial("rm", 1));
    tracker.record(makeDenial("bash", 2));

    const bashDenials = tracker.getByTool("bash");
    expect(bashDenials).toHaveLength(2);
    expect(bashDenials.every((r) => r.toolId === "bash")).toBe(true);

    expect(tracker.getByTool("rm")).toHaveLength(1);
    expect(tracker.getByTool("unknown")).toHaveLength(0);
  });

  test("clears all records", () => {
    const tracker = createDenialTracker();
    tracker.record(makeDenial("bash"));
    tracker.record(makeDenial("rm"));
    expect(tracker.count()).toBe(2);

    tracker.clear();
    expect(tracker.count()).toBe(0);
    expect(tracker.getAll()).toEqual([]);
  });

  test("evicts oldest when maxEntries reached", () => {
    const tracker = createDenialTracker(3);
    tracker.record(makeDenial("a", 0));
    tracker.record(makeDenial("b", 1));
    tracker.record(makeDenial("c", 2));
    expect(tracker.count()).toBe(3);

    tracker.record(makeDenial("d", 3));
    expect(tracker.count()).toBe(3);

    const all = tracker.getAll();
    expect(all[0]?.toolId).toBe("b");
    expect(all[2]?.toolId).toBe("d");
  });

  test("getAll returns a copy (not a reference)", () => {
    const tracker = createDenialTracker();
    tracker.record(makeDenial("bash"));

    const snapshot = tracker.getAll();
    tracker.record(makeDenial("rm"));

    expect(snapshot).toHaveLength(1);
    expect(tracker.getAll()).toHaveLength(2);
  });
});

describe("DenialRecord additive fields (#1650)", () => {
  test("record stores softness and origin if provided", () => {
    const t = createDenialTracker();
    t.record({
      toolId: "bash",
      reason: "nope",
      timestamp: 1,
      principal: "agent:a",
      turnIndex: 0,
      source: "policy",
      softness: "hard",
      origin: "soft-conversion",
    });
    const entries = t.getAll();
    expect(entries[0]?.softness).toBe("hard");
    expect(entries[0]?.origin).toBe("soft-conversion");
  });

  test("record without new fields works (backward compat)", () => {
    const t = createDenialTracker();
    t.record({
      toolId: "bash",
      reason: "nope",
      timestamp: 1,
      principal: "agent:a",
      turnIndex: 0,
      source: "policy",
    });
    const entries = t.getAll();
    expect(entries[0]?.softness).toBeUndefined();
    expect(entries[0]?.origin).toBeUndefined();
  });

  test("DenialSource exported union still has exactly 4 values (closed)", () => {
    // Exhaustive switch — will fail to compile if union expands.
    const check = (s: DenialSource): number => {
      switch (s) {
        case "policy":
          return 1;
        case "backend-error":
          return 2;
        case "approval":
          return 3;
        case "escalation":
          return 4;
      }
    };
    expect(check("policy")).toBe(1);
  });
});
