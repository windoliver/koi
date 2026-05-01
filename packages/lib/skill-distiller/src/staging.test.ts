import { describe, expect, test } from "bun:test";
import { createStagingQueue } from "./staging.js";
import type { DistillationRecord } from "./types.js";

const rec = (id: string): DistillationRecord => ({
  draft: {
    name: id,
    description: id,
    triggers: [],
    parameters: [],
    toolSequence: [],
    expectedInputs: [],
    expectedOutputs: [],
  },
  source: { traceId: id, timestamp: 0, sourceHash: `src-${id}` },
  draftHash: id,
});

describe("createStagingQueue", () => {
  test("stage returns pending entry with id == draftHash", () => {
    const q = createStagingQueue({ now: () => 1000 });
    const e = q.stage(rec("h1"));
    expect(e.id).toBe("h1");
    expect(e.status).toBe("pending");
    expect(e.stagedAt).toBe(1000);
  });

  test("stage is idempotent — repeated stage returns the existing entry", () => {
    const q = createStagingQueue();
    const a = q.stage(rec("h1"));
    q.approve("h1");
    const b = q.stage(rec("h1"));
    expect(b.status).toBe("approved");
    expect(a.id).toBe(b.id);
  });

  test("approve transitions pending → approved with timestamp and note", () => {
    let t = 1000;
    const q = createStagingQueue({ now: () => t });
    q.stage(rec("h1"));
    t = 2000;
    const e = q.approve("h1", "looks good");
    expect(e?.status).toBe("approved");
    expect(e?.resolvedAt).toBe(2000);
    expect(e?.note).toBe("looks good");
  });

  test("reject transitions pending → rejected with note", () => {
    const q = createStagingQueue();
    q.stage(rec("h1"));
    const e = q.reject("h1", "not useful");
    expect(e?.status).toBe("rejected");
    expect(e?.note).toBe("not useful");
  });

  test("approve / reject return undefined for unknown id", () => {
    const q = createStagingQueue();
    expect(q.approve("none")).toBeUndefined();
    expect(q.reject("none")).toBeUndefined();
  });

  test("approve / reject return undefined when entry is already resolved", () => {
    const q = createStagingQueue();
    q.stage(rec("h1"));
    q.approve("h1");
    expect(q.approve("h1")).toBeUndefined();
    expect(q.reject("h1")).toBeUndefined();
  });

  test("listPending excludes resolved entries", () => {
    const q = createStagingQueue();
    q.stage(rec("h1"));
    q.stage(rec("h2"));
    q.stage(rec("h3"));
    q.approve("h1");
    q.reject("h2");
    expect(q.listPending().map((e) => e.id)).toEqual(["h3"]);
    expect(q.listAll().length).toBe(3);
  });

  test("clear empties the queue", () => {
    const q = createStagingQueue();
    q.stage(rec("h1"));
    q.clear();
    expect(q.get("h1")).toBeUndefined();
    expect(q.listAll()).toEqual([]);
  });
});
