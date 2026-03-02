/**
 * Reusable contract test suite for any AuditSink implementation.
 *
 * Call `runAuditSinkContractTests(createSink, readEntries)` with a factory
 * that creates a fresh sink per test group and an optional read-back function
 * (since AuditSink is write-only, we need a side-channel for verification).
 */

import { describe, expect, test } from "bun:test";
import type { AuditEntry, AuditSink } from "@koi/core";

const ENTRY_KINDS = [
  "model_call",
  "tool_call",
  "session_start",
  "session_end",
  "secret_access",
] as const;

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: Date.now(),
    sessionId: "session-1",
    agentId: "agent-1",
    turnIndex: 0,
    kind: "model_call",
    durationMs: 42,
    ...overrides,
  };
}

export function runAuditSinkContractTests(
  createSink: () => AuditSink,
  readEntries?: () => Promise<readonly AuditEntry[]>,
): void {
  describe("AuditSink contract", () => {
    test("log() accepts a valid entry without throwing", async () => {
      const sink = createSink();
      await expect(sink.log(makeEntry())).resolves.toBeUndefined();
      await sink.flush?.();
    });

    test("flush() resolves when buffer is empty", async () => {
      const sink = createSink();
      await expect(sink.flush?.() ?? Promise.resolve()).resolves.toBeUndefined();
    });

    test("log() + flush() persists entries", async () => {
      if (!readEntries) return;

      const sink = createSink();
      const entry = makeEntry({ turnIndex: 1 });
      await sink.log(entry);
      await sink.flush?.();

      const stored = await readEntries();
      expect(stored.length).toBeGreaterThanOrEqual(1);
      const found = stored.find((e) => e.turnIndex === 1);
      expect(found).toBeDefined();
      expect(found?.sessionId).toBe("session-1");
    });

    test("flush() is idempotent", async () => {
      const sink = createSink();
      await sink.log(makeEntry());
      await sink.flush?.();
      // Second flush should be a no-op, not throw
      await expect(sink.flush?.() ?? Promise.resolve()).resolves.toBeUndefined();
    });

    test("entry ordering is preserved", async () => {
      if (!readEntries) return;

      const sink = createSink();
      for (let i = 0; i < 5; i++) {
        await sink.log(makeEntry({ turnIndex: i, timestamp: 1000 + i }));
      }
      await sink.flush?.();

      const stored = await readEntries();
      const turns = stored.map((e) => e.turnIndex);
      expect(turns).toEqual([0, 1, 2, 3, 4]);
    });

    test("all 5 entry kinds are accepted", async () => {
      const sink = createSink();
      for (const kind of ENTRY_KINDS) {
        await expect(sink.log(makeEntry({ kind }))).resolves.toBeUndefined();
      }
      await sink.flush?.();
    });
  });
}
