import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createQuarantineJournal } from "../native-host/quarantine-journal.js";

describe("quarantine-journal", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "koi-quar-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("write + read entry", async () => {
    const j = await createQuarantineJournal({
      dir,
      instanceId: "i1",
      browserSessionId: "b1",
    });
    await j.addEntry({
      tabId: 42,
      sessionId: "s1",
      reason: "chrome_error",
      writerEpoch: 1,
      writerSeq: 1,
    });
    const entries = await j.readEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.tabId).toBe(42);
  });

  test("two concurrent writers with different (epoch, seq) preserve both", async () => {
    const j1 = await createQuarantineJournal({
      dir,
      instanceId: "i1",
      browserSessionId: "b1",
    });
    await j1.addEntry({
      tabId: 42,
      sessionId: "s1",
      reason: "timeout",
      writerEpoch: 1,
      writerSeq: 1,
    });
    await j1.addEntry({
      tabId: 43,
      sessionId: "s2",
      reason: "chrome_error",
      writerEpoch: 2,
      writerSeq: 5,
    });
    const entries = await j1.readEntries();
    expect(entries.length).toBe(2);
  });

  test("different browserSessionId → wipe", async () => {
    const j1 = await createQuarantineJournal({
      dir,
      instanceId: "i1",
      browserSessionId: "b1",
    });
    await j1.addEntry({
      tabId: 42,
      sessionId: "s1",
      reason: "x",
      writerEpoch: 1,
      writerSeq: 1,
    });
    const j2 = await createQuarantineJournal({
      dir,
      instanceId: "i1",
      browserSessionId: "b2",
    });
    const entries = await j2.readEntries();
    expect(entries).toEqual([]);
  });

  test("removeEntry only removes matching (tabId, writerEpoch, writerSeq)", async () => {
    const j = await createQuarantineJournal({
      dir,
      instanceId: "i1",
      browserSessionId: "b1",
    });
    await j.addEntry({
      tabId: 42,
      sessionId: "s1",
      reason: "x",
      writerEpoch: 1,
      writerSeq: 1,
    });
    await j.addEntry({
      tabId: 43,
      sessionId: "s2",
      reason: "y",
      writerEpoch: 2,
      writerSeq: 3,
    });
    await j.removeEntry({ tabId: 42, writerEpoch: 1, writerSeq: 1 });
    const remaining = await j.readEntries();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.tabId).toBe(43);
  });
});
