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
    // Direct caller-held reference must not be writable after recording.
    expect(() => {
      (entry as { draftHash: string }).draftHash = "tampered";
    }).toThrow();
    // Same for nested objects (source, draft).
    expect(() => {
      (entry.source as { traceId: string }).traceId = "tampered";
    }).toThrow();
    // List returns frozen entries too.
    const listed = log.list()[0];
    expect(listed && Object.isFrozen(listed)).toBe(true);
  });
});
