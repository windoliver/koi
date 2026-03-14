import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEventBackendContractTests } from "@koi/test-utils";
import { createSqliteEventBackend } from "./sqlite-backend.js";

// ---------------------------------------------------------------------------
// 1. Contract tests (in-memory database)
// ---------------------------------------------------------------------------

runEventBackendContractTests(() => createSqliteEventBackend({ db: new Database(":memory:") }));

// ---------------------------------------------------------------------------
// 2. Persistence tests (temp file)
// ---------------------------------------------------------------------------

describe("SQLite persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  function freshTmpDb(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "koi-events-sqlite-"));
    dbPath = join(tmpDir, "events.db");
    return dbPath;
  }

  afterEach(() => {
    if (tmpDir !== undefined && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("events persist across close/reopen", async () => {
    const path = freshTmpDb();

    // Write
    const backend1 = createSqliteEventBackend({ dbPath: path });
    await backend1.append("s", { type: "evt-1", data: { x: 1 } });
    await backend1.append("s", { type: "evt-2", data: { x: 2 } });
    backend1.close();

    // Read
    const backend2 = createSqliteEventBackend({ dbPath: path });
    const result = await backend2.read("s");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(2);
      expect(result.value.events[0]?.type).toBe("evt-1");
      expect(result.value.events[1]?.type).toBe("evt-2");
      expect(result.value.events[0]?.data).toEqual({ x: 1 });
    }
    backend2.close();
  });

  test("sequence continues after close/reopen", async () => {
    const path = freshTmpDb();

    const backend1 = createSqliteEventBackend({ dbPath: path });
    await backend1.append("s", { type: "a", data: 1 });
    await backend1.append("s", { type: "b", data: 2 });
    backend1.close();

    const backend2 = createSqliteEventBackend({ dbPath: path });
    const r = await backend2.append("s", { type: "c", data: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sequence).toBe(3);
    }
    backend2.close();
  });

  test("DLQ entries persist across close/reopen", async () => {
    const path = freshTmpDb();

    const backend1 = createSqliteEventBackend({ dbPath: path });
    backend1.subscribe({
      streamId: "s",
      subscriptionName: "sub-fail",
      fromPosition: 0,
      maxRetries: 1,
      handler: () => {
        throw new Error("persistent fail");
      },
    });

    await backend1.append("s", { type: "fail-evt", data: 1 });
    await Bun.sleep(100);
    backend1.close();

    const backend2 = createSqliteEventBackend({ dbPath: path });
    const dlq = await backend2.queryDeadLetters({ subscriptionName: "sub-fail" });
    expect(dlq.ok).toBe(true);
    if (dlq.ok) {
      expect(dlq.value.length).toBeGreaterThanOrEqual(1);
      expect(dlq.value[0]?.error).toContain("persistent fail");
    }
    backend2.close();
  });

  test("schema migration is idempotent", () => {
    const path = freshTmpDb();

    // Create twice — should not throw
    const backend1 = createSqliteEventBackend({ dbPath: path });
    backend1.close();
    const backend2 = createSqliteEventBackend({ dbPath: path });
    backend2.close();
  });

  test("PRAGMA integrity_check passes", () => {
    const path = freshTmpDb();
    const backend = createSqliteEventBackend({ dbPath: path });

    const db = new Database(path, { readonly: true });
    const result = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
    expect(result?.integrity_check).toBe("ok");
    db.close();

    backend.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Transaction isolation tests
// ---------------------------------------------------------------------------

describe("SQLite transaction isolation", () => {
  test("sequential appends with expectedSequence both succeed", async () => {
    const backend = createSqliteEventBackend({ db: new Database(":memory:") });

    const r1 = await backend.append("s", {
      type: "evt-1",
      data: 1,
      expectedSequence: 0,
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.value.sequence).toBe(1);
    }

    const r2 = await backend.append("s", {
      type: "evt-2",
      data: 2,
      expectedSequence: 1,
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.sequence).toBe(2);
    }

    backend.close();
  });

  test("sequential appends without expectedSequence produce monotonic sequences", async () => {
    const backend = createSqliteEventBackend({ db: new Database(":memory:") });
    const sequences: number[] = [];

    for (let i = 0; i < 10; i++) {
      const r = await backend.append("s", { type: "evt", data: i });
      expect(r.ok).toBe(true);
      if (r.ok) {
        sequences.push(r.value.sequence);
      }
    }

    // Verify monotonically increasing with no gaps and no duplicates
    expect(sequences).toHaveLength(10);
    for (let i = 0; i < sequences.length; i++) {
      expect(sequences[i]).toBe(i + 1);
    }

    // Verify stream length matches
    const len = await backend.streamLength("s");
    expect(len).toBe(10);

    backend.close();
  });

  test("expectedSequence conflict returns error without corrupting stream", async () => {
    const backend = createSqliteEventBackend({ db: new Database(":memory:") });

    const r1 = await backend.append("s", { type: "evt-1", data: 1 });
    expect(r1.ok).toBe(true);

    // Attempt with stale expectedSequence (0 instead of 1)
    const r2 = await backend.append("s", {
      type: "evt-conflict",
      data: 2,
      expectedSequence: 0,
    });
    expect(r2.ok).toBe(false);

    // Stream is still consistent — next append with correct sequence works
    const r3 = await backend.append("s", {
      type: "evt-2",
      data: 3,
      expectedSequence: 1,
    });
    expect(r3.ok).toBe(true);
    if (r3.ok) {
      expect(r3.value.sequence).toBe(2);
    }

    backend.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Eviction tests
// ---------------------------------------------------------------------------

describe("SQLite eviction", () => {
  test("streamLength capped at maxEventsPerStream after excess appends", async () => {
    const backend = createSqliteEventBackend({
      db: new Database(":memory:"),
      maxEventsPerStream: 5,
    });

    for (let i = 1; i <= 8; i++) {
      await backend.append("s", { type: "evt", data: i });
    }

    const len = await backend.streamLength("s");
    expect(len).toBe(5);
  });

  test("firstSequence reflects eviction", async () => {
    const backend = createSqliteEventBackend({
      db: new Database(":memory:"),
      maxEventsPerStream: 5,
    });

    for (let i = 1; i <= 8; i++) {
      await backend.append("s", { type: "evt", data: i });
    }

    const first = await backend.firstSequence("s");
    // After appending 8 with cap 5, the first 3 are evicted. First available = 4.
    expect(first).toBe(4);
  });

  test("evicted events excluded from reads", async () => {
    const backend = createSqliteEventBackend({
      db: new Database(":memory:"),
      maxEventsPerStream: 5,
    });

    for (let i = 1; i <= 8; i++) {
      await backend.append("s", { type: "evt", data: i });
    }

    const result = await backend.read("s");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toHaveLength(5);
      // Events 1-3 evicted, remaining are 4-8
      expect(result.value.events[0]?.sequence).toBe(4);
      expect(result.value.events[4]?.sequence).toBe(8);
    }
  });

  test("subscription replay starts from available events after eviction", async () => {
    const backend = createSqliteEventBackend({
      db: new Database(":memory:"),
      maxEventsPerStream: 5,
    });

    for (let i = 1; i <= 8; i++) {
      await backend.append("s", { type: "evt", data: i });
    }

    const received: number[] = [];
    const handle = await backend.subscribe({
      streamId: "s",
      subscriptionName: "sub-evict",
      fromPosition: 0,
      handler: (evt) => {
        received.push(evt.sequence);
      },
    });

    await Bun.sleep(100);

    // Should only receive events 4-8 (events 1-3 were evicted)
    expect(received).toHaveLength(5);
    expect(received[0]).toBe(4);
    expect(received[4]).toBe(8);

    handle.unsubscribe();
  });
});
