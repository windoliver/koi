import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyRegistryMigrations } from "../schema.js";

function createDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

function tableNames(db: Database): readonly string[] {
  const rows = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  return rows.map((r) => r.name);
}

function virtualTableNames(db: Database): readonly string[] {
  // FTS5 creates shadow tables; check for the main FTS tables via sqlite_master
  const ftsRows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('bricks_fts', 'skills_fts') ORDER BY name",
    )
    .all();
  return ftsRows.map((r) => r.name);
}

function indexNames(db: Database): readonly string[] {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((r) => r.name);
}

function getUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

describe("applyRegistryMigrations", () => {
  test("creates all tables on fresh database", () => {
    const db = createDb();
    applyRegistryMigrations(db);

    const tables = tableNames(db);
    expect(tables).toContain("bricks");
    expect(tables).toContain("brick_tags");
    expect(tables).toContain("skills");
    expect(tables).toContain("skill_tags");
    expect(tables).toContain("skill_versions");
    expect(tables).toContain("versions");
  });

  test("creates FTS5 virtual tables", () => {
    const db = createDb();
    applyRegistryMigrations(db);

    const fts = virtualTableNames(db);
    expect(fts).toContain("bricks_fts");
    expect(fts).toContain("skills_fts");
  });

  test("creates expected indexes", () => {
    const db = createDb();
    applyRegistryMigrations(db);

    const indexes = indexNames(db);
    expect(indexes).toContain("idx_bricks_kind");
    expect(indexes).toContain("idx_bricks_cursor");
    expect(indexes).toContain("idx_brick_tags_tag");
    expect(indexes).toContain("idx_skills_cursor");
    expect(indexes).toContain("idx_skill_tags_tag");
    expect(indexes).toContain("idx_sv_skill_published");
    expect(indexes).toContain("idx_versions_lookup");
  });

  test("sets user_version to latest", () => {
    const db = createDb();
    applyRegistryMigrations(db);

    expect(getUserVersion(db)).toBe(2);
  });

  test("creates namespace column and index in V2", () => {
    const db = createDb();
    applyRegistryMigrations(db);

    const indexes = indexNames(db);
    expect(indexes).toContain("idx_bricks_namespace");
  });

  test("calling twice is idempotent", () => {
    const db = createDb();
    applyRegistryMigrations(db);
    applyRegistryMigrations(db);

    expect(getUserVersion(db)).toBe(2);
    const tables = tableNames(db);
    expect(tables).toContain("bricks");
    expect(tables).toContain("skills");
    expect(tables).toContain("versions");
  });

  test("skips migration when user_version is already current", () => {
    const db = createDb();
    db.exec("PRAGMA user_version = 2");

    // Should not throw even though tables don't exist
    applyRegistryMigrations(db);
    expect(getUserVersion(db)).toBe(2);
  });
});
