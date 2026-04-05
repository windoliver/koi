import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import { createSqliteSessionPersistence } from "../persistence/sqlite-store.js";
import { runSessionPersistenceContractTests } from "./contracts/session-persistence-contract.js";

// ---------------------------------------------------------------------------
// Contract tests — same suite as in-memory implementation
// ---------------------------------------------------------------------------

describe("SqliteSessionPersistence (contract)", () => {
  runSessionPersistenceContractTests(() => createSqliteSessionPersistence({ dbPath: ":memory:" }));
});

// ---------------------------------------------------------------------------
// SQLite-specific: corruption recovery (decision 11-A)
//
// Inject a row with bad JSON directly into the SQLite DB, then call recover().
// Verifies that per-row error isolation returns ok:true with the corrupt row
// in the `skipped` array — not a thrown exception.
// ---------------------------------------------------------------------------

describe("SqliteSessionPersistence (corruption recovery)", () => {
  let dbPath: string;

  beforeEach(() => {
    // Use a unique in-memory DB name per test so tests are isolated
    dbPath = `:memory:`;
  });

  afterEach(() => {
    // In-memory DBs are automatically freed when the last connection closes
  });

  test("corrupt manifest JSON in session row is isolated to skipped", () => {
    const store = createSqliteSessionPersistence({ dbPath });

    // Inject a corrupt row directly via bun:sqlite (bypassing the store's validation)
    const db = store as unknown as { close: () => void };
    void db; // store holds the DB; we need a separate handle to inject

    // Open a second connection to the same :memory: DB — not possible for :memory:.
    // Instead: create a file-based temp DB, inject, then open via store.
    const tmpPath = `/tmp/koi-test-corrupt-${Date.now()}.db`;
    const rawDb = new Database(tmpPath, { create: true });
    rawDb.run("PRAGMA journal_mode = WAL");
    rawDb.run(`
      CREATE TABLE IF NOT EXISTS session_records (
        sessionId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        manifest TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        remoteSeq INTEGER NOT NULL DEFAULT 0,
        connectedAt INTEGER NOT NULL,
        lastPersistedAt INTEGER NOT NULL,
        lastEngineState TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      )
    `);
    rawDb.run(`
      CREATE TABLE IF NOT EXISTS pending_frames (
        frameId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        frameType TEXT NOT NULL,
        payload TEXT NOT NULL,
        orderIndex INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        ttl INTEGER,
        retryCount INTEGER NOT NULL DEFAULT 0
      )
    `);
    rawDb.run(`
      INSERT INTO session_records
        (sessionId, agentId, manifest, seq, remoteSeq, connectedAt, lastPersistedAt, metadata)
      VALUES
        ('corrupt-session', 'agent-1', 'not valid json at all', 0, 0, 1000, 1000, '{}')
    `);
    rawDb.run(`
      INSERT INTO session_records
        (sessionId, agentId, manifest, seq, remoteSeq, connectedAt, lastPersistedAt, metadata)
      VALUES
        ('good-session', 'agent-1', '{"name":"test","version":"0.1.0","model":{"name":"m"}}', 1, 0, 1000, 1000, '{}')
    `);
    rawDb.close();

    // Now open via the store — it sees the pre-existing rows
    const fileStore = createSqliteSessionPersistence({ dbPath: tmpPath });
    const result = fileStore.recover();

    // result is sync for SQLite
    expect(result).not.toBeInstanceOf(Promise);
    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The good session should be recovered
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0]?.sessionId).toBe(sessionId("good-session"));
        // The corrupt row should be in skipped, not thrown
        expect(result.value.skipped.length).toBe(1);
        expect(result.value.skipped[0]?.source).toBe("session");
        expect(result.value.skipped[0]?.id).toBe("corrupt-session");
      }
    }

    fileStore.close();
    // Clean up temp file
    try {
      Bun.file(tmpPath).delete?.();
    } catch {
      // best effort cleanup
    }
  });

  test("corrupt pending frame JSON is isolated to skipped", () => {
    const tmpPath = `/tmp/koi-test-corrupt-frame-${Date.now()}.db`;
    const rawDb = new Database(tmpPath, { create: true });
    rawDb.run("PRAGMA journal_mode = WAL");
    rawDb.run(`
      CREATE TABLE IF NOT EXISTS session_records (
        sessionId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        manifest TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        remoteSeq INTEGER NOT NULL DEFAULT 0,
        connectedAt INTEGER NOT NULL,
        lastPersistedAt INTEGER NOT NULL,
        lastEngineState TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      )
    `);
    rawDb.run(`
      CREATE TABLE IF NOT EXISTS pending_frames (
        frameId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        frameType TEXT NOT NULL,
        payload TEXT NOT NULL,
        orderIndex INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        ttl INTEGER,
        retryCount INTEGER NOT NULL DEFAULT 0
      )
    `);

    // A valid session
    rawDb.run(`
      INSERT INTO session_records
        (sessionId, agentId, manifest, seq, remoteSeq, connectedAt, lastPersistedAt, metadata)
      VALUES
        ('s1', 'agent-1', '{"name":"test","version":"0.1.0","model":{"name":"m"}}', 0, 0, 1000, 1000, '{}')
    `);

    // A corrupt pending frame (payload is not valid JSON)
    rawDb.run(`
      INSERT INTO pending_frames
        (frameId, sessionId, agentId, frameType, payload, orderIndex, createdAt, retryCount)
      VALUES
        ('corrupt-frame', 's1', 'agent-1', 'agent:message', 'not json {{{}', 0, 1000, 0)
    `);
    rawDb.close();

    const fileStore = createSqliteSessionPersistence({ dbPath: tmpPath });
    const result = fileStore.recover();

    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Session recovers fine
        expect(result.value.sessions.length).toBe(1);
        // Corrupt frame is skipped, not thrown
        expect(result.value.skipped.length).toBe(1);
        expect(result.value.skipped[0]?.source).toBe("pending_frame");
        expect(result.value.skipped[0]?.id).toBe("corrupt-frame");
      }
    }

    fileStore.close();
    try {
      Bun.file(tmpPath).delete?.();
    } catch {
      // best effort cleanup
    }
  });

  test("orphan pending frames (session not recovered) are moved to skipped", () => {
    const tmpPath = `/tmp/koi-test-orphan-frame-${Date.now()}.db`;
    const rawDb = new Database(tmpPath, { create: true });
    rawDb.run("PRAGMA journal_mode = WAL");
    rawDb.run(`
      CREATE TABLE IF NOT EXISTS session_records (
        sessionId TEXT PRIMARY KEY,
        agentId TEXT NOT NULL,
        manifest TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        remoteSeq INTEGER NOT NULL DEFAULT 0,
        connectedAt INTEGER NOT NULL,
        lastPersistedAt INTEGER NOT NULL,
        lastEngineState TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      )
    `);
    rawDb.run(`
      CREATE TABLE IF NOT EXISTS pending_frames (
        frameId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        frameType TEXT NOT NULL,
        payload TEXT NOT NULL,
        orderIndex INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        ttl INTEGER,
        retryCount INTEGER NOT NULL DEFAULT 0
      )
    `);

    // A corrupt session row — this session will fail to recover
    rawDb.run(`
      INSERT INTO session_records
        (sessionId, agentId, manifest, seq, remoteSeq, connectedAt, lastPersistedAt, metadata)
      VALUES
        ('bad-session', 'agent-1', 'not valid json', 0, 0, 1000, 1000, '{}')
    `);

    // A valid session
    rawDb.run(`
      INSERT INTO session_records
        (sessionId, agentId, manifest, seq, remoteSeq, connectedAt, lastPersistedAt, metadata)
      VALUES
        ('good-session', 'agent-1', '{"name":"test","version":"0.1.0","model":{"name":"m"}}', 0, 0, 1000, 1000, '{}')
    `);

    // A valid frame for the good session
    rawDb.run(`
      INSERT INTO pending_frames
        (frameId, sessionId, agentId, frameType, payload, orderIndex, createdAt, retryCount)
      VALUES
        ('frame-good', 'good-session', 'agent-1', 'agent:message', '{"kind":"text","text":"hi"}', 0, 1000, 0)
    `);

    // An orphan frame for the corrupt (unrecoverable) session
    rawDb.run(`
      INSERT INTO pending_frames
        (frameId, sessionId, agentId, frameType, payload, orderIndex, createdAt, retryCount)
      VALUES
        ('frame-orphan', 'bad-session', 'agent-1', 'agent:message', '{"kind":"text","text":"lost"}', 0, 1000, 0)
    `);
    rawDb.close();

    const fileStore = createSqliteSessionPersistence({ dbPath: tmpPath });
    const result = fileStore.recover();

    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only the good session recovers
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0]?.sessionId).toBe(sessionId("good-session"));

        // The good session's frame is in pendingFrames
        expect(result.value.pendingFrames.get(String(sessionId("good-session")))?.length).toBe(1);

        // The orphan frame is NOT in pendingFrames
        expect(result.value.pendingFrames.has(String(sessionId("bad-session")))).toBe(false);

        // The orphan frame ends up in skipped (1 for corrupt session + 1 for orphan frame)
        const orphanSkip = result.value.skipped.find((s) => s.id === "frame-orphan");
        expect(orphanSkip).toBeDefined();
        expect(orphanSkip?.source).toBe("pending_frame");
      }
    }

    fileStore.close();
    try {
      Bun.file(tmpPath).delete?.();
    } catch {
      // best effort cleanup
    }
  });
});

// ---------------------------------------------------------------------------
// Schema version table
// ---------------------------------------------------------------------------

describe("SqliteSessionPersistence (schema version)", () => {
  test("_schema_version is written at DB creation", () => {
    const tmpPath = `/tmp/koi-test-schema-version-${Date.now()}.db`;
    const store = createSqliteSessionPersistence({ dbPath: tmpPath });
    store.close();

    const db = new Database(tmpPath);
    const row = db.query<{ v: number }, []>("SELECT v FROM _schema_version LIMIT 1").get();
    expect(row).not.toBeNull();
    expect(row?.v).toBe(1);
    db.close();

    try {
      Bun.file(tmpPath).delete?.();
    } catch {
      // best effort cleanup
    }
  });
});
