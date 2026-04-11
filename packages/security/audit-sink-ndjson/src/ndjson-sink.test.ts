import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "@koi/core";
import { createNdjsonAuditSink } from "./ndjson-sink.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testFilePath: string;

beforeEach(() => {
  testFilePath = join(tmpdir(), `audit-test-${Date.now()}-${Math.random()}.ndjson`);
});

afterEach(async () => {
  await rm(testFilePath, { force: true });
});

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    schema_version: 1,
    timestamp: Date.now(),
    sessionId: "test-session",
    agentId: "test-agent",
    turnIndex: 0,
    kind: "model_call",
    durationMs: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNdjsonAuditSink", () => {
  test("entries appear in file after flush()", async () => {
    const sink = createNdjsonAuditSink({ filePath: testFilePath });
    await sink.log(makeEntry({ kind: "session_start" }));
    await sink.flush();

    const entries = await sink.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("session_start");

    await sink.close();
  });

  test("multiple entries write as separate NDJSON lines", async () => {
    const sink = createNdjsonAuditSink({ filePath: testFilePath });
    await sink.log(makeEntry({ kind: "session_start", turnIndex: -1 }));
    await sink.log(makeEntry({ kind: "model_call", turnIndex: 0 }));
    await sink.log(makeEntry({ kind: "tool_call", turnIndex: 0 }));
    await sink.flush();

    const entries = await sink.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.kind).toBe("session_start");
    expect(entries[1]?.kind).toBe("model_call");
    expect(entries[2]?.kind).toBe("tool_call");

    await sink.close();
  });

  test("getEntries() returns empty array for non-existent file", async () => {
    const sink = createNdjsonAuditSink({ filePath: testFilePath });
    // Don't write anything — file doesn't exist
    const entries = await sink.getEntries();
    expect(entries).toHaveLength(0);
    await sink.close();
  });

  test("close() flushes and entries are readable after close", async () => {
    const sink = createNdjsonAuditSink({ filePath: testFilePath });
    await sink.log(makeEntry());
    await sink.close();

    // Re-open to verify persistence
    const sink2 = createNdjsonAuditSink({ filePath: testFilePath });
    const entries = await sink2.getEntries();
    expect(entries).toHaveLength(1);
    await sink2.close();
  });

  test("query() filters by sessionId", async () => {
    const sink = createNdjsonAuditSink({ filePath: testFilePath });
    await sink.log(makeEntry({ sessionId: "session-A" }));
    await sink.log(makeEntry({ sessionId: "session-B" }));
    await sink.log(makeEntry({ sessionId: "session-A" }));
    await sink.flush();

    const entries = await sink.query?.("session-A");
    expect(entries).toHaveLength(2);

    await sink.close();
  });

  test("schema_version is preserved round-trip", async () => {
    const sink = createNdjsonAuditSink({ filePath: testFilePath });
    await sink.log(makeEntry({ schema_version: 1 }));
    await sink.flush();

    const entries = await sink.getEntries();
    expect(entries[0]?.schema_version).toBe(1);

    await sink.close();
  });
});
