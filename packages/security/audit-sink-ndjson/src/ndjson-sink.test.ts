import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, rm, stat } from "node:fs/promises";
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

describe("createNdjsonAuditSink — rotation", () => {
  let archiveDir: string;

  afterEach(async () => {
    await rm(archiveDir, { recursive: true, force: true });
  });

  test("size-based rotation archives the file when threshold is exceeded", async () => {
    archiveDir = `${testFilePath}.archive`;
    // Each entry is ~150 bytes; threshold of 100 triggers after first write
    const sink = createNdjsonAuditSink({
      filePath: testFilePath,
      rotation: { maxSizeBytes: 100 },
    });

    await sink.log(makeEntry({ kind: "session_start" }));
    await sink.log(makeEntry({ kind: "model_call" })); // triggers rotation

    const archived = await readdir(archiveDir);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived[0]).toMatch(/\.ndjson$/);

    await sink.close();
  });

  test("query() spans current file and all archived files", async () => {
    archiveDir = `${testFilePath}.archive`;
    const sink = createNdjsonAuditSink({
      filePath: testFilePath,
      rotation: { maxSizeBytes: 100 },
    });

    await sink.log(makeEntry({ kind: "session_start", sessionId: "s-cross" }));
    await sink.log(makeEntry({ kind: "model_call", sessionId: "s-cross" })); // triggers rotation
    await sink.log(makeEntry({ kind: "tool_call", sessionId: "s-cross" })); // in new file
    await sink.flush();

    const entries = (await sink.query?.("s-cross")) ?? [];
    expect(entries).toHaveLength(3);
    expect(entries[0]?.kind).toBe("session_start");
    expect(entries[1]?.kind).toBe("model_call");
    expect(entries[2]?.kind).toBe("tool_call");

    await sink.close();
  });

  test("getEntries() returns entries from all files in chronological order", async () => {
    archiveDir = `${testFilePath}.archive`;
    const sink = createNdjsonAuditSink({
      filePath: testFilePath,
      rotation: { maxSizeBytes: 100 },
    });

    await sink.log(makeEntry({ kind: "session_start", turnIndex: 0 }));
    await sink.log(makeEntry({ kind: "model_call", turnIndex: 1 })); // triggers rotation
    await sink.log(makeEntry({ kind: "tool_call", turnIndex: 2 }));
    await sink.flush();

    const entries = await sink.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.turnIndex).toBe(0);
    expect(entries[1]?.turnIndex).toBe(1);
    expect(entries[2]?.turnIndex).toBe(2);

    await sink.close();
  });

  test("archived file is not written to after rotation", async () => {
    archiveDir = `${testFilePath}.archive`;
    const sink = createNdjsonAuditSink({
      filePath: testFilePath,
      rotation: { maxSizeBytes: 100 },
    });

    await sink.log(makeEntry({ kind: "session_start" }));
    await sink.log(makeEntry({ kind: "model_call" })); // triggers rotation

    const archived = await readdir(archiveDir);
    const firstFile = archived[0];
    if (!firstFile) throw new Error("no archived files found");
    const archivePath = join(archiveDir, firstFile);
    const sizeBefore = (await stat(archivePath)).size;

    // Write more entries — should go to new file, not archived one
    await sink.log(makeEntry({ kind: "tool_call" }));
    await sink.flush();

    const sizeAfter = (await stat(archivePath)).size;
    expect(sizeAfter).toBe(sizeBefore);

    await sink.close();
  });

  test("daily rotation fires when the day string changes", async () => {
    archiveDir = `${testFilePath}.archive`;
    // Inject a mutable clock — test holds the reference and advances it
    const clock = {
      todayUtc: () => "2026-04-25",
    };
    const sink = createNdjsonAuditSink({
      filePath: testFilePath,
      rotation: { daily: true },
      _clockForTesting: clock,
    });

    await sink.log(makeEntry({ kind: "session_start" }));
    await sink.flush();

    // Advance the day — next log should trigger rotation
    clock.todayUtc = () => "2026-04-26";
    await sink.log(makeEntry({ kind: "model_call" }));

    const archived = await readdir(archiveDir);
    expect(archived.length).toBe(1);

    await sink.close();
  });

  test("hash-chain prev_hash is preserved across rotation boundary", async () => {
    archiveDir = `${testFilePath}.archive`;
    const sink = createNdjsonAuditSink({
      filePath: testFilePath,
      rotation: { maxSizeBytes: 100 },
    });

    const hash = "sha256-abc123";
    await sink.log(makeEntry({ kind: "session_start" }));
    await sink.log(makeEntry({ kind: "model_call", prev_hash: hash })); // triggers rotation
    await sink.log(makeEntry({ kind: "tool_call", prev_hash: "sha256-def456" }));
    await sink.flush();

    const all = await sink.getEntries();
    expect(all[1]?.prev_hash).toBe(hash);
    expect(all[2]?.prev_hash).toBe("sha256-def456");

    await sink.close();
  });
});
