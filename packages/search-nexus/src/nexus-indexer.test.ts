import { describe, expect, it } from "bun:test";
import { createNexusIndexer } from "./nexus-indexer.js";
import type { NexusSearchConfig } from "./nexus-search-config.js";

const BASE_CONFIG: NexusSearchConfig = {
  baseUrl: "http://localhost:2026",
  apiKey: "sk-test",
};

describe("createNexusIndexer", () => {
  describe("index", () => {
    it("sends documents to POST /api/v2/search/index", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      let capturedMethod = "";
      const fetchFn = (async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedBody = init.body as string;
        capturedMethod = init.method ?? "";
        return { ok: true, status: 200, json: async () => ({ indexed: 2 }) };
      }) as unknown as typeof fetch;

      const indexer = createNexusIndexer({ ...BASE_CONFIG, fetchFn });
      const result = await indexer.index([
        { id: "doc1", content: "hello world" },
        { id: "doc2", content: "foo bar", metadata: { lang: "en" } },
      ]);

      expect(result.ok).toBe(true);
      expect(capturedMethod).toBe("POST");
      expect(new URL(capturedUrl).pathname).toBe("/api/v2/search/index");

      const parsed = JSON.parse(capturedBody) as { documents: unknown[] };
      expect(parsed.documents).toHaveLength(2);
    });

    it("includes embeddings when provided", async () => {
      let capturedBody = "";
      const fetchFn = (async (_url: string, init: RequestInit) => {
        capturedBody = init.body as string;
        return { ok: true, status: 200, json: async () => ({ indexed: 1 }) };
      }) as unknown as typeof fetch;

      const indexer = createNexusIndexer({ ...BASE_CONFIG, fetchFn });
      await indexer.index([{ id: "doc1", content: "test", embedding: [0.1, 0.2, 0.3] }]);

      const parsed = JSON.parse(capturedBody) as {
        documents: ReadonlyArray<{ embedding?: readonly number[] }>;
      };
      expect(parsed.documents[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it("returns error on server failure", async () => {
      const fetchFn = (async () => ({
        ok: false,
        status: 500,
        text: async () => "internal server error",
      })) as unknown as typeof fetch;

      const indexer = createNexusIndexer({ ...BASE_CONFIG, fetchFn });
      const result = await indexer.index([{ id: "doc1", content: "test" }]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    });

    it("returns EXTERNAL error on network failure", async () => {
      const fetchFn = (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;

      const indexer = createNexusIndexer({ ...BASE_CONFIG, fetchFn });
      const result = await indexer.index([{ id: "doc1", content: "test" }]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("ECONNREFUSED");
    });
  });

  describe("remove", () => {
    it("sends ids to POST /api/v2/search/refresh", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      const fetchFn = (async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedBody = init.body as string;
        return { ok: true, status: 200, json: async () => ({ removed: 2 }) };
      }) as unknown as typeof fetch;

      const indexer = createNexusIndexer({ ...BASE_CONFIG, fetchFn });
      const result = await indexer.remove(["doc1", "doc2"]);

      expect(result.ok).toBe(true);
      expect(new URL(capturedUrl).pathname).toBe("/api/v2/search/refresh");

      const parsed = JSON.parse(capturedBody) as { remove: string[] };
      expect(parsed.remove).toEqual(["doc1", "doc2"]);
    });

    it("sends authorization header", async () => {
      let capturedInit: RequestInit | undefined;
      const fetchFn = (async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return { ok: true, status: 200, json: async () => ({ removed: 0 }) };
      }) as unknown as typeof fetch;

      const indexer = createNexusIndexer({ ...BASE_CONFIG, fetchFn });
      await indexer.remove(["id1"]);

      expect(capturedInit?.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer sk-test" }),
      );
    });

    it("returns error on auth failure", async () => {
      const fetchFn = (async () => ({
        ok: false,
        status: 403,
        text: async () => "forbidden",
      })) as unknown as typeof fetch;

      const indexer = createNexusIndexer({ ...BASE_CONFIG, fetchFn });
      const result = await indexer.remove(["doc1"]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("PERMISSION");
    });
  });
});
