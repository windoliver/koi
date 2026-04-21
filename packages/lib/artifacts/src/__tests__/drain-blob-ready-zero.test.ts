/**
 * `drainBlobReadyZero` — spec §6.5 step 4a.
 *
 * Coverage:
 *   - blob present → row promoted (blob_ready 0→1), stats.promoted=1
 *   - blob absent below budget → repair_attempts incremented, row still 0
 *   - blob absent at budget → row deleted + tombstone inserted atomically
 *   - has() throws (transient) → repair_attempts NOT bumped, row untouched
 *   - terminal-delete atomicity: both artifacts row AND tombstone land together
 *   - save's own repair wins the race: save UPDATEd to blob_ready=1 after SELECT
 *     snapshot, worker's UPDATE matches 0 rows (predicate `AND blob_ready = 0`),
 *     stats.promoted=0 (no double-promote)
 *   - empty store → stats all zero, no queries past the SELECT
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BlobStore } from "@koi/blob-cas";
import { artifactId, sessionId } from "@koi/core";
import { drainBlobReadyZero } from "../drain-blob-ready-zero.js";
import { ALL_DDL } from "../schema.js";
import type { ArtifactStoreEvent } from "../types.js";

interface ArtifactRow {
  readonly id: string;
  readonly content_hash: string;
  readonly blob_ready: number;
  readonly repair_attempts: number;
}

interface TombstoneRow {
  readonly hash: string;
  readonly enqueued_at: number;
}

function makeDb(): Database {
  const db = new Database(":memory:");
  for (const ddl of ALL_DDL) db.exec(ddl);
  return db;
}

function insertArtifact(
  db: Database,
  args: {
    readonly id: string;
    readonly name: string;
    readonly hash: string;
    readonly blobReady: 0 | 1;
    readonly repairAttempts?: number;
    readonly sessionId?: string;
    readonly version?: number;
  },
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO artifacts
       (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready, repair_attempts)
     VALUES (?, ?, ?, ?, 'text/plain', 4, ?, '[]', ?, NULL, ?, ?)`,
  ).run(
    args.id,
    args.sessionId ?? "sess_a",
    args.name,
    args.version ?? 1,
    args.hash,
    now,
    args.blobReady,
    args.repairAttempts ?? 0,
  );
}

function getRow(db: Database, id: string): ArtifactRow | null {
  return db
    .query("SELECT id, content_hash, blob_ready, repair_attempts FROM artifacts WHERE id = ?")
    .get(id) as ArtifactRow | null;
}

function getTombstone(db: Database, hash: string): TombstoneRow | null {
  return db
    .query("SELECT hash, enqueued_at FROM pending_blob_deletes WHERE hash = ?")
    .get(hash) as TombstoneRow | null;
}

/** Build a mock BlobStore where only `has` matters; other methods throw. */
function mockBlobStoreHas(impl: (hash: string) => Promise<boolean>): BlobStore {
  return {
    put: async () => {
      throw new Error("mock: put not expected");
    },
    get: async () => {
      throw new Error("mock: get not expected");
    },
    has: impl,
    delete: async () => {
      throw new Error("mock: delete not expected");
    },
    list: () => {
      throw new Error("mock: list not expected");
    },
  };
}

