import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sqliteCompositionExecutionLog } from "./composition-execution-log-sqlite.js";

describe("sqliteCompositionExecutionLog", () => {
  test("first claim returns 'claimed' and persists pending row", () => {
    const db = new Database(":memory:");
    const log = sqliteCompositionExecutionLog(db);
    const result = log.claim("k1");
    expect(result).toEqual({ kind: "claimed" });
  });

  test("second claim on same key (no record) returns 'pending'", () => {
    const db = new Database(":memory:");
    const log = sqliteCompositionExecutionLog(db);
    log.claim("k1");
    const result = log.claim("k1");
    expect(result).toEqual({ kind: "pending" });
  });

  test("after record(), claim returns 'complete' with stored output", () => {
    const db = new Database(":memory:");
    const log = sqliteCompositionExecutionLog(db);
    log.claim("k1");
    log.record("k1", { taskId: "t-1", count: 3 });
    const result = log.claim("k1");
    expect(result).toEqual({ kind: "complete", output: { taskId: "t-1", count: 3 } });
  });

  test("release() removes pending claim so next claim() wins again", () => {
    const db = new Database(":memory:");
    const log = sqliteCompositionExecutionLog(db);
    log.claim("k1");
    log.release("k1");
    const result = log.claim("k1");
    expect(result).toEqual({ kind: "claimed" });
  });

  test("survives across log instances on the same db (restart simulation)", () => {
    const db = new Database(":memory:");
    const log1 = sqliteCompositionExecutionLog(db);
    log1.claim("k1");
    log1.record("k1", "payload-x");

    // Simulate process restart: new log instance, same db handle.
    const log2 = sqliteCompositionExecutionLog(db);
    const result = log2.claim("k1");
    expect(result).toEqual({ kind: "complete", output: "payload-x" });
  });

  test("rejects invalid table names to prevent SQL injection", () => {
    const db = new Database(":memory:");
    expect(() =>
      sqliteCompositionExecutionLog(db, { tableName: "drop; DROP TABLE users; --" }),
    ).toThrow(/invalid tableName/u);
  });

  test("record(undefined) round-trips as null output", () => {
    const db = new Database(":memory:");
    const log = sqliteCompositionExecutionLog(db);
    log.claim("k1");
    log.record("k1", undefined);
    expect(log.claim("k1")).toEqual({ kind: "complete", output: null });
  });
});
