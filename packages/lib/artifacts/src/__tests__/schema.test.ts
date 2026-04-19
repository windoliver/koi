import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ALL_DDL } from "../schema.js";
import { openDatabase } from "../sqlite.js";

describe("schema", () => {
  test("all DDL applies cleanly to a fresh in-memory DB", () => {
    const db = openDatabase({ dbPath: ":memory:" });
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as ReadonlyArray<{ readonly name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("artifacts");
    expect(names).toContain("artifact_shares");
    expect(names).toContain("pending_blob_deletes");
    expect(names).toContain("pending_blob_puts");
    expect(names).toContain("meta");
    db.close();
  });

  test("applying DDL twice is idempotent (CREATE TABLE IF NOT EXISTS)", () => {
    const db = new Database(":memory:");
    for (const ddl of ALL_DDL) db.exec(ddl);
    for (const ddl of ALL_DDL) db.exec(ddl);
    db.close();
  });

  test("foreign_keys enabled", () => {
    const db = openDatabase({ dbPath: ":memory:" });
    const fk = db.query("PRAGMA foreign_keys").get() as {
      readonly foreign_keys: number;
    };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });

  test("durability='os' sets synchronous=FULL", () => {
    const db = openDatabase({ dbPath: ":memory:", durability: "os" });
    const sync = db.query("PRAGMA synchronous").get() as {
      readonly synchronous: number;
    };
    expect(sync.synchronous).toBe(2);
    db.close();
  });

  test("CASCADE drops shares when the artifact is deleted", () => {
    const db = openDatabase({ dbPath: ":memory:" });
    db.exec(
      "INSERT INTO artifacts (id, session_id, name, version, mime_type, size, content_hash, created_at) VALUES ('art_1', 'sess_a', 'n', 1, 'text/plain', 5, 'deadbeef', 0)",
    );
    db.exec(
      "INSERT INTO artifact_shares (artifact_id, granted_to_session_id, granted_at) VALUES ('art_1', 'sess_b', 0)",
    );
    db.exec("DELETE FROM artifacts WHERE id = 'art_1'");
    const count = db.query("SELECT COUNT(*) as c FROM artifact_shares").get() as {
      readonly c: number;
    };
    expect(count.c).toBe(0);
    db.close();
  });
});
