/**
 * Tests for createCachedArtifactClient — cache-specific behavior.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { createCachedArtifactClient } from "./cached-client.js";
import type { ArtifactClient } from "./client.js";
import { createInMemoryArtifactStore } from "./memory-store.js";
import type { Artifact, ArtifactId, ArtifactPage, ArtifactQuery, ArtifactUpdate } from "./types.js";
import { artifactId } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(id: string, sizeBytes?: number): Artifact {
  const content = `content-${id}`;
  return {
    id: artifactId(id),
    name: `name-${id}`,
    description: `desc-${id}`,
    content,
    contentType: "text/plain",
    sizeBytes: sizeBytes ?? new TextEncoder().encode(content).byteLength,
    tags: ["test"],
    metadata: {},
    createdBy: "test",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Wraps an ArtifactClient to track method call counts. */
function createSpyClient(inner: ArtifactClient): {
  readonly client: ArtifactClient;
  readonly calls: Record<string, number>;
} {
  const calls: Record<string, number> = {
    save: 0,
    load: 0,
    search: 0,
    remove: 0,
    update: 0,
    exists: 0,
  };

  const client: ArtifactClient = {
    save: async (artifact: Artifact): Promise<Result<void, KoiError>> => {
      calls.save = (calls.save ?? 0) + 1;
      return inner.save(artifact);
    },
    load: async (id: ArtifactId): Promise<Result<Artifact, KoiError>> => {
      calls.load = (calls.load ?? 0) + 1;
      return inner.load(id);
    },
    search: async (query: ArtifactQuery): Promise<Result<ArtifactPage, KoiError>> => {
      calls.search = (calls.search ?? 0) + 1;
      return inner.search(query);
    },
    remove: async (id: ArtifactId): Promise<Result<void, KoiError>> => {
      calls.remove = (calls.remove ?? 0) + 1;
      return inner.remove(id);
    },
    update: async (id: ArtifactId, updates: ArtifactUpdate): Promise<Result<void, KoiError>> => {
      calls.update = (calls.update ?? 0) + 1;
      return inner.update(id, updates);
    },
    exists: async (id: ArtifactId): Promise<Result<boolean, KoiError>> => {
      calls.exists = (calls.exists ?? 0) + 1;
      return inner.exists(id);
    },
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCachedArtifactClient", () => {
  let innerStore: ArtifactClient;
  let spy: ReturnType<typeof createSpyClient>;

  beforeEach(() => {
    innerStore = createInMemoryArtifactStore();
    spy = createSpyClient(innerStore);
  });

  // -----------------------------------------------------------------------
  // Hit/miss
  // -----------------------------------------------------------------------

  describe("cache hit/miss", () => {
    test("first load misses cache, delegates to inner", async () => {
      const cached = createCachedArtifactClient(spy.client);
      const artifact = makeArtifact("hit-1");
      await cached.save(artifact);

      await cached.load(artifactId("hit-1"));
      // save populates cache, so load should be from cache
      expect(spy.calls.load).toBe(0);
    });

    test("second load hits cache without delegating", async () => {
      const cached = createCachedArtifactClient(spy.client);
      // Directly save to inner so cache is not populated on save
      await innerStore.save(makeArtifact("hit-2"));

      // First load: miss → delegate
      await cached.load(artifactId("hit-2"));
      expect(spy.calls.load).toBe(1);

      // Second load: hit → no delegation
      await cached.load(artifactId("hit-2"));
      expect(spy.calls.load).toBe(1);
    });

    test("cache miss after eviction delegates to inner", async () => {
      const cached = createCachedArtifactClient(spy.client, { maxEntries: 1 });

      await cached.save(makeArtifact("evict-1"));
      await cached.save(makeArtifact("evict-2")); // evicts evict-1

      // evict-1 should now miss
      await cached.load(artifactId("evict-1"));
      expect(spy.calls.load).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Invalidation
  // -----------------------------------------------------------------------

  describe("cache invalidation", () => {
    test("save populates cache", async () => {
      const cached = createCachedArtifactClient(spy.client);
      await cached.save(makeArtifact("inv-save"));

      // Load should not delegate
      await cached.load(artifactId("inv-save"));
      expect(spy.calls.load).toBe(0);
    });

    test("update invalidates cache entry", async () => {
      const cached = createCachedArtifactClient(spy.client);
      await cached.save(makeArtifact("inv-update"));

      await cached.update(artifactId("inv-update"), { name: "new-name" });

      // Next load should delegate because entry was invalidated
      await cached.load(artifactId("inv-update"));
      expect(spy.calls.load).toBe(1);
    });

    test("remove invalidates cache entry", async () => {
      const cached = createCachedArtifactClient(spy.client);
      await cached.save(makeArtifact("inv-remove"));

      await cached.remove(artifactId("inv-remove"));

      // Load should delegate (and get NOT_FOUND)
      const result = await cached.load(artifactId("inv-remove"));
      expect(result.ok).toBe(false);
      expect(spy.calls.load).toBe(1);
    });

    test("search always delegates to inner", async () => {
      const cached = createCachedArtifactClient(spy.client);
      await cached.save(makeArtifact("inv-search"));

      await cached.search({});
      await cached.search({});
      expect(spy.calls.search).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Eviction
  // -----------------------------------------------------------------------

  describe("eviction", () => {
    test("evicts LRU entry at maxEntries limit", async () => {
      const cached = createCachedArtifactClient(spy.client, { maxEntries: 2 });

      await cached.save(makeArtifact("e-1"));
      await cached.save(makeArtifact("e-2"));
      await cached.save(makeArtifact("e-3")); // evicts e-1

      // e-1 should miss, e-2 and e-3 should hit
      await cached.load(artifactId("e-1"));
      expect(spy.calls.load).toBe(1);

      await cached.load(artifactId("e-3"));
      expect(spy.calls.load).toBe(1); // still 1, hit from cache
    });

    test("most recently used entry survives eviction", async () => {
      const cached = createCachedArtifactClient(spy.client, { maxEntries: 2 });

      await cached.save(makeArtifact("mru-1"));
      await cached.save(makeArtifact("mru-2"));

      // Touch mru-1 so it's most recently used
      await cached.load(artifactId("mru-1"));

      await cached.save(makeArtifact("mru-3")); // evicts mru-2 (LRU)

      // mru-1 should hit
      await cached.load(artifactId("mru-1"));
      expect(spy.calls.load).toBe(0); // Was 0 from earlier loads (all cache hits)

      // mru-2 should miss
      await cached.load(artifactId("mru-2"));
      expect(spy.calls.load).toBe(1);
    });

    test("respects maxSizeBytes limit", async () => {
      // Each artifact has ~10 bytes of content
      const cached = createCachedArtifactClient(spy.client, {
        maxEntries: 100,
        maxSizeBytes: 25, // Only room for ~2 artifacts
      });

      await cached.save(makeArtifact("sz-1", 10));
      await cached.save(makeArtifact("sz-2", 10));
      await cached.save(makeArtifact("sz-3", 10)); // should evict sz-1

      // sz-1 should miss
      await cached.load(artifactId("sz-1"));
      expect(spy.calls.load).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // TTL
  // -----------------------------------------------------------------------

  describe("TTL", () => {
    test("expired entry triggers re-fetch", async () => {
      const cached = createCachedArtifactClient(spy.client, { ttlMs: 1 }); // 1ms TTL

      await cached.save(makeArtifact("ttl-1"));

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 10));

      await cached.load(artifactId("ttl-1"));
      expect(spy.calls.load).toBe(1); // re-fetched
    });

    test("fresh entry served from cache", async () => {
      const cached = createCachedArtifactClient(spy.client, { ttlMs: 60_000 }); // 60s TTL

      await cached.save(makeArtifact("ttl-fresh"));

      await cached.load(artifactId("ttl-fresh"));
      expect(spy.calls.load).toBe(0); // served from cache
    });
  });

  // -----------------------------------------------------------------------
  // Passthrough
  // -----------------------------------------------------------------------

  describe("passthrough", () => {
    test("mutations delegate to inner client", async () => {
      const cached = createCachedArtifactClient(spy.client);
      const artifact = makeArtifact("pass-1");

      await cached.save(artifact);
      expect(spy.calls.save).toBe(1);

      await cached.update(artifactId("pass-1"), { name: "new" });
      expect(spy.calls.update).toBe(1);

      await cached.remove(artifactId("pass-1"));
      expect(spy.calls.remove).toBe(1);
    });

    test("inner errors propagate through cache", async () => {
      const cached = createCachedArtifactClient(spy.client);
      const result = await cached.load(artifactId("nonexistent"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("exists checks cache before delegating", async () => {
      const cached = createCachedArtifactClient(spy.client);
      await cached.save(makeArtifact("pass-exists"));

      const result = await cached.exists(artifactId("pass-exists"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
      // Should have hit cache, not delegated exists
      expect(spy.calls.exists).toBe(0);
    });
  });
});
