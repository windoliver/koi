import { describe, expect, test } from "bun:test";
import { computeStringHash } from "@koi/hash";

import { createInMemorySurfaceStore } from "./canvas-store.js";

describe("createInMemorySurfaceStore", () => {
  test("create → get returns entry with correct hash", async () => {
    const store = createInMemorySurfaceStore();
    const result = await store.create("s1", "content-1", { metadata: { key: "val" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceId).toBe("s1");
    expect(result.value.content).toBe("content-1");
    expect(result.value.contentHash).toBe(computeStringHash("content-1"));
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
    expect(updated.value.contentHash).toBe(computeStringHash("v2"));
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

  test("create at capacity → RESOURCE_EXHAUSTED (no silent eviction)", async () => {
    const store = createInMemorySurfaceStore({ maxSurfaces: 2 });
    await store.create("s1", "v1");
    await store.create("s2", "v2");

    const overflow = await store.create("s3", "v3");
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error.code).toBe("RESOURCE_EXHAUSTED");
    expect(overflow.error.retryable).toBe(true);

    // Existing surfaces are untouched — no silent data loss
    expect(await store.has("s1")).toEqual({ ok: true, value: true });
    expect(await store.has("s2")).toEqual({ ok: true, value: true });
    expect(store.size()).toBe(2);

    // Freeing a slot lets the next create succeed
    await store.delete("s1");
    const retry = await store.create("s3", "v3");
    expect(retry.ok).toBe(true);
  });

  test("create persists ownerId from options", async () => {
    const store = createInMemorySurfaceStore();
    const result = await store.create("s1", "v1", { ownerId: "agent-a" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ownerId).toBe("agent-a");
  });

  test("create without metadata omits metadata field", async () => {
    const store = createInMemorySurfaceStore();
    const result = await store.create("s1", "v1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toBeUndefined();
    expect(result.value.ownerId).toBeUndefined();
  });

  test("update with expectedOwnerId atomically rejects cross-owner mutation", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1", { ownerId: "alice" });

    const wrong = await store.update("s1", "v2", undefined, "mallory");
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.code).toBe("PERMISSION");

    // Surface untouched
    const peek = await store.get("s1");
    if (!peek.ok) return;
    expect(peek.value.content).toBe("v1");

    const right = await store.update("s1", "v2", undefined, "alice");
    expect(right.ok).toBe(true);
  });

  test("update with expectedOwnerId on ownerless surface → PERMISSION (fail-closed)", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1"); // no ownerId

    const result = await store.update("s1", "v2", undefined, "alice");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PERMISSION");
  });

  test("each create produces a fresh generationId; recreate does not reuse", async () => {
    const store = createInMemorySurfaceStore();
    const a = await store.create("s1", "v1", { ownerId: "alice" });
    if (!a.ok) return;
    const genA = a.value.generationId;
    expect(genA).toBeGreaterThan(0);

    await store.delete("s1", "alice");
    const b = await store.create("s1", "v1-new", { ownerId: "alice" });
    if (!b.ok) return;
    expect(b.value.generationId).toBeGreaterThan(genA);

    // Independent surface gets its own generation
    const c = await store.create("s2", "v2", { ownerId: "alice" });
    if (!c.ok) return;
    expect(c.value.generationId).toBeGreaterThan(b.value.generationId);
  });

  test("delete with expectedOwnerId atomically rejects cross-owner deletion", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1", { ownerId: "alice" });

    const wrong = await store.delete("s1", "mallory");
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.code).toBe("PERMISSION");

    expect(await store.has("s1")).toEqual({ ok: true, value: true });

    const right = await store.delete("s1", "alice");
    expect(right).toEqual({ ok: true, value: true });
  });
});
