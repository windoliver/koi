/**
 * Reusable contract test suite for AuditSink implementations.
 *
 * Accepts a factory that returns an AuditSink (sync or async).
 * Each test creates a fresh instance for isolation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AuditEntry, AuditSink } from "@koi/core";

/** Create a minimal valid AuditEntry for testing. */
function createEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: Date.now(),
    sessionId: "session-1",
    agentId: "agent-1",
    turnIndex: 0,
    kind: "tool_call",
    durationMs: 100,
    ...overrides,
  };
}

/**
 * Factory result must include a way to read back logged entries.
 * The `getEntries` function returns all entries stored by the sink.
 */
export interface AuditSinkContractOptions {
  readonly createSink: () =>
    | {
        readonly sink: AuditSink;
        readonly getEntries: () => readonly AuditEntry[] | Promise<readonly AuditEntry[]>;
      }
    | Promise<{
        readonly sink: AuditSink;
        readonly getEntries: () => readonly AuditEntry[] | Promise<readonly AuditEntry[]>;
      }>;
}

/**
 * Run the AuditSink contract test suite against any implementation.
 */
export function runAuditSinkContractTests(options: AuditSinkContractOptions): void {
  describe("AuditSink contract", () => {
    let sink: AuditSink;
    let getEntries: () => readonly AuditEntry[] | Promise<readonly AuditEntry[]>;

    beforeEach(async () => {
      const result = await options.createSink();
      sink = result.sink;
      getEntries = result.getEntries;
    });

    // -----------------------------------------------------------------------
    // log
    // -----------------------------------------------------------------------

    test("log stores a single entry", async () => {
      const entry = createEntry();
      await sink.log(entry);
      if (sink.flush) await sink.flush();

      const entries = await getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.sessionId).toBe("session-1");
      expect(entries[0]?.kind).toBe("tool_call");
    });

    test("log stores multiple sequential entries", async () => {
      await sink.log(createEntry({ turnIndex: 0 }));
      await sink.log(createEntry({ turnIndex: 1 }));
      await sink.log(createEntry({ turnIndex: 2 }));
      if (sink.flush) await sink.flush();

      const entries = await getEntries();
      expect(entries).toHaveLength(3);
    });

    test("log preserves all required fields", async () => {
      const entry = createEntry({
        timestamp: 1700000000000,
        sessionId: "s-42",
        agentId: "a-7",
        turnIndex: 5,
        kind: "model_call",
        durationMs: 250,
      });
      await sink.log(entry);
      if (sink.flush) await sink.flush();

      const entries = await getEntries();
      expect(entries).toHaveLength(1);
      const stored = entries[0];
      expect(stored).toBeDefined();
      if (stored === undefined) return;
      expect(stored.timestamp).toBe(1700000000000);
      expect(stored.sessionId).toBe("s-42");
      expect(stored.agentId).toBe("a-7");
      expect(stored.turnIndex).toBe(5);
      expect(stored.kind).toBe("model_call");
      expect(stored.durationMs).toBe(250);
    });

    test("log preserves all optional fields", async () => {
      const entry = createEntry({
        request: { model: "gpt-4", prompt: "hello" },
        response: { text: "world" },
        error: { code: "TIMEOUT" },
        metadata: { correlationId: "abc-123" },
      });
      await sink.log(entry);
      if (sink.flush) await sink.flush();

      const entries = await getEntries();
      const stored = entries[0];
      expect(stored).toBeDefined();
      if (stored === undefined) return;
      expect(stored.request).toEqual({ model: "gpt-4", prompt: "hello" });
      expect(stored.response).toEqual({ text: "world" });
      expect(stored.error).toEqual({ code: "TIMEOUT" });
      expect(stored.metadata).toEqual({ correlationId: "abc-123" });
    });

    test("log with minimal fields (no optionals)", async () => {
      const entry: AuditEntry = {
        timestamp: Date.now(),
        sessionId: "min",
        agentId: "a",
        turnIndex: -1,
        kind: "session_start",
        durationMs: 0,
      };
      await sink.log(entry);
      if (sink.flush) await sink.flush();

      const entries = await getEntries();
      expect(entries).toHaveLength(1);
    });

    test("log all audit entry kinds", async () => {
      const kinds = [
        "model_call",
        "tool_call",
        "session_start",
        "session_end",
        "secret_access",
      ] as const;
      for (const kind of kinds) {
        await sink.log(createEntry({ kind }));
      }
      if (sink.flush) await sink.flush();

      const entries = await getEntries();
      expect(entries).toHaveLength(5);
    });

    // -----------------------------------------------------------------------
    // flush
    // -----------------------------------------------------------------------

    test("flush is callable (optional — no-op if not implemented)", async () => {
      await sink.log(createEntry());
      if (sink.flush) {
        await sink.flush();
      }
      // Should not throw
    });

    test("log after flush continues to work", async () => {
      await sink.log(createEntry({ turnIndex: 0 }));
      if (sink.flush) await sink.flush();

      await sink.log(createEntry({ turnIndex: 1 }));
      if (sink.flush) await sink.flush();

      const entries = await getEntries();
      expect(entries).toHaveLength(2);
    });
  });
}
