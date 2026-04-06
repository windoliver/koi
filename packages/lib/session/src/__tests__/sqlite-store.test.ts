import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { agentId, sessionId } from "@koi/core";
import { createSqliteSessionPersistence } from "../persistence/sqlite-store.js";
import { runSessionPersistenceContractTests } from "./contracts/session-persistence-contract.js";

// ---------------------------------------------------------------------------
// Temp file registry — afterEach cleans up even when assertions fail
// ---------------------------------------------------------------------------

const tempPaths: string[] = [];

afterEach(async () => {
  for (const p of tempPaths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await rm(`${p}${suffix}`, { force: true });
      } catch {
        // best effort — file may not exist
      }
    }
  }
  tempPaths.length = 0;
});

/** Register a temp file path for cleanup and return it. */
function tempDb(label: string): string {
  const p = `/tmp/koi-test-${label}-${Date.now()}.db`;
  tempPaths.push(p);
  return p;
}

// ---------------------------------------------------------------------------
// createRawTestDb — creates a pre-schema'd SQLite file for injection tests.
// Single source of truth: update here when the schema evolves.
// ---------------------------------------------------------------------------

function createRawTestDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS _schema_version (v INTEGER NOT NULL)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS session_records (
      sessionId        TEXT PRIMARY KEY,
      agentId          TEXT NOT NULL,
      manifest         TEXT NOT NULL,
      seq              INTEGER NOT NULL DEFAULT 0,
      remoteSeq        INTEGER NOT NULL DEFAULT 0,
      connectedAt      INTEGER NOT NULL,
      lastPersistedAt  INTEGER NOT NULL,
      lastEngineState  TEXT,
      metadata         TEXT NOT NULL DEFAULT '{}',
      status           TEXT NOT NULL DEFAULT 'idle'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS pending_frames (
      frameId     TEXT PRIMARY KEY,
      sessionId   TEXT NOT NULL,
      agentId     TEXT NOT NULL,
      frameType   TEXT NOT NULL,
      payload     TEXT NOT NULL,
      orderIndex  INTEGER NOT NULL,
      createdAt   INTEGER NOT NULL,
      ttl         INTEGER,
      retryCount  INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS content_replacements (
      session_id  TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      byte_count  INTEGER NOT NULL,
      replaced_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, message_id)
    )
  `);
  return db;
}

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
  test("corrupt manifest JSON in session row is isolated to skipped", () => {
    const tmpPath = tempDb("corrupt");
    const rawDb = createRawTestDb(tmpPath);
    rawDb.run(`
      INSERT INTO session_records (sessionId, agentId, manifest, connectedAt, lastPersistedAt)
      VALUES ('corrupt-session', 'agent-1', 'not valid json at all', 1000, 1000)
    `);
    rawDb.run(`
      INSERT INTO session_records (sessionId, agentId, manifest, seq, connectedAt, lastPersistedAt)
      VALUES ('good-session', 'agent-1', '{"name":"test","version":"0.1.0","model":{"name":"m"}}', 1, 1000, 1000)
    `);
    rawDb.close();

    const fileStore = createSqliteSessionPersistence({ dbPath: tmpPath });
    const result = fileStore.recover();

    expect(result).not.toBeInstanceOf(Promise);
    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0]?.sessionId).toBe(sessionId("good-session"));
        expect(result.value.skipped.length).toBe(1);
        expect(result.value.skipped[0]?.source).toBe("session");
        expect(result.value.skipped[0]?.id).toBe("corrupt-session");
      }
    }
    fileStore.close();
  });

  test("corrupt pending frame JSON is isolated to skipped", () => {
    const tmpPath = tempDb("corrupt-frame");
    const rawDb = createRawTestDb(tmpPath);
    rawDb.run(`
      INSERT INTO session_records (sessionId, agentId, manifest, connectedAt, lastPersistedAt)
      VALUES ('s1', 'agent-1', '{"name":"test","version":"0.1.0","model":{"name":"m"}}', 1000, 1000)
    `);
    rawDb.run(`
      INSERT INTO pending_frames (frameId, sessionId, agentId, frameType, payload, orderIndex, createdAt, retryCount)
      VALUES ('corrupt-frame', 's1', 'agent-1', 'agent:message', 'not json {{{}', 0, 1000, 0)
    `);
    rawDb.close();

    const fileStore = createSqliteSessionPersistence({ dbPath: tmpPath });
    const result = fileStore.recover();

    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.skipped.length).toBe(1);
        expect(result.value.skipped[0]?.source).toBe("pending_frame");
        expect(result.value.skipped[0]?.id).toBe("corrupt-frame");
      }
    }
    fileStore.close();
  });

  test("orphan pending frames (session not recovered) are moved to skipped", () => {
    const tmpPath = tempDb("orphan-frame");
    const rawDb = createRawTestDb(tmpPath);
    rawDb.run(`
      INSERT INTO session_records (sessionId, agentId, manifest, connectedAt, lastPersistedAt)
      VALUES ('bad-session', 'agent-1', 'not valid json', 1000, 1000)
    `);
    rawDb.run(`
      INSERT INTO session_records (sessionId, agentId, manifest, connectedAt, lastPersistedAt)
      VALUES ('good-session', 'agent-1', '{"name":"test","version":"0.1.0","model":{"name":"m"}}', 1000, 1000)
    `);
    rawDb.run(`
      INSERT INTO pending_frames (frameId, sessionId, agentId, frameType, payload, orderIndex, createdAt, retryCount)
      VALUES ('frame-good', 'good-session', 'agent-1', 'agent:message', '{"kind":"text","text":"hi"}', 0, 1000, 0)
    `);
    rawDb.run(`
      INSERT INTO pending_frames (frameId, sessionId, agentId, frameType, payload, orderIndex, createdAt, retryCount)
      VALUES ('frame-orphan', 'bad-session', 'agent-1', 'agent:message', '{"kind":"text","text":"lost"}', 0, 1000, 0)
    `);
    rawDb.close();

    const fileStore = createSqliteSessionPersistence({ dbPath: tmpPath });
    const result = fileStore.recover();

    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(1);
        expect(result.value.sessions[0]?.sessionId).toBe(sessionId("good-session"));
        expect(result.value.pendingFrames.get(String(sessionId("good-session")))?.length).toBe(1);
        expect(result.value.pendingFrames.has(String(sessionId("bad-session")))).toBe(false);
        const orphanSkip = result.value.skipped.find((s) => s.id === "frame-orphan");
        expect(orphanSkip).toBeDefined();
        expect(orphanSkip?.source).toBe("pending_frame");
      }
    }
    fileStore.close();
  });
});

// ---------------------------------------------------------------------------
// Schema version table
// ---------------------------------------------------------------------------

describe("SqliteSessionPersistence (schema version)", () => {
  test("_schema_version is written at DB creation", () => {
    const tmpPath = tempDb("schema-version");
    const store = createSqliteSessionPersistence({ dbPath: tmpPath });
    store.close();

    const db = new Database(tmpPath);
    const row = db.query<{ v: number }, []>("SELECT v FROM _schema_version LIMIT 1").get();
    expect(row).not.toBeNull();
    expect(row?.v).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Status column lifecycle (Issue 1-A)
//
// Written BEFORE the implementation (red phase) — tests must fail until
// setSessionStatus() is added to sqlite-store.ts and the status column
// is added to session_records.
// ---------------------------------------------------------------------------

describe("SqliteSessionPersistence (status lifecycle)", () => {
  const manifest = '{"name":"test","version":"0.1.0","model":{"name":"m"}}';

  test("new session defaults to idle status", () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    store.saveSession({
      sessionId: sessionId("s-status"),
      agentId: agentId("agent-1"),
      manifestSnapshot: { name: "test", version: "0.1.0", model: { name: "m" } },
      seq: 0,
      remoteSeq: 0,
      connectedAt: Date.now(),
      lastPersistedAt: Date.now(),
      status: "idle",
      metadata: {},
    });

    const result = store.loadSession("s-status");
    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("idle");
      }
    }
    store.close();
  });

  test("setSessionStatus transitions idle → running → idle", () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    store.saveSession({
      sessionId: sessionId("s-lifecycle"),
      agentId: agentId("agent-1"),
      manifestSnapshot: { name: "test", version: "0.1.0", model: { name: "m" } },
      seq: 0,
      remoteSeq: 0,
      connectedAt: Date.now(),
      lastPersistedAt: Date.now(),
      status: "idle",
      metadata: {},
    });

    store.setSessionStatus("s-lifecycle", "running");
    const afterRunning = store.loadSession("s-lifecycle");
    if (!("then" in afterRunning)) {
      expect(afterRunning.ok && afterRunning.value.status).toBe("running");
    }

    store.setSessionStatus("s-lifecycle", "idle");
    const afterIdle = store.loadSession("s-lifecycle");
    if (!("then" in afterIdle)) {
      expect(afterIdle.ok && afterIdle.value.status).toBe("idle");
    }

    store.close();
  });

  test("recover() returns all sessions including running ones as crash candidates", () => {
    // Inject a session with status=running directly to simulate a crash
    const tmpPath = tempDb("status-recover");
    const rawDb = createRawTestDb(tmpPath);
    rawDb.run(`
      INSERT INTO session_records (sessionId, agentId, manifest, connectedAt, lastPersistedAt, status)
      VALUES ('crashed', 'agent-1', '${manifest}', 1000, 1000, 'running')
    `);
    rawDb.run(`
      INSERT INTO session_records (sessionId, agentId, manifest, connectedAt, lastPersistedAt, status)
      VALUES ('clean', 'agent-1', '${manifest}', 1000, 1000, 'idle')
    `);
    rawDb.close();

    const store = createSqliteSessionPersistence({ dbPath: tmpPath });
    const result = store.recover();

    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        // recover() returns ALL sessions; caller filters for status="running"
        expect(result.value.sessions.length).toBe(2);
        const crashCandidates = result.value.sessions.filter((s) => s.status === "running");
        expect(crashCandidates.length).toBe(1);
        expect(crashCandidates[0]?.sessionId).toBe(sessionId("crashed"));
      }
    }
    store.close();
  });

  test("setSessionStatus for unknown session returns NOT_FOUND", () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    const result = store.setSessionStatus("nonexistent", "running");
    if (!("then" in result)) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    }
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Content replacements (Issue 3-A)
//
// Written BEFORE the implementation (red phase) — tests must fail until
// content_replacements table and methods are added to sqlite-store.ts.
// ---------------------------------------------------------------------------

describe("SqliteSessionPersistence (content replacements)", () => {
  test("saveContentReplacement and loadContentReplacements round-trip", () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    store.saveSession({
      sessionId: sessionId("s-cr"),
      agentId: agentId("agent-1"),
      manifestSnapshot: { name: "test", version: "0.1.0", model: { name: "m" } },
      seq: 0,
      remoteSeq: 0,
      connectedAt: 1000,
      lastPersistedAt: 1000,
      status: "idle",
      metadata: {},
    });

    const replacement = {
      sessionId: sessionId("s-cr"),
      messageId: "msg-001",
      filePath: "/tmp/koi/s-cr/msg-001.txt",
      byteCount: 4096,
      replacedAt: 2000,
    };
    const saveResult = store.saveContentReplacement(replacement);
    if (!("then" in saveResult)) {
      expect(saveResult.ok).toBe(true);
    }

    const loadResult = store.loadContentReplacements("s-cr");
    if (!("then" in loadResult)) {
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.length).toBe(1);
        expect(loadResult.value[0]?.messageId).toBe("msg-001");
        expect(loadResult.value[0]?.filePath).toBe("/tmp/koi/s-cr/msg-001.txt");
        expect(loadResult.value[0]?.byteCount).toBe(4096);
      }
    }
    store.close();
  });

  test("loadContentReplacements returns empty array for session with no replacements", () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    store.saveSession({
      sessionId: sessionId("s-no-cr"),
      agentId: agentId("agent-1"),
      manifestSnapshot: { name: "test", version: "0.1.0", model: { name: "m" } },
      seq: 0,
      remoteSeq: 0,
      connectedAt: 1000,
      lastPersistedAt: 1000,
      status: "idle",
      metadata: {},
    });

    const result = store.loadContentReplacements("s-no-cr");
    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    }
    store.close();
  });

  test("removeSession cascades to content_replacements", () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    store.saveSession({
      sessionId: sessionId("s-cascade-cr"),
      agentId: agentId("agent-1"),
      manifestSnapshot: { name: "test", version: "0.1.0", model: { name: "m" } },
      seq: 0,
      remoteSeq: 0,
      connectedAt: 1000,
      lastPersistedAt: 1000,
      status: "idle",
      metadata: {},
    });
    store.saveContentReplacement({
      sessionId: sessionId("s-cascade-cr"),
      messageId: "msg-cascade",
      filePath: "/tmp/cascade.txt",
      byteCount: 100,
      replacedAt: 1000,
    });
    store.removeSession("s-cascade-cr");

    const result = store.loadContentReplacements("s-cascade-cr");
    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    }
    store.close();
  });

  test("multiple replacements per session are all returned", () => {
    const store = createSqliteSessionPersistence({ dbPath: ":memory:" });
    store.saveSession({
      sessionId: sessionId("s-multi-cr"),
      agentId: agentId("agent-1"),
      manifestSnapshot: { name: "test", version: "0.1.0", model: { name: "m" } },
      seq: 0,
      remoteSeq: 0,
      connectedAt: 1000,
      lastPersistedAt: 1000,
      status: "idle",
      metadata: {},
    });
    for (let i = 0; i < 3; i++) {
      store.saveContentReplacement({
        sessionId: sessionId("s-multi-cr"),
        messageId: `msg-${i}`,
        filePath: `/tmp/msg-${i}.txt`,
        byteCount: 100 * (i + 1),
        replacedAt: 1000 + i,
      });
    }

    const result = store.loadContentReplacements("s-multi-cr");
    if (!("then" in result)) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
      }
    }
    store.close();
  });
});
