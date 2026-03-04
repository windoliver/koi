import { describe, expect, test } from "bun:test";
import { computeContentHash, createInMemorySurfaceStore } from "./canvas-store.js";

describe("computeContentHash", () => {
  test("returns deterministic SHA-256 hex for same content", () => {
    const hash1 = computeContentHash("hello world");
    const hash2 = computeContentHash("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test("returns different hashes for different content", () => {
    const hash1 = computeContentHash("hello");
    const hash2 = computeContentHash("world");
    expect(hash1).not.toBe(hash2);
  });
});

describe("createInMemorySurfaceStore", () => {
  test("create → get returns entry with correct hash", async () => {
    const store = createInMemorySurfaceStore();
    const result = await store.create("s1", "content-1", { key: "val" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceId).toBe("s1");
    expect(result.value.content).toBe("content-1");
    expect(result.value.contentHash).toBe(computeContentHash("content-1"));
    expect(result.value.metadata).toEqual({ key: "val" });

    const getResult = await store.get("s1");
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.content).toBe("content-1");
  });

  test("create duplicate surfaceId → CONFLICT", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "content-1");
    const dup = await store.create("s1", "content-2");
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.error.code).toBe("CONFLICT");
  });

  test("get nonexistent → NOT_FOUND", async () => {
    const store = createInMemorySurfaceStore();
    const result = await store.get("nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("update with matching expectedHash → success + new hash", async () => {
    const store = createInMemorySurfaceStore();
    const created = await store.create("s1", "v1");
    if (!created.ok) throw new Error("setup failed");
    const oldHash = created.value.contentHash;

    const updated = await store.update("s1", "v2", oldHash);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.content).toBe("v2");
    expect(updated.value.contentHash).toBe(computeContentHash("v2"));
    expect(updated.value.contentHash).not.toBe(oldHash);
  });

  test("update with stale expectedHash → CONFLICT", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1");

    const result = await store.update("s1", "v2", "stale-hash");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
  });

  test("update without expectedHash → unconditional success", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1");

    const result = await store.update("s1", "v2", undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("v2");
  });

  test("update nonexistent → NOT_FOUND", async () => {
    const store = createInMemorySurfaceStore();
    const result = await store.update("nope", "v1", undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("delete existing → true, subsequent get → NOT_FOUND", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1");

    const delResult = await store.delete("s1");
    expect(delResult.ok).toBe(true);
    if (!delResult.ok) return;
    expect(delResult.value).toBe(true);

    const getResult = await store.get("s1");
    expect(getResult.ok).toBe(false);
  });

  test("delete nonexistent → false", async () => {
    const store = createInMemorySurfaceStore();
    const result = await store.delete("nope");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  test("has returns true for existing, false for nonexistent", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1");

    const exists = await store.has("s1");
    expect(exists.ok).toBe(true);
    if (exists.ok) expect(exists.value).toBe(true);

    const missing = await store.has("nope");
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.value).toBe(false);
  });

  test("size tracks entries", async () => {
    const store = createInMemorySurfaceStore();
    expect(store.size()).toBe(0);
    await store.create("s1", "v1");
    expect(store.size()).toBe(1);
    await store.create("s2", "v2");
    expect(store.size()).toBe(2);
    await store.delete("s1");
    expect(store.size()).toBe(1);
  });

  test("LRU eviction: oldest-accessed entry evicted when maxSurfaces reached", async () => {
    const store = createInMemorySurfaceStore({ maxSurfaces: 3 });
    await store.create("s1", "v1");
    await store.create("s2", "v2");
    await store.create("s3", "v3");

    // Access s1 to make it more recent than s2
    await store.get("s1");

    // Adding s4 should evict s2 (oldest lastAccessedAt)
    await store.create("s4", "v4");

    expect(store.size()).toBe(3);
    const s2 = await store.has("s2");
    expect(s2).toEqual({ ok: true, value: false });
    const s1 = await store.has("s1");
    expect(s1).toEqual({ ok: true, value: true });
    const s3 = await store.has("s3");
    expect(s3).toEqual({ ok: true, value: true });
    const s4 = await store.has("s4");
    expect(s4).toEqual({ ok: true, value: true });
  });

  test("get updates lastAccessedAt preventing LRU eviction", async () => {
    const store = createInMemorySurfaceStore({ maxSurfaces: 2 });
    await store.create("s1", "v1");
    await store.create("s2", "v2");

    // Access s1 to refresh its timestamp
    await store.get("s1");

    // Adding s3 should evict s2 (s1 was accessed more recently)
    await store.create("s3", "v3");

    const s1 = await store.has("s1");
    expect(s1).toEqual({ ok: true, value: true });
    const s2 = await store.has("s2");
    expect(s2).toEqual({ ok: true, value: false });
    const s3 = await store.has("s3");
    expect(s3).toEqual({ ok: true, value: true });
  });

  test("create without metadata omits metadata field", async () => {
    const store = createInMemorySurfaceStore();
    const result = await store.create("s1", "v1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toBeUndefined();
  });
});
