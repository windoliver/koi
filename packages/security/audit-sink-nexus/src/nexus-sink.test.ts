import { describe, expect, test } from "bun:test";
import type { AuditEntry, KoiError, Result } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createNexusAuditSink } from "./nexus-sink.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    schema_version: 1,
    timestamp: 1000,
    sessionId: "session-1",
    agentId: "agent-1",
    turnIndex: 0,
    kind: "tool_call",
    durationMs: 5,
    ...overrides,
  };
}

type TransportHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Result<unknown, KoiError>>;

function makeTransport(handler: TransportHandler): NexusTransport {
  return {
    call: async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      return handler(method, params) as Promise<Result<T, KoiError>>;
    },
    close: () => {},
  };
}

function makeRecordingTransport(): {
  transport: NexusTransport;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport = makeTransport(async (method, params) => {
    calls.push({ method, params });
    return { ok: true, value: undefined };
  });
  return { transport, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusAuditSink", () => {
  test("log + flush writes entries to transport", async () => {
    const { transport, calls } = makeRecordingTransport();
    const sink = createNexusAuditSink({ transport, batchSize: 100 });

    await sink.log(makeEntry({ turnIndex: 0 }));
    await sink.log(makeEntry({ turnIndex: 1 }));
    await sink.flush?.();

    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls).toHaveLength(2);
  });

  test("batch flush at size threshold", async () => {
    const { transport, calls } = makeRecordingTransport();
    const sink = createNexusAuditSink({ transport, batchSize: 2, flushIntervalMs: 60_000 });

    await sink.log(makeEntry({ turnIndex: 0 }));
    await sink.log(makeEntry({ turnIndex: 1 }));

    // Yield to allow fire-and-forget flush to complete
    await new Promise<void>((r) => setTimeout(r, 0));

    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls).toHaveLength(2);
  });

  test("entry paths include sessionId", async () => {
    const { transport, calls } = makeRecordingTransport();
    const sink = createNexusAuditSink({
      transport,
      basePath: "koi/audit",
      batchSize: 100,
    });

    await sink.log(makeEntry({ sessionId: "my-session" }));
    await sink.flush?.();

    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls).toHaveLength(1);
    const path = writeCalls[0]?.params.path as string;
    expect(path).toContain("my-session");
    expect(path.startsWith("koi/audit/my-session/")).toBe(true);
  });

  test("entry paths include kind", async () => {
    const { transport, calls } = makeRecordingTransport();
    const sink = createNexusAuditSink({ transport, batchSize: 100 });

    await sink.log(makeEntry({ kind: "model_call" }));
    await sink.flush?.();

    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls).toHaveLength(1);
    const path = writeCalls[0]?.params.path as string;
    expect(path).toContain("model_call");
  });

  test("query returns entries sorted by timestamp", async () => {
    const store = new Map<string, string>();
    const transport = makeTransport(async (method, params) => {
      const p = (params as { path: string }).path;
      if (method === "write") {
        store.set(p, (params as { content: string }).content);
        return { ok: true, value: undefined };
      }
      if (method === "list") {
        const prefix = `${p}/`;
        return {
          ok: true,
          value: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ path: k })),
        };
      }
      if (method === "read") {
        const v = store.get(p);
        return v !== undefined
          ? { ok: true, value: v }
          : { ok: false, error: { code: "NOT_FOUND" as const, message: "nf", retryable: false } };
      }
      return { ok: true, value: undefined };
    });

    const sink = createNexusAuditSink({ transport, batchSize: 100 });

    // Log entries with different timestamps (later first to verify sort)
    await sink.log(makeEntry({ timestamp: 2000, turnIndex: 1 }));
    await sink.log(makeEntry({ timestamp: 1000, turnIndex: 0 }));

    const entries = await sink.query?.("session-1");
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(2);
    expect(entries?.[0]?.timestamp).toBe(1000);
    expect(entries?.[1]?.timestamp).toBe(2000);
  });

  test("flush propagates write error", async () => {
    const transport = makeTransport(async () => ({
      ok: false,
      error: { code: "INTERNAL" as const, message: "write failed", retryable: false },
    }));

    const sink = createNexusAuditSink({ transport, batchSize: 100 });

    await sink.log(makeEntry());
    await expect(sink.flush?.()).rejects.toThrow("Failed to write audit entry");
  });

  test("malformed JSON entry skipped in query", async () => {
    const store = new Map<string, string>([
      ["koi/audit/session-1/valid.json", JSON.stringify(makeEntry({ timestamp: 1000 }))],
      ["koi/audit/session-1/malformed.json", "not-valid-json{{{"],
    ]);

    const transport = makeTransport(async (method, params) => {
      const p = (params as { path: string }).path;
      if (method === "list") {
        const prefix = `${p}/`;
        return {
          ok: true,
          value: [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ path: k })),
        };
      }
      if (method === "read") {
        const v = store.get(p);
        return v !== undefined
          ? { ok: true, value: v }
          : { ok: false, error: { code: "NOT_FOUND" as const, message: "nf", retryable: false } };
      }
      return { ok: true, value: undefined };
    });

    const sink = createNexusAuditSink({ transport, batchSize: 100 });
    // No log calls — store already pre-populated, flush is a no-op
    const entries = await sink.query?.("session-1");
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.timestamp).toBe(1000);
  });
});
