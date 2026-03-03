import { describe, expect, it } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { NexusRestClient } from "@koi/nexus-client";
import { createNexusIndexer } from "./nexus-indexer.js";
import { BASE_CONFIG } from "./test-helpers.js";

function createClient(
  handler: (method: string, path: string, body?: unknown) => Result<unknown, KoiError>,
): NexusRestClient {
  return {
    request: async <T>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Result<T, KoiError>> => handler(method, path, body) as Result<T, KoiError>,
  };
}

describe("createNexusIndexer", () => {
  describe("index", () => {
    it("sends documents to /api/v2/search/index", async () => {
      let capturedPath = "";
      let capturedBody: unknown;
      const client = createClient((_method, path, body) => {
        capturedPath = path;
        capturedBody = body;
        return { ok: true, value: { indexed: 2 } };
      });

      const indexer = createNexusIndexer(client, BASE_CONFIG);
      const result = await indexer.index([
        { id: "doc1", content: "hello world" },
        { id: "doc2", content: "foo bar", metadata: { lang: "en" } },
      ]);

      expect(result.ok).toBe(true);
      expect(capturedPath).toBe("/api/v2/search/index");
      const body = capturedBody as { documents: unknown[] };
      expect(body.documents).toHaveLength(2);
    });

    it("includes embeddings when provided", async () => {
      let capturedBody: unknown;
      const client = createClient((_method, _path, body) => {
        capturedBody = body;
        return { ok: true, value: { indexed: 1 } };
      });

      const indexer = createNexusIndexer(client, BASE_CONFIG);
      await indexer.index([{ id: "doc1", content: "test", embedding: [0.1, 0.2, 0.3] }]);

      const body = capturedBody as { documents: ReadonlyArray<{ embedding?: readonly number[] }> };
      expect(body.documents[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it("returns error on server failure", async () => {
      const client = createClient(() => ({
        ok: false,
        error: { code: "EXTERNAL", message: "server error", retryable: true },
      }));

      const indexer = createNexusIndexer(client, BASE_CONFIG);
      const result = await indexer.index([{ id: "doc1", content: "test" }]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.retryable).toBe(true);
    });

    it("returns error on auth failure", async () => {
      const client = createClient(() => ({
        ok: false,
        error: { code: "PERMISSION", message: "unauthorized", retryable: false },
      }));

      const indexer = createNexusIndexer(client, BASE_CONFIG);
      const result = await indexer.index([{ id: "doc1", content: "test" }]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("PERMISSION");
    });

    it("chunks 250 documents into 3 batches with maxBatchSize=100", async () => {
      let callCount = 0;
      const batchSizes: number[] = [];
      const client = createClient((_method, _path, body) => {
        callCount++;
        const b = body as { documents: unknown[] };
        batchSizes.push(b.documents.length);
        return { ok: true, value: { indexed: b.documents.length } };
      });

      const indexer = createNexusIndexer(client, { ...BASE_CONFIG, maxBatchSize: 100 });
      const docs = Array.from({ length: 250 }, (_, i) => ({
        id: `doc-${String(i)}`,
        content: `content ${String(i)}`,
      }));

      const result = await indexer.index(docs);

      expect(result.ok).toBe(true);
      expect(callCount).toBe(3);
      expect(batchSizes).toEqual([100, 100, 50]);
    });

    it("returns ok with no HTTP call for empty document list", async () => {
      let called = false;
      const client = createClient(() => {
        called = true;
        return { ok: true, value: { indexed: 0 } };
      });

      const indexer = createNexusIndexer(client, BASE_CONFIG);
      const result = await indexer.index([]);

      expect(result.ok).toBe(true);
      expect(called).toBe(false);
    });

    it("stops on first batch failure", async () => {
      let callCount = 0;
      const client = createClient(() => {
        callCount++;
        if (callCount === 2) {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "server error", retryable: true },
          };
        }
        return { ok: true, value: { indexed: 100 } };
      });

      const indexer = createNexusIndexer(client, { ...BASE_CONFIG, maxBatchSize: 100 });
      const docs = Array.from({ length: 300 }, (_, i) => ({
        id: `doc-${String(i)}`,
        content: `content ${String(i)}`,
      }));

      const result = await indexer.index(docs);

      expect(result.ok).toBe(false);
      expect(callCount).toBe(2);
    });
  });

  describe("remove", () => {
    it("sends ids to /api/v2/search/refresh", async () => {
      let capturedPath = "";
      let capturedBody: unknown;
      const client = createClient((_method, path, body) => {
        capturedPath = path;
        capturedBody = body;
        return { ok: true, value: { removed: 2 } };
      });

      const indexer = createNexusIndexer(client, BASE_CONFIG);
      const result = await indexer.remove(["doc1", "doc2"]);

      expect(result.ok).toBe(true);
      expect(capturedPath).toBe("/api/v2/search/refresh");
      const body = capturedBody as { remove: string[] };
      expect(body.remove).toEqual(["doc1", "doc2"]);
    });

    it("returns error on auth failure", async () => {
      const client = createClient(() => ({
        ok: false,
        error: { code: "PERMISSION", message: "forbidden", retryable: false },
      }));

      const indexer = createNexusIndexer(client, BASE_CONFIG);
      const result = await indexer.remove(["doc1"]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("PERMISSION");
    });

    it("returns ok with no HTTP call for empty ids", async () => {
      let called = false;
      const client = createClient(() => {
        called = true;
        return { ok: true, value: { removed: 0 } };
      });

      const indexer = createNexusIndexer(client, BASE_CONFIG);
      const result = await indexer.remove([]);

      expect(result.ok).toBe(true);
      expect(called).toBe(false);
    });
  });
});
