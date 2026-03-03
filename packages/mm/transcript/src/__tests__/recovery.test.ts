/**
 * Integration test — multi-lifecycle recovery using the JSONL backend.
 *
 * Simulates process crashes by creating/closing/re-opening the store
 * with the same baseDir, verifying entries survive across restarts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { makeTranscriptEntry } from "@koi/test-utils";
import { createJsonlTranscript } from "../jsonl-store.js";

describe("JSONL recovery integration", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  test("entries survive across store lifecycle (create → close → re-open)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "koi-recovery-"));
    tmpDirs.push(dir);
    const sid = sessionId("recovery-test");

    // --- Run #1: append 3 entries ---
    const store1 = createJsonlTranscript({ baseDir: dir });
    const e1 = makeTranscriptEntry({ content: "turn-1", timestamp: 1000 });
    const e2 = makeTranscriptEntry({ content: "turn-2", timestamp: 2000 });
    const e3 = makeTranscriptEntry({ content: "turn-3", timestamp: 3000 });
    await store1.append(sid, [e1, e2, e3]);
    await store1.close();

    // --- Restart: re-open with same baseDir ---
    const store2 = createJsonlTranscript({ baseDir: dir });
    const loadResult1 = await store2.load(sid);
    expect(loadResult1.ok).toBe(true);
    if (loadResult1.ok) {
      expect(loadResult1.value.entries.length).toBe(3);
      expect(loadResult1.value.entries[0]?.content).toBe("turn-1");
      expect(loadResult1.value.entries[1]?.content).toBe("turn-2");
      expect(loadResult1.value.entries[2]?.content).toBe("turn-3");
    }

    // --- Run #2: append 2 more entries ---
    const e4 = makeTranscriptEntry({ content: "turn-4", timestamp: 4000 });
    const e5 = makeTranscriptEntry({ content: "turn-5", timestamp: 5000 });
    await store2.append(sid, [e4, e5]);
    await store2.close();

    // --- Restart: verify all 5 entries ---
    const store3 = createJsonlTranscript({ baseDir: dir });
    const loadResult2 = await store3.load(sid);
    expect(loadResult2.ok).toBe(true);
    if (loadResult2.ok) {
      expect(loadResult2.value.entries.length).toBe(5);
      expect(loadResult2.value.entries[0]?.content).toBe("turn-1");
      expect(loadResult2.value.entries[4]?.content).toBe("turn-5");
    }

    // --- Compact: keep last 2 ---
    const compactResult = await store3.compact(sid, "Summary of turns 1-3", 2);
    expect(compactResult.ok).toBe(true);
    await store3.close();

    // --- Restart: verify compaction ---
    const store4 = createJsonlTranscript({ baseDir: dir });
    const loadResult3 = await store4.load(sid);
    expect(loadResult3.ok).toBe(true);
    if (loadResult3.ok) {
      expect(loadResult3.value.entries.length).toBe(3);
      expect(loadResult3.value.entries[0]?.role).toBe("compaction");
      expect(loadResult3.value.entries[0]?.content).toBe("Summary of turns 1-3");
      expect(loadResult3.value.entries[1]?.content).toBe("turn-4");
      expect(loadResult3.value.entries[2]?.content).toBe("turn-5");
    }
    await store4.close();
  });
});
