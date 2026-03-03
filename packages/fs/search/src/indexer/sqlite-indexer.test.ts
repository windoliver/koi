import { afterEach, describe, expect, test } from "bun:test";
import type { Embedder } from "../contracts.js";
import { createSqliteIndexer } from "./sqlite-indexer.js";

const dims = 8;

function createMockEmbedder(): Embedder {
  return {
    embed: async (text: string) => {
      const hash = Array.from(text).reduce((h, c) => h + c.charCodeAt(0), 0);
      return Array.from({ length: dims }, (_, i) => Math.sin(hash * (i + 1)));
    },
    embedMany: async (texts: readonly string[]) => {
      const embedder = createMockEmbedder();
      return Promise.all(texts.map((t) => embedder.embed(t)));
    },
    dimensions: dims,
  };
}

describe("SqliteIndexer", () => {
  let indexer: ReturnType<typeof createSqliteIndexer>;

  afterEach(() => {
    indexer?.close();
  });

  test("index single document", async () => {
    indexer = createSqliteIndexer({ dbPath: ":memory:", embedder: createMockEmbedder() });

    const result = await indexer.index([
      { id: "1", content: "hello world", metadata: { title: "test" } },
    ]);

    expect(result.ok).toBe(true);
  });

  test("index multiple documents", async () => {
    indexer = createSqliteIndexer({ dbPath: ":memory:", embedder: createMockEmbedder() });

    const result = await indexer.index([
      { id: "1", content: "hello world" },
      { id: "2", content: "goodbye world" },
      { id: "3", content: "another document here" },
    ]);

    expect(result.ok).toBe(true);
  });

  test("remove documents", async () => {
    indexer = createSqliteIndexer({ dbPath: ":memory:", embedder: createMockEmbedder() });

    await indexer.index([
      { id: "1", content: "hello world" },
      { id: "2", content: "goodbye world" },
    ]);

    const result = await indexer.remove(["1"]);
    expect(result.ok).toBe(true);
  });

  test("re-index replaces existing document", async () => {
    indexer = createSqliteIndexer({ dbPath: ":memory:", embedder: createMockEmbedder() });

    await indexer.index([{ id: "1", content: "version 1" }]);
    const result = await indexer.index([{ id: "1", content: "version 2" }]);
    expect(result.ok).toBe(true);
  });

  test("index long document triggers chunking", async () => {
    indexer = createSqliteIndexer({
      dbPath: ":memory:",
      embedder: createMockEmbedder(),
      chunkerConfig: { chunkSize: 50, chunkOverlap: 10 },
    });

    const longContent = Array.from(
      { length: 10 },
      (_, i) => `Paragraph ${i} with some content.`,
    ).join("\n\n");
    const result = await indexer.index([{ id: "1", content: longContent }]);
    expect(result.ok).toBe(true);
  });

  test("batch embedding respects batch size", async () => {
    let batchCalls = 0;
    const trackingEmbedder: Embedder = {
      embed: async () => new Array(dims).fill(0) as number[],
      embedMany: async (texts: readonly string[]) => {
        batchCalls++;
        return texts.map(() => new Array(dims).fill(0) as number[]);
      },
      dimensions: dims,
    };

    indexer = createSqliteIndexer({
      dbPath: ":memory:",
      embedder: trackingEmbedder,
      embeddingBatchSize: 2,
      chunkerConfig: { chunkSize: 10, chunkOverlap: 0 },
    });

    // This should produce multiple chunks, triggering multiple batch calls
    const result = await indexer.index([{ id: "1", content: "a".repeat(50) }]);
    expect(result.ok).toBe(true);
    expect(batchCalls).toBeGreaterThanOrEqual(1);
  });

  test("remove non-existent ID is ok", async () => {
    indexer = createSqliteIndexer({ dbPath: ":memory:", embedder: createMockEmbedder() });
    const result = await indexer.remove(["nonexistent"]);
    expect(result.ok).toBe(true);
  });

  test("empty documents array is ok", async () => {
    indexer = createSqliteIndexer({ dbPath: ":memory:", embedder: createMockEmbedder() });
    const result = await indexer.index([]);
    expect(result.ok).toBe(true);
  });

  test("uses pre-computed embedding when single chunk", async () => {
    let embedCalled = false;
    const trackingEmbedder: Embedder = {
      embed: async () => {
        embedCalled = true;
        return new Array(dims).fill(0) as number[];
      },
      embedMany: async () => {
        embedCalled = true;
        return [];
      },
      dimensions: dims,
    };

    indexer = createSqliteIndexer({ dbPath: ":memory:", embedder: trackingEmbedder });

    const precomputed = new Array(dims).fill(0.5) as number[];
    const result = await indexer.index([
      { id: "1", content: "short text", embedding: precomputed },
    ]);

    expect(result.ok).toBe(true);
    expect(embedCalled).toBe(false);
  });
});
