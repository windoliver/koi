/**
 * Reusable contract test suite for any SessionTranscript implementation.
 *
 * Call `runSessionTranscriptContractTests(factory)` with a factory that
 * creates a fresh store per test group.
 */

import { describe, expect, test } from "bun:test";
import type { SessionTranscript, TranscriptEntry } from "@koi/core";
import { sessionId, transcriptEntryId } from "@koi/core";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a transcript entry with sensible defaults. Overrides merge on top.
 * Uses timestamp + random suffix for uniqueness — no module-level mutable state.
 */
export function makeTranscriptEntry(overrides?: Partial<TranscriptEntry>): TranscriptEntry {
  const uniqueId = `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: transcriptEntryId(uniqueId),
    role: "user",
    content: `test message ${uniqueId}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract tests
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

      const appendResult = await store.append(sid, [entry]);
      expect(appendResult.ok).toBe(true);

      const loadResult = await store.load(sid);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.entries.length).toBe(1);
        expect(loadResult.value.entries[0]?.id).toBe(entry.id);
        expect(loadResult.value.entries[0]?.role).toBe("user");
        expect(loadResult.value.entries[0]?.content).toBe("hello");
        expect(loadResult.value.skipped.length).toBe(0);
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
        expect(result.value.entries.length).toBe(3);
        expect(result.value.entries[0]?.content).toBe("first");
        expect(result.value.entries[1]?.content).toBe("second");
        expect(result.value.entries[2]?.content).toBe("third");
      }
    });

    test("multiple sessions are independent", async () => {
      const store = createStore();
      const s1 = sessionId("s1");
      const s2 = sessionId("s2");
      const e1 = makeTranscriptEntry({ content: "s1-msg" });
      const e2 = makeTranscriptEntry({ content: "s2-msg" });

      await store.append(s1, [e1]);
      await store.append(s2, [e2]);

      const r1 = await store.load(s1);
      const r2 = await store.load(s2);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.entries.length).toBe(1);
        expect(r1.value.entries[0]?.content).toBe("s1-msg");
        expect(r2.value.entries.length).toBe(1);
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
      const entries = Array.from({ length: 3 }, (_, i) =>
        makeTranscriptEntry({ content: `msg-${i}` }),
      );
      await store.append(sid, entries);

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
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeTranscriptEntry({ content: `msg-${i}`, timestamp: 1000 * (i + 1) }),
      );
      await store.append(sid, entries);

      const compactResult = await store.compact(sid, "Summary of first 3 messages", 2);
      expect(compactResult.ok).toBe(true);

      const loadResult = await store.load(sid);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        // compaction entry + 2 preserved = 3
        expect(loadResult.value.entries.length).toBe(3);
        expect(loadResult.value.entries[0]?.role).toBe("compaction");
        expect(loadResult.value.entries[0]?.content).toBe("Summary of first 3 messages");
        expect(loadResult.value.entries[1]?.content).toBe("msg-3");
        expect(loadResult.value.entries[2]?.content).toBe("msg-4");
      }
    });

    test("compact with preserveLastN=0 preserves only the compaction summary", async () => {
      const store = createStore();
      const sid = sessionId("s1");
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeTranscriptEntry({ content: `msg-${i}`, timestamp: 1000 * (i + 1) }),
      );
      await store.append(sid, entries);

      const compactResult = await store.compact(sid, "Full conversation summary", 0);
      expect(compactResult.ok).toBe(true);

      const loadResult = await store.load(sid);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.entries.length).toBe(1);
        expect(loadResult.value.entries[0]?.role).toBe("compaction");
        expect(loadResult.value.entries[0]?.content).toBe("Full conversation summary");
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

      const removeResult = await store.remove(sid);
      expect(removeResult.ok).toBe(true);

      const loadResult = await store.load(sid);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.entries.length).toBe(0);
      }
    });

    test("remove non-existent session is a no-op success", async () => {
      const store = createStore();
      const result = await store.remove(sessionId("nonexistent"));
      expect(result.ok).toBe(true);
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
      const result = await store.append(sid, []);
      expect(result.ok).toBe(true);

      const loadResult = await store.load(sid);
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.entries.length).toBe(0);
      }
    });

    test("unicode content round-trips correctly", async () => {
      const store = createStore();
      const sid = sessionId("s-unicode");
      const unicodeContent =
        "Hello \u5DE5\u5177-\u540D\u524D-\uB3C4\uAD6C \u{1F916} \u0645\u0631\u062D\u0628\u0627";
      const entry = makeTranscriptEntry({ content: unicodeContent });
      await store.append(sid, [entry]);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries[0]?.content).toBe(unicodeContent);
      }
    });

    test("metadata round-trips correctly", async () => {
      const store = createStore();
      const sid = sessionId("s-meta");
      const entry = makeTranscriptEntry({
        metadata: { tool: "bash", exitCode: 0, nested: { deep: true } },
      });
      await store.append(sid, [entry]);

      const result = await store.load(sid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.entries[0]?.metadata).toEqual({
          tool: "bash",
          exitCode: 0,
          nested: { deep: true },
        });
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
      const entries = roles.map((role) => makeTranscriptEntry({ role }));
      await store.append(sid, entries);

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
