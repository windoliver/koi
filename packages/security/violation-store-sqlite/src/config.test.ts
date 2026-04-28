import { describe, expect, test } from "bun:test";
import { validateSqliteViolationStoreConfig } from "./config.js";

describe("validateSqliteViolationStoreConfig", () => {
  test("accepts minimal config", () => {
    const result = validateSqliteViolationStoreConfig({ dbPath: "/tmp/v.db" });
    expect(result.ok).toBe(true);
  });

  test("accepts :memory: dbPath", () => {
    const result = validateSqliteViolationStoreConfig({ dbPath: ":memory:" });
    expect(result.ok).toBe(true);
  });

  test("accepts full config", () => {
    const result = validateSqliteViolationStoreConfig({
      dbPath: "/tmp/v.db",
      flushIntervalMs: 1000,
      maxBufferSize: 50,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null", () => {
    const result = validateSqliteViolationStoreConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects missing dbPath", () => {
    const result = validateSqliteViolationStoreConfig({});
    expect(result.ok).toBe(false);
  });

  test("rejects empty dbPath", () => {
    const result = validateSqliteViolationStoreConfig({ dbPath: "" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-positive flushIntervalMs", () => {
    const result = validateSqliteViolationStoreConfig({
      dbPath: "/tmp/v.db",
      flushIntervalMs: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-positive maxBufferSize", () => {
    const result = validateSqliteViolationStoreConfig({
      dbPath: "/tmp/v.db",
      maxBufferSize: -1,
    });
    expect(result.ok).toBe(false);
  });
});
