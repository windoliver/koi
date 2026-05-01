import { describe, expect, test } from "bun:test";
import { createAuditLog } from "./audit.js";
import type { DistillationRecord } from "./types.js";

const rec = (id: string): DistillationRecord => ({
  draft: {
    name: id,
    description: "d",
    triggers: [],
    parameters: [],
    toolSequence: [],
    expectedInputs: [],
    expectedOutputs: [],
  },
  source: { traceId: id, timestamp: 0, sourceHash: "src" },
  draftHash: id,
});

describe("createAuditLog", () => {
  test("preserves insertion order", () => {
    const log = createAuditLog();
    log.record(rec("a"));
    log.record(rec("b"));
    log.record(rec("c"));
    expect(log.list().map((r) => r.draft.name)).toEqual(["a", "b", "c"]);
  });

  test("list() returns a defensive copy", () => {
    const log = createAuditLog();
    log.record(rec("a"));
    const snapshot = log.list();
    log.record(rec("b"));
    expect(snapshot.length).toBe(1);
    expect(log.list().length).toBe(2);
  });

  test("clear() empties the log", () => {
    const log = createAuditLog();
    log.record(rec("a"));
    log.clear();
    expect(log.list()).toEqual([]);
  });
});
