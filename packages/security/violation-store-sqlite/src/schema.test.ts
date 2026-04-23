import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initViolationSchema } from "./schema.js";

describe("violations schema", () => {
  test("creates the violations table with required columns", () => {
    const db = new Database(":memory:");
    initViolationSchema(db);
    const cols = db.prepare("PRAGMA table_info('violations')").all() as readonly {
      readonly name: string;
    }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("timestamp");
    expect(names).toContain("rule");
    expect(names).toContain("severity");
    expect(names).toContain("message");
    expect(names).toContain("context_json");
    expect(names).toContain("agent_id");
    expect(names).toContain("session_id");
  });

  test("creates all three indexes", () => {
    const db = new Database(":memory:");
    initViolationSchema(db);
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='violations'")
      .all() as readonly { readonly name: string }[];
    const names = idx.map((i) => i.name);
    expect(names).toContain("idx_violations_ts");
    expect(names).toContain("idx_violations_agent_ts");
    expect(names).toContain("idx_violations_sev_ts");
  });

  test("initViolationSchema is idempotent", () => {
    const db = new Database(":memory:");
    initViolationSchema(db);
    initViolationSchema(db); // second call must not throw
  });

  test("source file is append-only (no UPDATE/DELETE against violations)", () => {
    const src = readFileSync(new URL("./schema.ts", import.meta.url), "utf-8");
    const storeSrc = readFileSync(new URL("./sqlite-store.ts", import.meta.url), "utf-8");
    for (const file of [src, storeSrc]) {
      expect(file.toLowerCase()).not.toContain("update violations");
      expect(file.toLowerCase()).not.toContain("delete from violations");
    }
  });
});