describe("drainBlobReadyZero", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  test("blob present → row promoted to blob_ready=1, stats.promoted=1", async () => {
    const hash = "a".repeat(64);
    insertArtifact(db, { id: "art_1", name: "f.txt", hash, blobReady: 0 });

    const blobStore = mockBlobStoreHas(async () => true);
    const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 10 });

    expect(stats).toEqual({ promoted: 1, terminallyDeleted: 0, transientErrors: 0 });
    const row = getRow(db, "art_1");
    expect(row?.blob_ready).toBe(1);
    expect(row?.repair_attempts).toBe(0);
    expect(getTombstone(db, hash)).toBeNull();
  });

  test("blob absent below budget → repair_attempts incremented, row stays at 0", async () => {
    const hash = "b".repeat(64);
    insertArtifact(db, {
      id: "art_2",
      name: "f.txt",
      hash,
      blobReady: 0,
      repairAttempts: 3,
    });

    const blobStore = mockBlobStoreHas(async () => false);
    const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 10 });

    expect(stats).toEqual({ promoted: 0, terminallyDeleted: 0, transientErrors: 0 });
    const row = getRow(db, "art_2");
    expect(row).not.toBeNull();
    expect(row?.blob_ready).toBe(0);
    expect(row?.repair_attempts).toBe(4);
    // Row is NOT tombstoned.
    expect(getTombstone(db, hash)).toBeNull();
  });

  test("blob absent at-or-above budget → row deleted + tombstone inserted atomically", async () => {
    const hash = "c".repeat(64);
    // repair_attempts=9, budget=10 → increment to 10, trigger terminal.
    insertArtifact(db, {
      id: "art_3",
      name: "f.txt",
      hash,
      blobReady: 0,
      repairAttempts: 9,
    });

    const blobStore = mockBlobStoreHas(async () => false);
    const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 10 });

    expect(stats).toEqual({ promoted: 0, terminallyDeleted: 1, transientErrors: 0 });
    expect(getRow(db, "art_3")).toBeNull();
    const tomb = getTombstone(db, hash);
    expect(tomb).not.toBeNull();
    expect(tomb?.hash).toBe(hash);
  });

  test("blobStore.has throws → repair_attempts NOT incremented, row stays at 0", async () => {
    const hash = "d".repeat(64);
    insertArtifact(db, {
      id: "art_4",
      name: "f.txt",
      hash,
      blobReady: 0,
      repairAttempts: 2,
    });

    const blobStore = mockBlobStoreHas(async () => {
      throw new Error("network timeout");
    });
    const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 10 });

    expect(stats).toEqual({ promoted: 0, terminallyDeleted: 0, transientErrors: 1 });
    const row = getRow(db, "art_4");
    expect(row?.blob_ready).toBe(0);
    expect(row?.repair_attempts).toBe(2); // unchanged — transient failure does not consume budget
    expect(getTombstone(db, hash)).toBeNull();
  });

  test("terminal-delete atomicity: artifacts row gone AND tombstone present", async () => {
    // Drive a single row from 0 repair_attempts to terminal with budget=1 so
    // it happens in a single pass. Then verify both sides of the atomic tx
    // landed: the row is gone AND the tombstone exists.
    const hash = "e".repeat(64);
    insertArtifact(db, {
      id: "art_5",
      name: "f.txt",
      hash,
      blobReady: 0,
      repairAttempts: 0,
    });

    const blobStore = mockBlobStoreHas(async () => false);
    const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 1 });

    expect(stats).toEqual({ promoted: 0, terminallyDeleted: 1, transientErrors: 0 });
    // Both sides of the transaction must be visible.
    expect(getRow(db, "art_5")).toBeNull();
    expect(getTombstone(db, hash)).not.toBeNull();
  });

  test("concurrent save's own repair races worker — save promoted first, worker sees 0 rows", async () => {
    // Model the spec §6.5 step 4a race: the SELECT snapshot picks up the
    // blob_ready=0 row, but by the time `has()` returns, the save's own
    // post-commit repair has already UPDATEd the row to blob_ready=1 (it
    // had its put() succeed and ran its own `UPDATE ... WHERE ... AND
    // blob_ready = 0` before the worker). The worker's UPDATE predicate
    // `AND blob_ready = 0` must match 0 rows, preventing double-promotion.
    //
    // We simulate the save-wins race by flipping blob_ready to 1 inside
    // the mock `has()` BEFORE returning true. The worker's UPDATE then
    // sees blob_ready=1 and matches nothing.
    const hash = "f".repeat(64);
    insertArtifact(db, { id: "art_6", name: "f.txt", hash, blobReady: 0 });

    const blobStore = mockBlobStoreHas(async () => {
      // Concurrent save's own post-commit repair wins.
      db.query("UPDATE artifacts SET blob_ready = 1 WHERE id = 'art_6'").run();
      return true;
    });

    const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 10 });

    // Worker's UPDATE hit 0 rows — not counted as a promotion.
    expect(stats).toEqual({ promoted: 0, terminallyDeleted: 0, transientErrors: 0 });
    const row = getRow(db, "art_6");
    // Row is now blob_ready=1 (from the save, not from the worker) — no corruption.
    expect(row?.blob_ready).toBe(1);
  });

  test("empty store (no blob_ready=0 rows) → stats all zero, blobStore untouched", async () => {
    // Seed only blob_ready=1 rows. The SELECT must yield empty set and the
    // mock BlobStore must never be called (its `has` throws to catch misuse).
    insertArtifact(db, { id: "art_7", name: "f.txt", hash: "7".repeat(64), blobReady: 1 });

    let hasCalled = 0;
    const blobStore = mockBlobStoreHas(async () => {
      hasCalled++;
      throw new Error("has should not be called when no blob_ready=0 rows");
    });

    const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 10 });

    expect(stats).toEqual({ promoted: 0, terminallyDeleted: 0, transientErrors: 0 });
    expect(hasCalled).toBe(0);
  });

  test("handles many rows in one pass — mix of present / absent-below / absent-terminal / transient", async () => {
    // Sanity: one pass processes every blob_ready=0 row and sums stats correctly.
    insertArtifact(db, {
      id: "art_present",
      name: "a.txt",
      hash: "1".repeat(64),
      blobReady: 0,
    });
    insertArtifact(db, {
      id: "art_absent_low",
      name: "b.txt",
      hash: "2".repeat(64),
      blobReady: 0,
      repairAttempts: 1,
    });
    insertArtifact(db, {
      id: "art_terminal",
      name: "c.txt",
      hash: "3".repeat(64),
      blobReady: 0,
      repairAttempts: 9, // budget 10 → bump to 10 → terminal
    });
    insertArtifact(db, {
      id: "art_transient",
      name: "d.txt",
      hash: "4".repeat(64),
      blobReady: 0,
      repairAttempts: 2,
    });

    const blobStore: BlobStore = {
      put: async () => {
        throw new Error("mock: put not expected");
      },
      get: async () => {
        throw new Error("mock: get not expected");
      },
      has: async (h) => {
        if (h === "1".repeat(64)) return true;
        if (h === "2".repeat(64)) return false;
        if (h === "3".repeat(64)) return false;
        if (h === "4".repeat(64)) throw new Error("transient");
        throw new Error(`unexpected hash: ${h}`);
      },
      delete: async () => {
        throw new Error("mock: delete not expected");
      },
      list: () => {
        throw new Error("mock: list not expected");
      },
    };

    const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 10 });

    expect(stats).toEqual({ promoted: 1, terminallyDeleted: 1, transientErrors: 1 });
    expect(getRow(db, "art_present")?.blob_ready).toBe(1);
    expect(getRow(db, "art_absent_low")?.repair_attempts).toBe(2);
    expect(getRow(db, "art_absent_low")?.blob_ready).toBe(0);
    expect(getRow(db, "art_terminal")).toBeNull();
    expect(getTombstone(db, "3".repeat(64))).not.toBeNull();
    expect(getRow(db, "art_transient")?.repair_attempts).toBe(2); // unchanged
    expect(getRow(db, "art_transient")?.blob_ready).toBe(0);
  });

  describe("onEvent hook (structured drift signal)", () => {
    test("fires repair_exhausted with correct fields when budget exhausted", async () => {
      // Budget=1, repair_attempts starts at 0 → one absent probe hits the
      // terminal-delete threshold. Row must be SELECTed with session_id so
      // the event carries the owning session — operators route drift alerts
      // by session, not artifact id.
      const hash = "e".repeat(64);
      insertArtifact(db, {
        id: "art_terminal",
        name: "f.txt",
        hash,
        blobReady: 0,
        repairAttempts: 0,
        sessionId: "sess_operator_pager",
      });
      const blobStore = mockBlobStoreHas(async () => false);
      const events: Array<ArtifactStoreEvent> = [];

      const stats = await drainBlobReadyZero({
        db,
        blobStore,
        maxRepairAttempts: 1,
        onEvent: (e) => events.push(e),
      });

      expect(stats).toEqual({ promoted: 0, terminallyDeleted: 1, transientErrors: 0 });
      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev).toBeDefined();
      if (ev === undefined) throw new Error("unreachable: asserted above");
      expect(ev.kind).toBe("repair_exhausted");
      if (ev.kind !== "repair_exhausted") throw new Error("kind narrowing");
      expect(ev.artifactId).toBe(artifactId("art_terminal"));
      expect(ev.contentHash).toBe(hash);
      expect(ev.sessionId).toBe(sessionId("sess_operator_pager"));
      expect(ev.attempts).toBe(1);
    });

    test("fires transient_repair_error with raw throwable when has() throws", async () => {
      const hash = "a".repeat(64);
      insertArtifact(db, { id: "art_transient", name: "f.txt", hash, blobReady: 0 });
      const boom = new Error("s3 5xx");
      const blobStore = mockBlobStoreHas(async () => {
        throw boom;
      });
      const events: Array<ArtifactStoreEvent> = [];

      const stats = await drainBlobReadyZero({
        db,
        blobStore,
        maxRepairAttempts: 10,
        onEvent: (e) => events.push(e),
      });

      expect(stats).toEqual({ promoted: 0, terminallyDeleted: 0, transientErrors: 1 });
      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev).toBeDefined();
      if (ev === undefined) throw new Error("unreachable: asserted above");
      expect(ev.kind).toBe("transient_repair_error");
      if (ev.kind !== "transient_repair_error") throw new Error("kind narrowing");
      expect(ev.artifactId).toBe(artifactId("art_transient"));
      expect(ev.contentHash).toBe(hash);
      // Raw throwable preserved — operators inspect the original error.
      expect(ev.error).toBe(boom);
    });

    test("no events when repair succeeds: promote and below-budget increment are silent", async () => {
      // Promote path.
      insertArtifact(db, {
        id: "art_present",
        name: "a.txt",
        hash: "1".repeat(64),
        blobReady: 0,
      });
      // Below-budget increment path.
      insertArtifact(db, {
        id: "art_below",
        name: "b.txt",
        hash: "2".repeat(64),
        blobReady: 0,
        repairAttempts: 1,
      });
      const blobStore: BlobStore = {
        put: async () => {
          throw new Error("mock: put not expected");
        },
        get: async () => {
          throw new Error("mock: get not expected");
        },
        has: async (h) => {
          if (h === "1".repeat(64)) return true;
          if (h === "2".repeat(64)) return false;
          throw new Error(`unexpected hash: ${h}`);
        },
        delete: async () => {
          throw new Error("mock: delete not expected");
        },
        list: () => {
          throw new Error("mock: list not expected");
        },
      };
      const events: Array<ArtifactStoreEvent> = [];

      const stats = await drainBlobReadyZero({
        db,
        blobStore,
        maxRepairAttempts: 10,
        onEvent: (e) => events.push(e),
      });

      expect(stats).toEqual({ promoted: 1, terminallyDeleted: 0, transientErrors: 0 });
      // Silent: below-budget is expected behavior, not drift.
      expect(events).toHaveLength(0);
    });

    test("omitting onEvent is a no-op — drain still completes normally", async () => {
      const hash = "c".repeat(64);
      insertArtifact(db, {
        id: "art_terminal",
        name: "f.txt",
        hash,
        blobReady: 0,
        repairAttempts: 0,
      });
      const blobStore = mockBlobStoreHas(async () => false);

      // No onEvent passed — must not throw.
      const stats = await drainBlobReadyZero({ db, blobStore, maxRepairAttempts: 1 });

      expect(stats).toEqual({ promoted: 0, terminallyDeleted: 1, transientErrors: 0 });
      expect(getRow(db, "art_terminal")).toBeNull();
      expect(getTombstone(db, hash)).not.toBeNull();
    });

    test("onEvent throwing does NOT abort the drain — remaining rows still processed", async () => {
      // Two rows that would each produce an event. First callback throws —
      // the second row must still be processed and its event still delivered.
      insertArtifact(db, {
        id: "art_first",
        name: "a.txt",
        hash: "1".repeat(64),
        blobReady: 0,
        repairAttempts: 0,
      });
      insertArtifact(db, {
        id: "art_second",
        name: "b.txt",
        hash: "2".repeat(64),
        blobReady: 0,
        repairAttempts: 0,
      });
      const blobStore = mockBlobStoreHas(async () => false);
      const seen: Array<ArtifactStoreEvent> = [];
      let firstCall = true;

      const stats = await drainBlobReadyZero({
        db,
        blobStore,
        maxRepairAttempts: 1,
        onEvent: (e) => {
          seen.push(e);
          if (firstCall) {
            firstCall = false;
            throw new Error("callback exploded");
          }
        },
      });

      // Both rows terminally deleted despite first callback throwing.
      expect(stats).toEqual({ promoted: 0, terminallyDeleted: 2, transientErrors: 0 });
      expect(seen).toHaveLength(2);
      expect(getRow(db, "art_first")).toBeNull();
      expect(getRow(db, "art_second")).toBeNull();
    });
  });
});
