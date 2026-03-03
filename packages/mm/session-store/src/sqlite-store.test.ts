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
      maxCheckpointsPerAgent: 3,
    }),
  );

  // -----------------------------------------------------------------------
  // SQLite-specific durability tests
  // -----------------------------------------------------------------------
  describe("durability", () => {
    test("data survives close and reopen", async () => {
      const dbPath = makeTempDbPath();
      const aid = agentId("durable-agent");

      // Write data and close
      const store1 = createSqliteSessionPersistence({ dbPath, maxCheckpointsPerAgent: 3 });
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
        lastCheckpointAt: 2000,
        metadata: { key: "value" },
      });
      await store1.saveCheckpoint({
        id: "cp1",
        agentId: aid,
        sessionId: sessionId("s1"),
        engineState: { engineId: "test", data: { turnCount: 5 } },
        processState: "running",
        generation: 3,
        metadata: {},
        createdAt: 2000,
      });
      store1.close();

      // Reopen and verify
      const store2 = createSqliteSessionPersistence({ dbPath, maxCheckpointsPerAgent: 3 });
      const sessionResult = await store2.loadSession("s1");
      expect(sessionResult.ok).toBe(true);
      if (sessionResult.ok) {
        expect(sessionResult.value.seq).toBe(42);
        expect(sessionResult.value.metadata).toEqual({ key: "value" });
      }

      const cpResult = await store2.loadLatestCheckpoint(aid);
      expect(cpResult.ok).toBe(true);
      if (cpResult.ok) {
        expect(cpResult.value?.id).toBe("cp1");
        const data = cpResult.value?.engineState.data as { turnCount: number };
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
      // Verify store is functional (PRAGMA synchronous is per-connection, can't verify from outside)
      const result = await store.saveSession({
        sessionId: sessionId("test-sync"),
        agentId: agentId("a1"),
        manifestSnapshot: { name: "t", version: "0.1.0", description: "d", model: { name: "m" } },
        seq: 0,
        remoteSeq: 0,
        connectedAt: Date.now(),
        lastCheckpointAt: Date.now(),
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
        lastCheckpointAt: Date.now(),
        metadata: {},
      });
      expect(result.ok).toBe(true);
      store.close();
    });

    test("checkpoint retention: 5 checkpoints with max=3 retains only 3", async () => {
      const dbPath = makeTempDbPath();
      const store = createSqliteSessionPersistence({ dbPath, maxCheckpointsPerAgent: 3 });
      const aid = agentId("retention-agent");

      for (let i = 0; i < 5; i++) {
        await store.saveCheckpoint({
          id: `cp-${i}`,
          agentId: aid,
          sessionId: sessionId("s1"),
          engineState: { engineId: "test", data: i },
          processState: "running",
          generation: i,
          metadata: {},
          createdAt: 1000 * (i + 1),
        });
      }

      const result = await store.listCheckpoints(aid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        // Newest 3: cp-4 (5000), cp-3 (4000), cp-2 (3000)
        expect(result.value[0]?.id).toBe("cp-4");
        expect(result.value[1]?.id).toBe("cp-3");
        expect(result.value[2]?.id).toBe("cp-2");
      }

      store.close();
    });

    test("recover after close/reopen returns complete plan", async () => {
      const dbPath = makeTempDbPath();
      const a1 = agentId("agent-1");
      const a2 = agentId("agent-2");

      // First session: populate
      const store1 = createSqliteSessionPersistence({ dbPath, maxCheckpointsPerAgent: 3 });
      await store1.saveSession({
        sessionId: sessionId("s1"),
        agentId: a1,
        manifestSnapshot: { name: "a1", version: "0.1.0", description: "d", model: { name: "m" } },
        seq: 1,
        remoteSeq: 0,
        connectedAt: 1000,
        lastCheckpointAt: 2000,
        metadata: {},
      });
      await store1.saveSession({
        sessionId: sessionId("s2"),
        agentId: a2,
        manifestSnapshot: { name: "a2", version: "0.1.0", description: "d", model: { name: "m" } },
        seq: 5,
        remoteSeq: 3,
        connectedAt: 1500,
        lastCheckpointAt: 2500,
        metadata: {},
      });
      await store1.saveCheckpoint({
        id: "cp1",
        agentId: a1,
        sessionId: sessionId("s1"),
        engineState: { engineId: "e1", data: "state-a1" },
        processState: "running",
        generation: 1,
        metadata: {},
        createdAt: 2000,
      });
      await store1.saveCheckpoint({
        id: "cp2",
        agentId: a2,
        sessionId: sessionId("s2"),
        engineState: { engineId: "e2", data: "state-a2" },
        processState: "waiting",
        generation: 2,
        metadata: {},
        createdAt: 2500,
      });
      store1.close();

      // Second session: recover
      const store2 = createSqliteSessionPersistence({ dbPath, maxCheckpointsPerAgent: 3 });
      const result = await store2.recover();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sessions.length).toBe(2);
        expect(result.value.checkpoints.size).toBe(2);
        expect(result.value.checkpoints.get(a1)?.engineState.data).toBe("state-a1");
        expect(result.value.checkpoints.get(a2)?.engineState.data).toBe("state-a2");
      }
      store2.close();
    });
  });
});
