/**
 * Reusable contract test suite for any SessionTranscript implementation.
 *
 * Usage:
 *   runSessionTranscriptContractTests(() => createInMemoryTranscript());
 *   runSessionTranscriptContractTests(() => createJsonlTranscript({ baseDir: tmpDir }));
 *
 * Both implementations run the same suite — prevents silent divergence.
 */

import { describe, expect, test } from "bun:test";
import type { SessionTranscript, TranscriptEntry } from "@koi/core";
import { sessionId, transcriptEntryId } from "@koi/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeTranscriptEntry(overrides?: Partial<TranscriptEntry>): TranscriptEntry {
  const uid = `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: transcriptEntryId(uid),
    role: "user",
    content: `test message ${uid}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

export function runSessionTranscriptContractTests(createStore: () => SessionTranscript): void {
  // -----------------------------------------------------------------------
  // Append and load
  // -----------------------------------------------------------------------
  describe("append and load", () => {
    test("round-trip: append then load returns entries", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      const entry = makeTranscriptEntry({ role: "user", content: "hello" });
      expect((await store.append(sid, [entry])).ok).toBe(true);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(1);
        expect(result.value.entries[0]?.id).toBe(entry.id);
        expect(result.value.entries[0]?.content).toBe("hello");
        expect(result.value.skipped.length).toBe(0);
      }
    });

    test("preserves entry ordering across multiple appends", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      const e1 = makeTranscriptEntry({ content: "first", timestamp: 1000 });
      const e2 = makeTranscriptEntry({ content: "second", timestamp: 2000 });
      const e3 = makeTranscriptEntry({ content: "third", timestamp: 3000 });

      await store.append(sid, [e1]);
      await store.append(sid, [e2, e3]);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.map((e) => e.content)).toEqual(["first", "second", "third"]);
      }
    });

    test("multiple sessions are independent", async () => {
      const store = createStore();
      await store.append(sessionId("s1"), [makeTranscriptEntry({ content: "s1-msg" })]);
      await store.append(sessionId("s2"), [makeTranscriptEntry({ content: "s2-msg" })]);

      const r1 = await store.load(sessionId("s1"));
      const r2 = await store.load(sessionId("s2"));
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.entries[0]?.content).toBe("s1-msg");
        expect(r2.value.entries[0]?.content).toBe("s2-msg");
      }
    });

    test("load on non-existent session returns empty", async () => {
      const store = createStore();
      const result = await store.load(sessionId("nonexistent"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(0);
        expect(result.value.skipped.length).toBe(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Pagination
  // -----------------------------------------------------------------------
  describe("pagination", () => {
    test("loadPage with offset and limit", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeTranscriptEntry({ content: `msg-${i}`, timestamp: 1000 * (i + 1) }),
      );
      await store.append(sid, entries);

      const result = await store.loadPage(sid, { offset: 1, limit: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(2);
        expect(result.value.entries[0]?.content).toBe("msg-1");
        expect(result.value.entries[1]?.content).toBe("msg-2");
        expect(result.value.total).toBe(5);
        expect(result.value.hasMore).toBe(true);
      }
    });

    test("loadPage last page has hasMore=false", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      await store.append(
        sid,
        Array.from({ length: 3 }, () => makeTranscriptEntry()),
      );

      const result = await store.loadPage(sid, { offset: 2, limit: 5 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(1);
        expect(result.value.total).toBe(3);
        expect(result.value.hasMore).toBe(false);
      }
    });

    test("loadPage with no offset defaults to 0", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      const entries = Array.from({ length: 3 }, (_, i) =>
        makeTranscriptEntry({ content: `msg-${i}` }),
      );
      await store.append(sid, entries);

      const result = await store.loadPage(sid, { limit: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(2);
        expect(result.value.entries[0]?.content).toBe("msg-0");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Compaction
  // -----------------------------------------------------------------------
  describe("compaction", () => {
    test("compact preserves last N entries with summary prepended", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      await store.append(
        sid,
        Array.from({ length: 5 }, (_, i) =>
          makeTranscriptEntry({ content: `msg-${i}`, timestamp: 1000 * (i + 1) }),
        ),
      );
      expect((await store.compact(sid, "Summary of first 3 messages", 2)).ok).toBe(true);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(3);
        expect(result.value.entries[0]?.role).toBe("compaction");
        expect(result.value.entries[0]?.content).toBe("Summary of first 3 messages");
        expect(result.value.entries[1]?.content).toBe("msg-3");
        expect(result.value.entries[2]?.content).toBe("msg-4");
      }
    });

    test("compact with preserveLastN=0 keeps only the compaction entry", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      await store.append(
        sid,
        Array.from({ length: 5 }, () => makeTranscriptEntry()),
      );
      await store.compact(sid, "Full summary", 0);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(1);
        expect(result.value.entries[0]?.role).toBe("compaction");
        expect(result.value.entries[0]?.content).toBe("Full summary");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Truncate
  // -----------------------------------------------------------------------
  describe("truncate", () => {
    test("truncate keeps the first N entries and drops the rest", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeTranscriptEntry({ content: `msg-${i}`, timestamp: 1000 * (i + 1) }),
      );
      await store.append(sid, entries);

      const r = await store.truncate(sid, 3);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.kept).toBe(3);
        expect(r.value.dropped).toBe(2);
      }

      const loaded = await store.load(sid);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.entries.map((e) => e.content)).toEqual(["msg-0", "msg-1", "msg-2"]);
      }
    });

    test("truncate to 0 removes the transcript entirely", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      await store.append(sid, [makeTranscriptEntry(), makeTranscriptEntry()]);

      const r = await store.truncate(sid, 0);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.kept).toBe(0);
        expect(r.value.dropped).toBe(2);
      }

      const loaded = await store.load(sid);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.entries.length).toBe(0);
      }
    });

    test("truncate beyond length is a no-op (kept = existing length)", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      await store.append(sid, [makeTranscriptEntry(), makeTranscriptEntry()]);

      const r = await store.truncate(sid, 100);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.kept).toBe(2);
        expect(r.value.dropped).toBe(0);
      }
    });

    test("truncate is idempotent — running it twice converges", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      await store.append(
        sid,
        Array.from({ length: 5 }, (_, i) => makeTranscriptEntry({ content: `m${i}` })),
      );

      const r1 = await store.truncate(sid, 2);
      const r2 = await store.truncate(sid, 2);
      expect(r1.ok && r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.kept).toBe(2);
        expect(r1.value.dropped).toBe(3);
        expect(r2.value.kept).toBe(2);
        expect(r2.value.dropped).toBe(0);
      }
    });

    test("truncate on a non-existent session returns kept=0 dropped=0", async () => {
      const store = createStore();
      const r = await store.truncate(sessionId("never-existed"), 5);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.kept).toBe(0);
        expect(r.value.dropped).toBe(0);
      }
    });

    test("truncate rejects negative keepFirstN", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      await store.append(sid, [makeTranscriptEntry()]);

      const r = await store.truncate(sid, -1);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("VALIDATION");
      }
    });

    test("truncate rejects empty sessionId", async () => {
      const store = createStore();
      const r = await store.truncate(sessionId(""), 0);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("VALIDATION");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Remove
  // -----------------------------------------------------------------------
  describe("remove", () => {
    test("removes session transcript", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      await store.append(sid, [makeTranscriptEntry()]);
      expect((await store.remove(sid)).ok).toBe(true);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(0);
      }
    });

    test("remove non-existent session is a no-op success", async () => {
      const store = createStore();
      expect((await store.remove(sessionId("nonexistent"))).ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  describe("validation", () => {
    test("append rejects empty sessionId", async () => {
      const store = createStore();
      const result = await store.append(sessionId(""), [makeTranscriptEntry()]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("load rejects empty sessionId", async () => {
      const store = createStore();
      const result = await store.load(sessionId(""));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("loadPage rejects empty sessionId", async () => {
      const store = createStore();
      const result = await store.loadPage(sessionId(""), { limit: 10 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("remove rejects empty sessionId", async () => {
      const store = createStore();
      const result = await store.remove(sessionId(""));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("compact rejects empty sessionId", async () => {
      const store = createStore();
      const result = await store.compact(sessionId(""), "summary", 2);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    test("empty entries array is a no-op", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      expect((await store.append(sid, [])).ok).toBe(true);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(0);
      }
    });

    test("unicode content round-trips correctly", async () => {
      const store = createStore();
      const sid = sessionId("s-unicode");
      const content = "Hello 工具-名前-도구 🤖 مرحبا";
      await store.append(sid, [makeTranscriptEntry({ content })]);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries[0]?.content).toBe(content);
      }
    });

    test("metadata round-trips correctly", async () => {
      const store = createStore();
      const sid = sessionId("s-meta");
      const meta = { tool: "bash", exitCode: 0, nested: { deep: true } };
      await store.append(sid, [makeTranscriptEntry({ metadata: meta })]);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries[0]?.metadata).toEqual(meta);
      }
    });

    test("all 6 roles round-trip correctly", async () => {
      const store = createStore();
      const sid = sessionId("s-roles");
      const roles = [
        "user",
        "assistant",
        "tool_call",
        "tool_result",
        "system",
        "compaction",
      ] as const;
      await store.append(
        sid,
        roles.map((role) => makeTranscriptEntry({ role })),
      );

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries.length).toBe(6);
        for (let i = 0; i < roles.length; i++) {
          expect(result.value.entries[i]?.role).toBe(roles[i]);
        }
      }
    });
  });
}
