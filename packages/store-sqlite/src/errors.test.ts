import { describe, expect, test } from "bun:test";
import { mapSqliteError, wrapSqlite } from "./errors.js";

describe("mapSqliteError", () => {
  test("maps UNIQUE constraint to CONFLICT", () => {
    const error = new Error("UNIQUE constraint failed: bricks.id");
    const result = mapSqliteError(error, "save(brick_1)");
    expect(result.code).toBe("CONFLICT");
    expect(result.retryable).toBe(true);
  });

  test("maps SQLITE_CONSTRAINT to CONFLICT", () => {
    const error = new Error("SQLITE_CONSTRAINT: constraint failed");
    const result = mapSqliteError(error, "insert");
    expect(result.code).toBe("CONFLICT");
  });

  test("maps SQLITE_CONSTRAINT_UNIQUE to CONFLICT", () => {
    const error = new Error("SQLITE_CONSTRAINT_UNIQUE: bricks.id");
    const result = mapSqliteError(error, "save");
    expect(result.code).toBe("CONFLICT");
  });

  test("maps PRIMARY KEY constraint to CONFLICT", () => {
    const error = new Error("PRIMARY KEY constraint failed");
    const result = mapSqliteError(error, "insert");
    expect(result.code).toBe("CONFLICT");
    expect(result.retryable).toBe(true);
  });

  test("maps database is locked to TIMEOUT", () => {
    const error = new Error("database is locked");
    const result = mapSqliteError(error, "save");
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
  });

  test("maps SQLITE_BUSY to TIMEOUT", () => {
    const error = new Error("SQLITE_BUSY: unable to acquire lock");
    const result = mapSqliteError(error, "update");
    expect(result.code).toBe("TIMEOUT");
  });

  test("maps SQLITE_READONLY to PERMISSION", () => {
    const error = new Error("SQLITE_READONLY: attempt to write");
    const result = mapSqliteError(error, "save");
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
  });

  test("maps readonly database to PERMISSION", () => {
    const error = new Error("readonly database: cannot write");
    const result = mapSqliteError(error, "update");
    expect(result.code).toBe("PERMISSION");
  });

  test("maps SQLITE_CORRUPT to INTERNAL", () => {
    const error = new Error("SQLITE_CORRUPT: database disk image is malformed");
    const result = mapSqliteError(error, "load");
    expect(result.code).toBe("INTERNAL");
    expect(result.cause).toBe(error);
  });

  test("maps database disk image to INTERNAL", () => {
    const error = new Error("database disk image is malformed");
    const result = mapSqliteError(error, "query");
    expect(result.code).toBe("INTERNAL");
  });

  test("maps SQLITE_CANTOPEN to NOT_FOUND", () => {
    const error = new Error("SQLITE_CANTOPEN: unable to open database file");
    const result = mapSqliteError(error, "open");
    expect(result.code).toBe("NOT_FOUND");
    expect(result.retryable).toBe(false);
  });

  test("maps SQLITE_FULL to INTERNAL", () => {
    const error = new Error("SQLITE_FULL: database or disk is full");
    const result = mapSqliteError(error, "insert");
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("maps SQLITE_IOERR to INTERNAL", () => {
    const error = new Error("SQLITE_IOERR: disk I/O error");
    const result = mapSqliteError(error, "write");
    expect(result.code).toBe("INTERNAL");
  });

  test("maps SQLITE_NOTADB to INTERNAL", () => {
    const error = new Error("SQLITE_NOTADB: file is not a database");
    const result = mapSqliteError(error, "open");
    expect(result.code).toBe("INTERNAL");
  });

  test("maps unknown error to INTERNAL", () => {
    const error = new Error("something unexpected");
    const result = mapSqliteError(error, "operation");
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toContain("operation");
    expect(result.message).toContain("something unexpected");
  });

  test("handles non-Error value", () => {
    const result = mapSqliteError("string error", "ctx");
    expect(result.code).toBe("INTERNAL");
    expect(result.message).toContain("string error");
  });

  test("includes operation context", () => {
    const error = new Error("UNIQUE constraint failed");
    const result = mapSqliteError(error, "save(brick_1)");
    expect(result.context).toEqual({ operation: "save(brick_1)" });
  });
});

describe("wrapSqlite", () => {
  test("returns ok: true on success", () => {
    const result = wrapSqlite(() => 42, "test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  test("returns ok: false on throw", () => {
    const result = wrapSqlite(() => {
      throw new Error("UNIQUE constraint failed");
    }, "insert");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });
});
