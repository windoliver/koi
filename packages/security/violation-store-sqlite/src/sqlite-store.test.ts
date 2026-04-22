import { describe, expect, test } from "bun:test";
import type { AgentId, Violation, ViolationSeverity } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import { createSqliteViolationStore } from "./sqlite-store.js";

function makeViolation(overrides?: Partial<Violation>): Violation {
  return {
    rule: "max-spawn-depth",
    severity: "warning",
    message: "depth exceeded",
    context: { limit: 3, actual: 4 },
    ...overrides,
  };
}

const A1: AgentId = agentId("agent-1");
const A2: AgentId = agentId("agent-2");

describe("createSqliteViolationStore — basic roundtrip", () => {
  test("record → flush → getViolations returns the entry", async () => {
    const store = createSqliteViolationStore({ dbPath: ":memory:" });
    store.record(makeViolation(), A1, "sess-1", 1_000);
    store.flush();
    const page = await store.getViolations({ sessionId: sessionId("sess-1") });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.rule).toBe("max-spawn-depth");
    expect(page.items[0]?.context).toEqual({ limit: 3, actual: 4 });
    store.close();
  });

  test("getViolations auto-flushes pending buffer", async () => {
    const store = createSqliteViolationStore({
      dbPath: ":memory:",
      maxBufferSize: 10_000,
    });
    store.record(makeViolation(), A1, "sess-1", 1_000);
    const page = await store.getViolations({ sessionId: sessionId("sess-1") });
    expect(page.items).toHaveLength(1);
    store.close();
  });

  test("close flushes pending buffer and does not throw", () => {
    const store = createSqliteViolationStore({ dbPath: ":memory:" });
    store.record(makeViolation(), A1, "sess-1", 1_000);
    // Do not call flush; close should flush.
    expect(() => store.close()).not.toThrow();
  });
});

describe("createSqliteViolationStore — filters", () => {
  async function seed() {
    const store = createSqliteViolationStore({ dbPath: ":memory:" });
    store.record(makeViolation({ severity: "info", rule: "r1" }), A1, "S", 1_000);
    store.record(makeViolation({ severity: "warning", rule: "r1" }), A1, "S", 2_000);
    store.record(makeViolation({ severity: "critical", rule: "r2" }), A2, "S", 3_000);
    store.record(makeViolation({ severity: "warning", rule: "r2" }), A2, "T", 4_000);
    store.flush();
    return store;
  }

  test("agentId filter", async () => {
    const store = await seed();
    const page = await store.getViolations({ agentId: A1 });
    expect(page.items).toHaveLength(2);
    store.close();
  });

  test("sessionId filter", async () => {
    const store = await seed();
    const page = await store.getViolations({ sessionId: sessionId("T") });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.rule).toBe("r2");
    store.close();
  });

  test("severity filter (at-or-above)", async () => {
    const store = await seed();
    const page = await store.getViolations({ severity: "warning" });
    // info → out; warning → in; critical → in.
    const sev: ViolationSeverity[] = page.items.map((i) => i.severity);
    expect(sev).not.toContain("info");
    expect(sev.length).toBe(3);
    store.close();
  });

  test("rule filter", async () => {
    const store = await seed();
    const page = await store.getViolations({ rule: "r2" });
    expect(page.items).toHaveLength(2);
    store.close();
  });

  test("since/until time window (inclusive since, exclusive until)", async () => {
    const store = await seed();
    const page = await store.getViolations({ since: 2_000, until: 4_000 });
    expect(page.items).toHaveLength(2); // ts=2000 and ts=3000
    store.close();
  });

  test("limit + cursor pagination", async () => {
    const store = await seed();
    const first = await store.getViolations({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.cursor).toBeDefined();

    const second = await store.getViolations({
      limit: 2,
      ...(first.cursor !== undefined ? { offset: first.cursor } : {}),
    });
    expect(second.items).toHaveLength(2);
    // No overlap: first and second pages must be disjoint in id space.
    const ids1 = new Set(first.items.map((i) => i.rule + i.message));
    for (const item of second.items) {
      expect(ids1.has(item.rule + item.message)).toBe(false);
    }
    store.close();
  });
});

describe("createSqliteViolationStore — concurrency + persistence", () => {
  test("persists across reopen of the same file", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "vstore-"));
    const dbPath = join(dir, "v.db");
    try {
      const a = createSqliteViolationStore({ dbPath });
      a.record(makeViolation(), A1, "sess", 1_000);
      a.close();

      const b = createSqliteViolationStore({ dbPath });
      const page = await b.getViolations({ sessionId: sessionId("sess") });
      expect(page.items).toHaveLength(1);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent writers on the same WAL DB do not error", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "vstore-"));
    const dbPath = join(dir, "v.db");
    try {
      const a = createSqliteViolationStore({ dbPath });
      const b = createSqliteViolationStore({ dbPath });
      for (let i = 0; i < 10; i++) {
        a.record(makeViolation({ rule: `a-${i}` }), A1, "S", 1_000 + i);
        b.record(makeViolation({ rule: `b-${i}` }), A2, "S", 2_000 + i);
      }
      a.flush();
      b.flush();
      const page = await a.getViolations({ limit: 100 });
      expect(page.items.length).toBe(20);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buffer backlog is capped on sustained flush failures", () => {
    // Create a store, close its DB to poison flushes, then record
    // >MAX_BUFFER_BACKLOG entries and assert the buffer stays bounded
    // (oldest-drop policy).
    const store = createSqliteViolationStore({ dbPath: ":memory:" });
    // Wait for 1 flushBuffer to be harmless; then close() closes the DB.
    store.close();

    // Push way past the internal cap. The sink swallows and logs; it
    // must not throw and must not grow without bound. We can't read
    // the private buffer directly, but we can assert the calls are
    // contained (no throw) and that a subsequent flush() is a no-op.
    for (let i = 0; i < 20_000; i++) {
      store.record(makeViolation(), A1, "S", 1 + i);
    }
    expect(() => store.flush()).not.toThrow();
  });

  test("flush never throws even when the underlying DB has been closed", () => {
    // Simulates a transient/terminal write failure: close the store so
    // the next flush hits a closed DB. Callers are the governance hot
    // path (onViolation) and a setInterval tick — a thrown error would
    // either corrupt the governance decision path or become an
    // unhandled rejection that crashes the process. Test asserts the
    // flush remains silent-on-error. Console noise is expected.
    const store = createSqliteViolationStore({ dbPath: ":memory:" });
    store.record(makeViolation(), A1, "S", 1);
    store.close();
    // close() already tried to flush. Calling flush() again on the
    // closed DB must not throw.
    expect(() => store.flush()).not.toThrow();
  });
});
