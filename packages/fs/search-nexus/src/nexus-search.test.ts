import { describe, expect, it } from "bun:test";
import { createNexusSearch } from "./nexus-search.js";
import type { NexusQueryResponse } from "./nexus-types.js";
import { createMockFetch } from "./test-helpers.js";

const VALID_CONFIG = {
  baseUrl: "http://localhost:2026",
  apiKey: "sk-test",
  retry: { maxRetries: 0, initialDelayMs: 0, backoffMultiplier: 1, maxBackoffMs: 0, jitter: false },
} as const;

function createFetchSequence(
  responses: ReadonlyArray<{ readonly status: number; readonly body: unknown }>,
): typeof fetch {
  let callIndex = 0;
  return (async () => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: resp !== undefined && resp.status >= 200 && resp.status < 300,
      status: resp?.status ?? 500,
      json: async () => resp?.body,
      text: async () => JSON.stringify(resp?.body),
    };
  }) as unknown as typeof fetch;
}

describe("createNexusSearch", () => {
  it("throws on invalid config", () => {
    expect(() => createNexusSearch({ baseUrl: "", apiKey: "sk-test" })).toThrow("baseUrl");
  });

  it("creates a valid NexusSearch composite", () => {
    const search = createNexusSearch({
      ...VALID_CONFIG,
      fetchFn: createMockFetch({ status: 200, body: {} }),
    });

    expect(search.retriever).toBeDefined();
    expect(search.indexer).toBeDefined();
    expect(search.healthCheck).toBeDefined();
    expect(search.getStats).toBeDefined();
    expect(search.reindex).toBeDefined();
    expect(search.close).toBeDefined();
  });

  describe("healthCheck", () => {
    it("returns health on success", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({
          status: 200,
          body: { healthy: true, index_name: "test-idx", message: "ok" },
        }),
      });

      const result = await search.healthCheck();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.healthy).toBe(true);
      expect(result.value.indexName).toBe("test-idx");
      expect(result.value.message).toBe("ok");
    });

    it("returns error on server failure", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 500, body: "error" }),
      });

      const result = await search.healthCheck();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("EXTERNAL");
    });

    it("returns error on malformed response", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 200, body: { not: "health" } }),
      });

      const result = await search.healthCheck();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
    });
  });

  describe("getStats", () => {
    it("returns stats on success", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({
          status: 200,
          body: {
            document_count: 42,
            index_size_bytes: 1024,
            last_refreshed: "2026-01-01T00:00:00Z",
          },
        }),
      });

      const result = await search.getStats();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.documentCount).toBe(42);
      expect(result.value.indexSizeBytes).toBe(1024);
      expect(result.value.lastRefreshed).toBe("2026-01-01T00:00:00Z");
    });

    it("returns error on server failure", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 503, body: "unavailable" }),
      });

      const result = await search.getStats();

      expect(result.ok).toBe(false);
    });
  });

  describe("reindex", () => {
    it("returns ok on success", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 200, body: { status: "started" } }),
      });

      const result = await search.reindex();

      expect(result.ok).toBe(true);
    });

    it("returns error on server failure", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 500, body: "error" }),
      });

      const result = await search.reindex();

      expect(result.ok).toBe(false);
    });
  });

  describe("close", () => {
    it("is a no-op that does not throw", () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 200, body: {} }),
      });

      expect(() => search.close()).not.toThrow();
    });
  });

  describe("retriever", () => {
    it("retrieves through the composite", async () => {
      const queryResponse: NexusQueryResponse = {
        hits: [{ path: "a.ts", chunk_text: "code", chunk_index: 0, score: 0.9 }],
        total: 1,
        has_more: false,
      };

      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 200, body: queryResponse }),
      });

      const result = await search.retriever.retrieve({ text: "code", limit: 10 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results).toHaveLength(1);
    });
  });

  describe("indexer", () => {
    it("indexes through the composite", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 200, body: { indexed: 1 } }),
      });

      const result = await search.indexer.index([{ id: "doc1", content: "hello" }]);

      expect(result.ok).toBe(true);
    });

    it("removes through the composite", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        fetchFn: createMockFetch({ status: 200, body: { removed: 1 } }),
      });

      const result = await search.indexer.remove(["doc1"]);

      expect(result.ok).toBe(true);
    });
  });

  describe("retry", () => {
    it("retries on retryable error and eventually succeeds", async () => {
      const search = createNexusSearch({
        ...VALID_CONFIG,
        retry: {
          maxRetries: 2,
          initialDelayMs: 1,
          backoffMultiplier: 1,
          maxBackoffMs: 10,
          jitter: false,
        },
        fetchFn: createFetchSequence([
          { status: 500, body: "server error" },
          { status: 200, body: { healthy: true } },
        ]),
      });

      const result = await search.healthCheck();

      expect(result.ok).toBe(true);
    });

    it("does not retry on non-retryable error", async () => {
      let callCount = 0;
      const fetchFn = (async () => {
        callCount++;
        return {
          ok: false,
          status: 403,
          json: async () => ({}),
          text: async () => "forbidden",
        };
      }) as unknown as typeof fetch;

      const search = createNexusSearch({
        ...VALID_CONFIG,
        retry: {
          maxRetries: 3,
          initialDelayMs: 1,
          backoffMultiplier: 1,
          maxBackoffMs: 10,
          jitter: false,
        },
        fetchFn,
      });

      const result = await search.healthCheck();

      expect(result.ok).toBe(false);
      expect(callCount).toBe(1);
    });
  });
});
