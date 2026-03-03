import { describe, expect, test } from "bun:test";
import { runAuditSinkContractTests } from "@koi/test-utils";
import { createSqliteAuditSink } from "./sqlite-sink.js";

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

runAuditSinkContractTests({
  createSink: () => {
    const sink = createSqliteAuditSink({ dbPath: ":memory:", flushIntervalMs: 100 });
    return {
      sink,
      getEntries: () => sink.getEntries(),
    };
  },
});

// ---------------------------------------------------------------------------
// SQLite-specific unit tests
// ---------------------------------------------------------------------------

describe("createSqliteAuditSink — SQLite specifics", () => {
  test("auto-flushes when buffer reaches maxBufferSize", async () => {
    const sink = createSqliteAuditSink({
      dbPath: ":memory:",
      maxBufferSize: 3,
      flushIntervalMs: 60_000, // Long interval — should not trigger
    });

    for (const i of [1, 2, 3]) {
      await sink.log({
        timestamp: Date.now(),
        sessionId: "s",
        agentId: "a",
        turnIndex: i,
        kind: "tool_call",
        durationMs: 10,
      });
    }

    // Buffer full — should have auto-flushed
    const entries = sink.getEntries();
    expect(entries).toHaveLength(3);
    sink.close();
  });

  test("redaction rules are applied to stored entries", async () => {
    const sink = createSqliteAuditSink({
      dbPath: ":memory:",
      redactionRules: [{ pattern: /secret-key-\w+/g, replacement: "[REDACTED]" }],
    });

    await sink.log({
      timestamp: Date.now(),
      sessionId: "s",
      agentId: "a",
      turnIndex: 0,
      kind: "tool_call",
      durationMs: 10,
      request: { apiKey: "secret-key-abc123" },
    });
    await sink.flush?.();

    const entries = sink.getEntries();
    expect(entries).toHaveLength(1);
    const request = entries[0]?.request as { apiKey: string } | undefined;
    expect(request?.apiKey).toBe("[REDACTED]");
    sink.close();
  });

  test("close flushes remaining entries", async () => {
    const sink = createSqliteAuditSink({
      dbPath: ":memory:",
      flushIntervalMs: 60_000,
      maxBufferSize: 1000,
    });

    await sink.log({
      timestamp: Date.now(),
      sessionId: "s",
      agentId: "a",
      turnIndex: 0,
      kind: "session_start",
      durationMs: 0,
    });

    // close() should flush before closing
    const entriesBefore = sink.getEntries();
    expect(entriesBefore).toHaveLength(1);
    sink.close();
  });
});
