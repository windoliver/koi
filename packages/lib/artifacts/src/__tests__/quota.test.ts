import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@koi/core";
import { readSessionBytes } from "../quota.js";
import { ALL_DDL } from "../schema.js";

describe("readSessionBytes", () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = join(tmpdir(), `koi-quota-${crypto.randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    db = new Database(join(dir, "store.db"));
    for (const ddl of ALL_DDL) db.exec(ddl);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertRow(opts: {
    readonly id: string;
    readonly sessionId: string;
    readonly name: string;
    readonly version: number;
    readonly size: number;
    readonly blobReady: 0 | 1;
  }): void {
    db.query(
      `INSERT INTO artifacts
         (id, session_id, name, version, mime_type, size, content_hash, tags, created_at, expires_at, blob_ready)
       VALUES (?, ?, ?, ?, 'text/plain', ?, 'hash_placeholder', '[]', ?, NULL, ?)`,
    ).run(opts.id, opts.sessionId, opts.name, opts.version, opts.size, Date.now(), opts.blobReady);
  }

  test("returns 0 for a session with no artifacts", () => {
    expect(readSessionBytes(db, sessionId("sess_empty"))).toBe(0);
  });

  test("sums size across committed rows of a session", () => {
    insertRow({ id: "a1", sessionId: "sess_a", name: "x", version: 1, size: 100, blobReady: 1 });
    insertRow({ id: "a2", sessionId: "sess_a", name: "y", version: 1, size: 250, blobReady: 1 });
    insertRow({ id: "a3", sessionId: "sess_a", name: "z", version: 1, size: 50, blobReady: 1 });
    expect(readSessionBytes(db, sessionId("sess_a"))).toBe(400);
  });

  test("excludes blob_ready=0 rows from the total", () => {
    insertRow({ id: "a1", sessionId: "sess_a", name: "ok", version: 1, size: 100, blobReady: 1 });
    insertRow({
      id: "a2",
      sessionId: "sess_a",
      name: "in-flight",
      version: 1,
      size: 999,
      blobReady: 0,
    });
    expect(readSessionBytes(db, sessionId("sess_a"))).toBe(100);
  });

  test("scopes total to the requested session", () => {
    insertRow({ id: "a1", sessionId: "sess_a", name: "x", version: 1, size: 100, blobReady: 1 });
    insertRow({ id: "b1", sessionId: "sess_b", name: "x", version: 1, size: 200, blobReady: 1 });
    expect(readSessionBytes(db, sessionId("sess_a"))).toBe(100);
    expect(readSessionBytes(db, sessionId("sess_b"))).toBe(200);
  });
});
