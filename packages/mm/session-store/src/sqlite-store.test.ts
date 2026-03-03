import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentId, sessionId } from "@koi/core";
import { runSessionPersistenceContractTests } from "./__tests__/store-contract.js";
import { createSqliteSessionPersistence } from "./sqlite-store.js";

// ---------------------------------------------------------------------------
// Contract tests (shared with in-memory)
// ---------------------------------------------------------------------------

describe("SqliteSessionPersistence", () => {
  const tempDirs: string[] = [];

  function makeTempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "koi-session-store-"));
    tempDirs.push(dir);
    return join(dir, "sessions.db");
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  runSessionPersistenceContractTests(() =>
    createSqliteSessionPersistence({
      dbPath: makeTempDbPath(),
    }),
  );

  // -----------------------------------------------------------------------
  // SQLite-specific durability tests
  // -----------------------------------------------------------------------
  describe("durability", () => {
    test("data survives close and reopen", async () => {
      const dbPath = makeTempDbPath();
      const aid = agentId("durable-agent");
      const engineState = { engineId: "test", data: { turnCount: 5 } };

      // Write data and close
      const store1 = createSqliteSessionPersistence({ dbPath });
      await store1.saveSession({
        sessionId: sessionId("s1"),
        agentId: aid,
        manifestSnapshot: {
          name: "test",
          version: "0.1.0",
          description: "d",
          model: { name: "m" },
        },
        seq: 42,
        remoteSeq: 10,
        connectedAt: 1000,
        lastPersistedAt: 2000,
        lastEngineState: engineState,
        metadata: { key: "value" },
      });
      store1.close();

      // Reopen and verify
      const store2 = createSqliteSessionPersistence({ dbPath });
      const sessionResult = await store2.loadSession("s1");
      expect(sessionResult.ok).toBe(true);
      if (sessionResult.ok) {
        expect(sessionResult.value.seq).toBe(42);
        expect(sessionResult.value.metadata).toEqual({ key: "value" });
        expect(sessionResult.value.lastEngineState).toBeDefined();
        const data = sessionResult.value.lastEngineState?.data as { turnCount: number };
        expect(data.turnCount).toBe(5);
      }

      store2.close();
    });

    test("WAL mode is active", () => {
      const dbPath = makeTempDbPath();
      const store = createSqliteSessionPersistence({ dbPath });
      const db = new Database(dbPath, { readonly: true });
      const result = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      expect(result?.journal_mode).toBe("wal");
      db.close();
      store.close();
    });

    test("durability=process creates store without error", async () => {
      const dbPath = makeTempDbPath();
      const store = createSqliteSessionPersistence({ dbPath, durability: "process" });
      const result = await store.saveSession({
        sessionId: sessionId("test-sync"),
        agentId: agentId("a1"),
        manifestSnapshot: { name: "t", version: "0.1.0", description: "d", model: { name: "m" } },
        seq: 0,
        remoteSeq: 0,
        connectedAt: Date.now(),
        lastPersistedAt: Date.now(),
        metadata: {},
      });
      expect(result.ok).toBe(true);
      store.close();
    });

    test("durability=os creates store without error", async () => {
      const dbPath = makeTempDbPath();
      const store = createSqliteSessionPersistence({ dbPath, durability: "os" });
      const result = await store.saveSession({
        sessionId: sessionId("test-sync"),
        agentId: agentId("a1"),
        manifestSnapshot: { name: "t", version: "0.1.0", description: "d", model: { name: "m" } },
        seq: 0,
        remoteSeq: 0,
        connectedAt: Date.now(),
        lastPersistedAt: Date.now(),
        metadata: {},
      });
      expect(result.ok).toBe(true);
      store.close();
    });

    test("recover after close/reopen returns complete plan", async () => {
      const dbPath = makeTempDbPath();
      const a1 = agentId("agent-1");
      const a2 = agentId("agent-2");
      const engineState1 = { engineId: "e1", data: "state-a1" };
      const engineState2 = { engineId: "e2", data: "state-a2" };

      // First session: populate
      const store1 = createSqliteSessionPersistence({ dbPath });
      await store1.saveSession({
        sessionId: sessionId("s1"),
        agentId: a1,
        manifestSnapshot: { name: "a1", version: "0.1.0", description: "d", model: { name: "m" } },
        seq: 1,
        remoteSeq: 0,
        connectedAt: 1000,
        lastPersistedAt: 2000,
        lastEngineState: engineState1,
        metadata: {},
      });
      await store1.saveSession({
        sessionId: sessionId("s2"),
        agentId: a2,
        manifestSnapshot: { name: "a2", version: "0.1.0", description: "d", model: { name: "m" } },
        seq: 5,
        remoteSeq: 3,
        connectedAt: 1500,
        lastPersistedAt: 2500,
        lastEngineState: engineState2,
        metadata: {},
      });
      store1.close();

      // Second session: recover
      const store2 = createSqliteSessionPersistence({ dbPath });
      const result = await store2.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        const s1 = result.value.sessions.find((s) => s.agentId === a1);
        const s2 = result.value.sessions.find((s) => s.agentId === a2);
        expect(s1?.lastEngineState?.data).toBe("state-a1");
        expect(s2?.lastEngineState?.data).toBe("state-a2");
      }
      store2.close();
    });
  });
});
