import { describe, expect, test } from "bun:test";
import type { DenialRecord } from "../denial-tracker.js";
import { createDenialTracker } from "../denial-tracker.js";

function makeDenial(toolId: string, turnIndex: number = 0): DenialRecord {
  return {
    toolId,
    reason: `Tool "${toolId}" denied`,
    timestamp: 1000 + turnIndex,
    principal: "agent:test",
    turnIndex,
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
