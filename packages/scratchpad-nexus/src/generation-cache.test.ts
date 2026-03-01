/**
 * Tests for createGenerationCache — generation-based caching with LRU eviction.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentGroupId,
  KoiError,
  Result,
  ScratchpadEntry,
  ScratchpadEntrySummary,
  ScratchpadGeneration,
  ScratchpadPath,
  ScratchpadWriteResult,
} from "@koi/core";
import { agentGroupId, agentId, scratchpadPath } from "@koi/core";
import { createGenerationCache } from "./generation-cache.js";
import type { ScratchpadClient } from "./scratchpad-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_GROUP_ID = agentGroupId("test-group");
const TEST_AUTHOR_ID = agentId("test-author");

function makeEntry(path: string, generation: number, content?: string): ScratchpadEntry {
  return {
    path: scratchpadPath(path),
    content: content ?? `content-${path}`,
    generation: generation as ScratchpadGeneration,
    groupId: TEST_GROUP_ID,
    authorId: TEST_AUTHOR_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sizeBytes: new TextEncoder().encode(content ?? `content-${path}`).byteLength,
  };
}

function createMockClient(overrides?: {
  readonly generation?: (
    groupId: AgentGroupId,
    path: ScratchpadPath,
  ) => Promise<Result<ScratchpadGeneration, KoiError>>;
  readonly read?: (
    groupId: AgentGroupId,
    path: ScratchpadPath,
  ) => Promise<Result<ScratchpadEntry, KoiError>>;
}): ScratchpadClient {
  return {
    write: mock(
      (): Promise<Result<ScratchpadWriteResult, KoiError>> =>
        Promise.resolve({
          ok: true,
          value: {
            path: scratchpadPath("test"),
            generation: 1 as ScratchpadGeneration,
            sizeBytes: 4,
          },
        }),
    ),
    read:
      overrides?.read !== undefined
        ? mock(overrides.read)
        : mock(
            (): Promise<Result<ScratchpadEntry, KoiError>> =>
              Promise.resolve({ ok: true, value: makeEntry("test", 1) }),
          ),
    generation:
      overrides?.generation !== undefined
        ? mock(overrides.generation)
        : mock(
            (): Promise<Result<ScratchpadGeneration, KoiError>> =>
              Promise.resolve({ ok: true, value: 1 as ScratchpadGeneration }),
          ),
    list: mock(
      (): Promise<Result<readonly ScratchpadEntrySummary[], KoiError>> =>
        Promise.resolve({ ok: true, value: [] }),
    ),
    delete: mock(
      (): Promise<Result<void, KoiError>> => Promise.resolve({ ok: true, value: undefined }),
    ),
    provision: mock(
      (): Promise<Result<void, KoiError>> => Promise.resolve({ ok: true, value: undefined }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGenerationCache", () => {
  // -------------------------------------------------------------------------
  // Read behavior
  // -------------------------------------------------------------------------

  describe("read", () => {
    test("first read fetches from client and caches", async () => {
      const entry = makeEntry("notes/plan.md", 1);
      const client = createMockClient({
        read: () => Promise.resolve({ ok: true, value: entry }),
        generation: () => Promise.resolve({ ok: true, value: 1 as ScratchpadGeneration }),
      });
      const cache = createGenerationCache(client);

      const result = await cache.read(TEST_GROUP_ID, scratchpadPath("notes/plan.md"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(entry);
      }
      expect(client.read).toHaveBeenCalledTimes(1);
      expect(cache.size()).toBe(1);
    });

    test("second read checks generation and returns cached on match", async () => {
      const entry = makeEntry("data.json", 1);
      const client = createMockClient({
        read: () => Promise.resolve({ ok: true, value: entry }),
        generation: () => Promise.resolve({ ok: true, value: 1 as ScratchpadGeneration }),
      });
      const cache = createGenerationCache(client);

      // First read — populates cache
      await cache.read(TEST_GROUP_ID, scratchpadPath("data.json"));
      expect(client.read).toHaveBeenCalledTimes(1);

      // Second read — generation matches, served from cache
      const result = await cache.read(TEST_GROUP_ID, scratchpadPath("data.json"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(entry);
      }
      // read should not have been called again
      expect(client.read).toHaveBeenCalledTimes(1);
      // generation was checked
      expect(client.generation).toHaveBeenCalledTimes(1);
    });

    test("second read fetches fresh when generation changes", async () => {
      const entryV1 = makeEntry("data.json", 1, "v1");
      const entryV2 = makeEntry("data.json", 2, "v2");

      // let justified: tracks call count to switch behavior
      let readCallCount = 0;
      let generationCallCount = 0;

      const client = createMockClient({
        read: () => {
          readCallCount += 1;
          const entry = readCallCount === 1 ? entryV1 : entryV2;
          return Promise.resolve({ ok: true, value: entry });
        },
        generation: () => {
          generationCallCount += 1;
          // First call on second read: return new generation to trigger re-fetch
          const gen = generationCallCount === 1 ? 2 : 2;
          return Promise.resolve({ ok: true, value: gen as ScratchpadGeneration });
        },
      });
      const cache = createGenerationCache(client);

      // First read — populates cache with v1
      const result1 = await cache.read(TEST_GROUP_ID, scratchpadPath("data.json"));
      expect(result1.ok).toBe(true);
      if (result1.ok) {
        expect(result1.value.content).toBe("v1");
      }

      // Second read — generation mismatch, fetches fresh v2
      const result2 = await cache.read(TEST_GROUP_ID, scratchpadPath("data.json"));
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect(result2.value.content).toBe("v2");
      }

      // read called twice (initial + re-fetch)
      expect(client.read).toHaveBeenCalledTimes(2);
    });

    test("propagates read error from client", async () => {
      const client = createMockClient({
        read: () =>
          Promise.resolve({
            ok: false,
            error: { code: "NOT_FOUND", message: "Not found", retryable: false },
          }),
      });
      const cache = createGenerationCache(client);

      const result = await cache.read(TEST_GROUP_ID, scratchpadPath("missing.txt"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
      expect(cache.size()).toBe(0);
    });

    test("falls through to full read when generation check fails", async () => {
      const entry = makeEntry("data.json", 1);
      // let justified: tracks call count to switch behavior
      let genCallCount = 0;

      const client = createMockClient({
        read: () => Promise.resolve({ ok: true, value: entry }),
        generation: () => {
          genCallCount += 1;
          if (genCallCount === 1) {
            return Promise.resolve({
              ok: false,
              error: { code: "INTERNAL", message: "Generation check failed", retryable: true },
            });
          }
          return Promise.resolve({ ok: true, value: 1 as ScratchpadGeneration });
        },
      });
      const cache = createGenerationCache(client);

      // First read — populates cache
      await cache.read(TEST_GROUP_ID, scratchpadPath("data.json"));

      // Second read — generation check fails, falls through to full read
      const result = await cache.read(TEST_GROUP_ID, scratchpadPath("data.json"));
      expect(result.ok).toBe(true);
      // read called twice (initial + fallback after generation error)
      expect(client.read).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Invalidation
  // -------------------------------------------------------------------------

  describe("invalidate", () => {
    test("removes entry from cache", async () => {
      const entry = makeEntry("notes/plan.md", 1);
      const client = createMockClient({
        read: () => Promise.resolve({ ok: true, value: entry }),
      });
      const cache = createGenerationCache(client);

      await cache.read(TEST_GROUP_ID, scratchpadPath("notes/plan.md"));
      expect(cache.size()).toBe(1);

      cache.invalidate(scratchpadPath("notes/plan.md"));
      expect(cache.size()).toBe(0);
    });

    test("is a no-op for paths not in cache", () => {
      const client = createMockClient();
      const cache = createGenerationCache(client);

      // Should not throw
      cache.invalidate(scratchpadPath("nonexistent.txt"));
      expect(cache.size()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Clear
  // -------------------------------------------------------------------------

  describe("clear", () => {
    test("removes all entries from cache", async () => {
      const client = createMockClient({
        read: (_groupId, path) => Promise.resolve({ ok: true, value: makeEntry(path, 1) }),
      });
      const cache = createGenerationCache(client);

      await cache.read(TEST_GROUP_ID, scratchpadPath("a.txt"));
      await cache.read(TEST_GROUP_ID, scratchpadPath("b.txt"));
      expect(cache.size()).toBe(2);

      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // LRU eviction
  // -------------------------------------------------------------------------

  describe("LRU eviction", () => {
    test("evicts oldest entry when cache is full", async () => {
      const client = createMockClient({
        read: (_groupId, path) => Promise.resolve({ ok: true, value: makeEntry(path, 1) }),
        generation: () => Promise.resolve({ ok: true, value: 1 as ScratchpadGeneration }),
      });

      // maxSize = 2
      const cache = createGenerationCache(client, 2);

      await cache.read(TEST_GROUP_ID, scratchpadPath("a.txt"));
      await cache.read(TEST_GROUP_ID, scratchpadPath("b.txt"));
      expect(cache.size()).toBe(2);

      // Adding a third should evict the oldest (a.txt)
      await cache.read(TEST_GROUP_ID, scratchpadPath("c.txt"));
      expect(cache.size()).toBe(2);

      // Reading a.txt again should trigger a full read (it was evicted)
      // Reset mock to track new calls
      const readCalls = (client.read as ReturnType<typeof mock>).mock.calls.length;
      await cache.read(TEST_GROUP_ID, scratchpadPath("a.txt"));
      const newReadCalls = (client.read as ReturnType<typeof mock>).mock.calls.length;
      // Should have made a new read call (cache miss after eviction)
      expect(newReadCalls).toBeGreaterThan(readCalls);
    });
  });
});
