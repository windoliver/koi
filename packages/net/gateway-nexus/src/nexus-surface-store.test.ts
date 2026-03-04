import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { SurfaceEntry } from "@koi/gateway-types";
import type { NexusClient } from "@koi/nexus-client";
import { runSurfaceStoreContractTests } from "@koi/test-utils";
import type { NexusSurfaceStoreHandle } from "./nexus-surface-store.js";
import { createNexusSurfaceStore } from "./nexus-surface-store.js";

// ---------------------------------------------------------------------------
// Test NexusClient factory — concentrates the generic interface mock in one place.
// TypeScript cannot structurally satisfy a generic method from a concrete mock,
// so a single assertion here is unavoidable for test mocking.
// ---------------------------------------------------------------------------

function createTestNexusClient(
  handler: (method: string, params: Record<string, unknown>) => Promise<Result<unknown, KoiError>>,
): NexusClient {
  return { rpc: handler } as NexusClient;
}

// Run shared contract suite against Nexus-backed implementation
runSurfaceStoreContractTests(() => {
  const client = createTestNexusClient(async (method) => {
    if (method === "read") {
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "not found", retryable: false },
      };
    }
    return { ok: true, value: null };
  });
  const handle = createNexusSurfaceStore({
    client,
    config: {
      nexusUrl: "http://localhost:2026",
      apiKey: "test-key",
      writeQueue: { flushIntervalMs: 60_000 },
    },
  });
  return handle.store;
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockClient(): {
  readonly client: NexusClient;
  readonly calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }>;
  readonly setResponse: (r: Result<unknown, KoiError>) => void;
} {
  const calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
  let nextResponse: Result<unknown, KoiError> = { ok: true, value: null };

  return {
    client: createTestNexusClient(async (method, params) => {
      calls.push({ method, params });
      return nextResponse;
    }),
    calls,
    setResponse: (r: Result<unknown, KoiError>) => {
      nextResponse = r;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NexusSurfaceStore", () => {
  let mock: ReturnType<typeof createMockClient>;
  let handle: NexusSurfaceStoreHandle;

  beforeEach(() => {
    mock = createMockClient();
    handle = createNexusSurfaceStore({
      client: mock.client,
      config: {
        nexusUrl: "http://localhost:2026",
        apiKey: "test-key",
        instanceId: "instance-1",
        writeQueue: { flushIntervalMs: 60_000 },
      },
    });
  });

  afterEach(async () => {
    await handle.dispose();
  });

  test("create stores surface and returns entry with hash", async () => {
    const r = await handle.store.create("s1", "<div>Hello</div>");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.surfaceId).toBe("s1");
      expect(r.value.content).toBe("<div>Hello</div>");
      expect(r.value.contentHash).toBeDefined();
      expect(r.value.contentHash.length).toBe(64); // SHA-256 hex
    }
  });

  test("create rejects duplicate surfaceId", async () => {
    await handle.store.create("s1", "content");
    const r = await handle.store.create("s1", "other");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CONFLICT");
  });

  test("create stores metadata when provided", async () => {
    const r = await handle.store.create("s1", "content", { key: "value" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.metadata).toEqual({ key: "value" });
    }
  });

  test("get returns cached surface", async () => {
    await handle.store.create("s1", "content");
    const r = await handle.store.get("s1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.surfaceId).toBe("s1");
    }
  });

  test("get returns NOT_FOUND for unknown surface", async () => {
    mock.setResponse({
      ok: false,
      error: { code: "NOT_FOUND", message: "not found", retryable: false },
    });
    const r = await handle.store.get("missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  test("get fetches from Nexus on cache miss", async () => {
    const entry: SurfaceEntry = {
      surfaceId: "remote-s1",
      content: "remote content",
      contentHash: "abc123",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
    };
    mock.setResponse({ ok: true, value: JSON.stringify(entry) });

    const r = await handle.store.get("remote-s1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.surfaceId).toBe("remote-s1");
    }
  });

  test("update with matching hash succeeds", async () => {
    const createResult = await handle.store.create("s1", "v1");
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const r = await handle.store.update("s1", "v2", createResult.value.contentHash);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.content).toBe("v2");
    }
  });

  test("update with stale hash returns CONFLICT", async () => {
    await handle.store.create("s1", "v1");
    const r = await handle.store.update("s1", "v2", "wrong-hash");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CONFLICT");
  });

  test("update without expectedHash succeeds unconditionally", async () => {
    await handle.store.create("s1", "v1");
    const r = await handle.store.update("s1", "v2", undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.content).toBe("v2");
  });

  test("update returns NOT_FOUND for unknown surface", async () => {
    const r = await handle.store.update("missing", "content", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  test("delete removes surface from cache", () => {
    handle.store.create("s1", "content");
    const r = handle.store.delete("s1");
    expect(r).toEqual({ ok: true, value: true });
    expect(handle.store.has("s1")).toEqual({ ok: true, value: false });
  });

  test("delete returns false for non-existent surface", () => {
    const r = handle.store.delete("missing");
    expect(r).toEqual({ ok: true, value: false });
  });

  test("has checks local cache", () => {
    expect(handle.store.has("s1")).toEqual({ ok: true, value: false });
    handle.store.create("s1", "content");
    expect(handle.store.has("s1")).toEqual({ ok: true, value: true });
  });

  test("size tracks entries", () => {
    expect(handle.store.size()).toBe(0);
    handle.store.create("s1", "a");
    handle.store.create("s2", "b");
    expect(handle.store.size()).toBe(2);
  });

  test("LRU eviction when at capacity", () => {
    const handle2 = createNexusSurfaceStore({
      client: mock.client,
      config: {
        nexusUrl: "http://localhost:2026",
        apiKey: "test-key",
        writeQueue: { flushIntervalMs: 60_000 },
      },
      storeConfig: { maxSurfaces: 2 },
    });

    handle2.store.create("s1", "first");
    handle2.store.create("s2", "second");
    // Access s1 to make s2 the least recently used
    handle2.store.get("s1");
    handle2.store.create("s3", "third");

    expect(handle2.store.size()).toBe(2);
    expect(handle2.store.has("s2")).toEqual({ ok: true, value: false });
    expect(handle2.store.has("s1")).toEqual({ ok: true, value: true });
    expect(handle2.store.has("s3")).toEqual({ ok: true, value: true });

    void handle2.dispose();
  });

  test("starts in healthy mode", () => {
    expect(handle.degradation().mode).toBe("healthy");
  });
});
