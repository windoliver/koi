import { describe, expect, test } from "bun:test";
import { reduce } from "./store.js";
import type { LogEntry } from "./types.js";
import { createInitialState, MAX_LOG_BUFFER } from "./types.js";

describe("service reducer via store", () => {
  const base = createInitialState("http://localhost:3100/admin/api");

  test("append_log adds entry", () => {
    const entry: LogEntry = {
      level: "info",
      source: "test",
      message: "hello",
      timestamp: 1000,
    };
    const result = reduce(base, { kind: "append_log", entry });
    expect(result.logBuffer).toHaveLength(1);
    expect(result.logBuffer[0]).toEqual(entry);
  });

  test("append_log caps at MAX_LOG_BUFFER", () => {
    let state = base;
    for (let i = 0; i < MAX_LOG_BUFFER + 10; i++) {
      state = reduce(state, {
        kind: "append_log",
        entry: { level: "info", source: "test", message: `msg-${String(i)}`, timestamp: i },
      });
    }
    expect(state.logBuffer.length).toBe(MAX_LOG_BUFFER);
    // Oldest entries should be evicted
    expect(state.logBuffer[0]?.message).toBe("msg-10");
  });

  test("set_log_level updates level", () => {
    const result = reduce(base, { kind: "set_log_level", level: "error" });
    expect(result.logLevel).toBe("error");
  });

  test("clear_logs empties buffer", () => {
    let state = reduce(base, {
      kind: "append_log",
      entry: { level: "info", source: "a", message: "b", timestamp: 1 },
    });
    state = reduce(state, { kind: "clear_logs" });
    expect(state.logBuffer).toEqual([]);
  });

  test("set_service_status updates status", () => {
    const status = {
      status: "running",
      uptimeMs: 5000,
      subsystems: { admin: { status: "ready" } },
      ports: [{ port: 3100, service: "admin", status: "listening" }],
    };
    const result = reduce(base, { kind: "set_service_status", status });
    expect(result.serviceStatus).toEqual(status);
  });

  test("set_service_status to null", () => {
    const result = reduce(base, { kind: "set_service_status", status: null });
    expect(result.serviceStatus).toBeNull();
  });
});
