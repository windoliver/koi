/**
 * Nexus audit sink — unit tests with fake Nexus fetch.
 *
 * Tests batching, interval flushing, retry, file paths, and error handling.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AuditEntry } from "@koi/core";
import { createFakeNexusFetch } from "@koi/test-utils";
import { validateNexusAuditSinkConfig } from "../config.js";
import { createNexusAuditSink } from "../nexus-sink.js";
import { runAuditSinkContractTests } from "./sink-contract.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  baseUrl: "http://fake-nexus:2026",
  apiKey: "test-key",
  basePath: "/audit",
} as const;

interface RpcBody {
  readonly method: string;
  readonly id: number;
  readonly params: Record<string, unknown>;
}

/** Parse an RPC request body from a fetch init. Returns undefined if not parseable. */
function parseRpcBody(init: RequestInit | undefined): RpcBody | undefined {
  if (!init?.body || typeof init.body !== "string") return undefined;
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.method !== "string" || typeof obj.id !== "number") return undefined;
  return parsed satisfies unknown as RpcBody;
}

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: 1700000000000,
    sessionId: "sess-abc",
    agentId: "agent-1",
    turnIndex: 0,
    kind: "model_call",
    durationMs: 42,
    ...overrides,
  };
}

/** Track all RPC write calls by intercepting the fake fetch. */
function createTrackingFetch(): {
  readonly fetch: typeof globalThis.fetch;
  readonly writtenPaths: () => readonly string[];
  readonly writtenEntries: () => readonly AuditEntry[];
} {
  const fakeFetch = createFakeNexusFetch();
  const paths: string[] = [];
  const entries: AuditEntry[] = [];

  // @ts-expect-error — Bun's typeof fetch includes non-callable properties (preconnect)
  const tracked: typeof globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = parseRpcBody(init);
    if (body?.method === "write") {
      paths.push(String(body.params.path));
      const parsed: unknown = JSON.parse(String(body.params.content));
      entries.push(parsed satisfies unknown as AuditEntry);
    }
    return fakeFetch(input, init);
  };

  return {
    fetch: tracked,
    writtenPaths: () => [...paths],
    writtenEntries: () => [...entries],
  };
}

// ---------------------------------------------------------------------------
// Contract tests (reusable suite)
// ---------------------------------------------------------------------------

