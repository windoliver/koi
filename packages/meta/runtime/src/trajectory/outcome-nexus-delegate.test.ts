import { describe, expect, test } from "bun:test";
import type { KoiError, OutcomeReport, Result } from "@koi/core";
import { decisionCorrelationId } from "@koi/core";
import type { NexusTransport } from "@koi/fs-nexus";
import { createNexusOutcomeDelegate } from "./outcome-nexus-delegate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTransport(responses?: Map<string, Result<unknown, KoiError>>): NexusTransport {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const transport: NexusTransport = {
    call: async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      calls.push({ method, params });
      const key = `${method}:${params.path as string}`;
      const response = responses?.get(key);
      if (response !== undefined) return response as Result<T, KoiError>;
      // Unregistered reads return NOT_FOUND (like a real empty Nexus)
      if (method === "read") {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "Not found", retryable: false },
        } as Result<T, KoiError>;
      }
      return { ok: true, value: undefined as T };
    },
    subscribe: () => () => {},
    submitAuthCode: () => {},
    close: () => {},
  };

  // Attach calls array for assertion access
  (transport as unknown as { _calls: typeof calls })._calls = calls;
  return transport;
}

function getCalls(
  transport: NexusTransport,
): Array<{ method: string; params: Record<string, unknown> }> {
  return (
    transport as unknown as {
      _calls: Array<{ method: string; params: Record<string, unknown> }>;
    }
  )._calls;
}

function makeReport(correlationId: string): OutcomeReport {
  return {
    correlationId: decisionCorrelationId(correlationId),
    outcome: "positive",
    metrics: { revenue: 50000 },
    description: "Deal closed",
    reportedBy: "crm",
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createNexusOutcomeDelegate", () => {
  test("put writes JSON to /outcomes/{encoded}.json", async () => {
    const transport = createMockTransport();
    const store = createNexusOutcomeDelegate({ transport });
    const report = makeReport("dcid_abc");

    await store.put(report);

    const calls = getCalls(transport);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("write");
    expect(calls[0]?.params.path).toBe("/outcomes/dcid_abc.json");
    expect(calls[0]?.params.content).toBe(JSON.stringify(report));
  });

  test("get reads and returns parsed report", async () => {
    const report = makeReport("dcid_123");
    const responses = new Map<string, Result<unknown, KoiError>>([
      ["read:/outcomes/dcid_123.json", { ok: true, value: JSON.stringify(report) }],
    ]);
    const transport = createMockTransport(responses);
    const store = createNexusOutcomeDelegate({ transport });

    const result = await store.get("dcid_123");

    expect(result).toBeDefined();
    expect(String(result?.correlationId)).toBe("dcid_123");
    expect(result?.outcome).toBe("positive");
    expect(result?.metrics.revenue).toBe(50000);
  });

  test("get returns undefined for NOT_FOUND", async () => {
    const responses = new Map<string, Result<unknown, KoiError>>([
      [
        "read:/outcomes/dcid_missing.json",
        {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Not found",
            retryable: false,
          },
        },
      ],
    ]);
    const transport = createMockTransport(responses);
    const store = createNexusOutcomeDelegate({ transport });

    const result = await store.get("dcid_missing");

    expect(result).toBeUndefined();
  });

  test("get throws on non-NOT_FOUND errors", async () => {
    const responses = new Map<string, Result<unknown, KoiError>>([
      [
        "read:/outcomes/dcid_fail.json",
        {
          ok: false,
          error: {
            code: "PERMISSION",
            message: "Forbidden",
            retryable: false,
          },
        },
      ],
    ]);
    const transport = createMockTransport(responses);
    const store = createNexusOutcomeDelegate({ transport });

    expect(store.get("dcid_fail")).rejects.toThrow("Forbidden");
  });

  test("put retries on RATE_LIMIT", async () => {
    let writeCount = 0;
    const transport: NexusTransport = {
      call: async <T>(
        _method: string,
        _params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        writeCount++;
        // First write fails with RATE_LIMIT, second succeeds
        if (writeCount === 1) {
          return {
            ok: false,
            error: {
              code: "RATE_LIMIT",
              message: "Rate limited",
              retryable: true,
            },
          };
        }
        return { ok: true, value: undefined as T };
      },
      subscribe: () => () => {},
      submitAuthCode: () => {},
      close: () => {},
    };

    const store = createNexusOutcomeDelegate({ transport });
    // Real backoff is 2s for first retry — this test takes ~2s
    await store.put(makeReport("dcid_retry"));

    expect(writeCount).toBe(2);
  }, 10_000);

  test("custom basePath is respected", async () => {
    const transport = createMockTransport();
    const store = createNexusOutcomeDelegate({
      transport,
      basePath: "custom/path",
    });

    await store.put(makeReport("dcid_custom"));

    const calls = getCalls(transport);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("write");
    expect(calls[0]?.params.path).toBe("/custom/path/dcid_custom.json");
  });

  test("throws on empty basePath", () => {
    const transport = createMockTransport();
    expect(() => createNexusOutcomeDelegate({ transport, basePath: "" })).toThrow(
      "outcomeNexus.basePath must not be empty",
    );
  });

  test("throws on basePath with '..'", () => {
    const transport = createMockTransport();
    expect(() => createNexusOutcomeDelegate({ transport, basePath: "a/../b" })).toThrow(
      "outcomeNexus.basePath must not contain '..' segments",
    );
  });

  test("throws on basePath ending with '/'", () => {
    const transport = createMockTransport();
    expect(() => createNexusOutcomeDelegate({ transport, basePath: "outcomes/" })).toThrow(
      "outcomeNexus.basePath must not end with '/'",
    );
  });

  test("encodes special characters in correlation ID", async () => {
    const transport = createMockTransport();
    const store = createNexusOutcomeDelegate({ transport });

    await store.put(makeReport("id with spaces/slashes"));

    const calls = getCalls(transport);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.path).toBe("/outcomes/id%20with%20spaces%2Fslashes.json");
  });

  test("decodes bytes envelope response", async () => {
    const report = makeReport("dcid_bytes");
    const encoded = Buffer.from(JSON.stringify(report)).toString("base64");
    const responses = new Map<string, Result<unknown, KoiError>>([
      ["read:/outcomes/dcid_bytes.json", { ok: true, value: { __type__: "bytes", data: encoded } }],
    ]);
    const transport = createMockTransport(responses);
    const store = createNexusOutcomeDelegate({ transport });

    const result = await store.get("dcid_bytes");

    expect(String(result?.correlationId)).toBe("dcid_bytes");
  });
});
