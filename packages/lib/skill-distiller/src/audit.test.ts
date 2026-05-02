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

  test("recorded entries are deep-frozen — caller cannot mutate provenance retroactively", () => {
    const log = createAuditLog();
    const entry = rec("a");
    log.record(entry);
    // Caller mutates their own reference AFTER recording — audit copy must
    // not change, since it was cloned at record time.
    (entry as { draftHash: string }).draftHash = "tampered";
    (entry.source as { traceId: string }).traceId = "tampered";
    const listed = log.list()[0];
    expect(listed?.draftHash).toBe("a");
    expect(listed?.source.traceId).toBe("a");
    // The stored copy itself is frozen — direct mutation through the listed
    // reference must throw.
    expect(() => {
      if (listed !== undefined) (listed as { draftHash: string }).draftHash = "tampered";
    }).toThrow();
    expect(listed && Object.isFrozen(listed)).toBe(true);
  });
});