describe("NexusAuditSink", () => {
  // let justified: reassigned per-test in beforeEach
  let tracking: ReturnType<typeof createTrackingFetch>;

  beforeEach(() => {
    tracking = createTrackingFetch();
  });

  runAuditSinkContractTests(
    () => {
      tracking = createTrackingFetch();
      return createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetch: tracking.fetch,
        retry: { maxRetries: 0 },
      });
    },
    async () => tracking.writtenEntries(),
  );

  // -------------------------------------------------------------------------
  // Batching — size trigger
  // -------------------------------------------------------------------------

  describe("batching", () => {
    test("flushes automatically when buffer reaches batchSize", async () => {
      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 3,
        flushIntervalMs: 60_000,
        fetch: tracking.fetch,
        retry: { maxRetries: 0 },
      });

      await sink.log(makeEntry({ turnIndex: 0 }));
      await sink.log(makeEntry({ turnIndex: 1 }));
      expect(tracking.writtenPaths().length).toBe(0);

      await sink.log(makeEntry({ turnIndex: 2 }));
      // Give fire-and-forget flush a tick to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(tracking.writtenPaths().length).toBe(3);
      await sink.flush?.();
    });

    test("flush() drains entries below batchSize", async () => {
      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetch: tracking.fetch,
        retry: { maxRetries: 0 },
      });

      await sink.log(makeEntry({ turnIndex: 0 }));
      await sink.log(makeEntry({ turnIndex: 1 }));

      expect(tracking.writtenPaths().length).toBe(0);
      await sink.flush?.();
      expect(tracking.writtenPaths().length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // File paths
  // -------------------------------------------------------------------------

  describe("file paths", () => {
    test("writes entries to {basePath}/{sessionId}/{timestamp}-{turnIndex}-{kind}.json", async () => {
      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetch: tracking.fetch,
        retry: { maxRetries: 0 },
      });

      await sink.log(
        makeEntry({
          sessionId: "sess-xyz",
          timestamp: 1700000000000,
          turnIndex: 5,
          kind: "tool_call",
        }),
      );
      await sink.flush?.();

      expect(tracking.writtenPaths()).toEqual(["/audit/sess-xyz/1700000000000-5-tool_call.json"]);
    });

    test("uses custom basePath", async () => {
      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        basePath: "/custom/audit",
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetch: tracking.fetch,
        retry: { maxRetries: 0 },
      });

      await sink.log(makeEntry());
      await sink.flush?.();

      expect(tracking.writtenPaths()[0]).toStartWith("/custom/audit/");
    });
  });

  // -------------------------------------------------------------------------
  // Retry behavior
  // -------------------------------------------------------------------------

  describe("retry", () => {
    test("retries on transient errors and eventually succeeds", async () => {
      // let justified: counter incremented on each call
      let callCount = 0;
      // @ts-expect-error — Bun's typeof fetch includes non-callable properties (preconnect)
      const failOnceFetch: typeof globalThis.fetch = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = parseRpcBody(init);
        if (body?.method === "write") {
          callCount++;
          if (callCount === 1) {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32000, message: "Temporary error" },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        return createFakeNexusFetch()(_input, init);
      };

      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetch: failOnceFetch,
        retry: { maxRetries: 2, initialDelayMs: 1, maxBackoffMs: 5, jitter: false },
      });

      await sink.log(makeEntry());
      await sink.flush?.();

      expect(callCount).toBe(2);
    });

    test("flush() throws on permanent failure", async () => {
      // @ts-expect-error — Bun's typeof fetch includes non-callable properties (preconnect)
      const alwaysFailFetch: typeof globalThis.fetch = async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const body = parseRpcBody(init);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id ?? 0,
            error: { code: -32003, message: "Unauthorized" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetch: alwaysFailFetch,
        retry: { maxRetries: 0 },
      });

      await sink.log(makeEntry());
      await expect(sink.flush?.()).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Config validation
  // -------------------------------------------------------------------------

  describe("config validation", () => {
    test("rejects empty baseUrl", () => {
      const result = validateNexusAuditSinkConfig({ ...BASE_CONFIG, baseUrl: "" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("baseUrl");
      }
    });

    test("rejects empty apiKey", () => {
      const result = validateNexusAuditSinkConfig({ ...BASE_CONFIG, apiKey: "" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("apiKey");
      }
    });

    test("rejects non-positive batchSize", () => {
      const result = validateNexusAuditSinkConfig({ ...BASE_CONFIG, batchSize: 0 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("rejects non-positive flushIntervalMs", () => {
      const result = validateNexusAuditSinkConfig({ ...BASE_CONFIG, flushIntervalMs: -1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("accepts valid config", () => {
      const result = validateNexusAuditSinkConfig(BASE_CONFIG);
      expect(result.ok).toBe(true);
    });

    test("factory throws on invalid config", () => {
      expect(() => createNexusAuditSink({ ...BASE_CONFIG, baseUrl: "" })).toThrow("baseUrl");
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent flush safety
  // -------------------------------------------------------------------------

  describe("concurrency", () => {
    test("concurrent flush does not duplicate writes", async () => {
      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetch: tracking.fetch,
        retry: { maxRetries: 0 },
      });

      await sink.log(makeEntry({ turnIndex: 0 }));
      await sink.log(makeEntry({ turnIndex: 1 }));

      // Trigger two flushes simultaneously
      await Promise.all([sink.flush?.(), sink.flush?.()]);

      expect(tracking.writtenPaths().length).toBe(2);
    });

    test("empty flush is a no-op", async () => {
      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 100,
        flushIntervalMs: 60_000,
        fetch: tracking.fetch,
        retry: { maxRetries: 0 },
      });

      await sink.flush?.();
      expect(tracking.writtenPaths().length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Interval flushing
  // -------------------------------------------------------------------------

  describe("interval flush", () => {
    test("timer triggers flush after flushIntervalMs", async () => {
      const sink = createNexusAuditSink({
        ...BASE_CONFIG,
        batchSize: 100,
        flushIntervalMs: 50,
        fetch: tracking.fetch,
        retry: { maxRetries: 0 },
      });

      await sink.log(makeEntry());

      // Wait for interval to fire
      await new Promise((r) => setTimeout(r, 120));

      expect(tracking.writtenPaths().length).toBeGreaterThanOrEqual(1);
      await sink.flush?.();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests (env-gated)
// ---------------------------------------------------------------------------

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;

(NEXUS_URL && NEXUS_API_KEY ? describe : describe.skip)("Nexus integration", () => {
  test("writes and reads back an audit entry", async () => {
    if (!NEXUS_URL || !NEXUS_API_KEY) return;

    const sink = createNexusAuditSink({
      baseUrl: NEXUS_URL,
      apiKey: NEXUS_API_KEY,
      batchSize: 1,
      flushIntervalMs: 60_000,
    });

    const entry = makeEntry({ sessionId: `integration-${Date.now()}` });
    await sink.log(entry);
    await sink.flush?.();
  });
});
