import { describe, expect, test } from "bun:test";
import { computeStringHash } from "@koi/hash";

import { createInMemorySurfaceStore, surfaceEtag } from "./canvas-store.js";

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

  test("update with matching surfaceEtag token → success + new hash", async () => {
    const store = createInMemorySurfaceStore();
    const created = await store.create("s1", "v1");
    if (!created.ok) throw new Error("setup failed");
    const oldToken = surfaceEtag(created.value);

    const updated = await store.update("s1", "v2", oldToken);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.content).toBe("v2");
    expect(updated.value.contentHash).toBe(computeStringHash("v2"));
    expect(surfaceEtag(updated.value)).not.toBe(oldToken);
  });

  test("delete-recreate with identical content yields a fresh ETag (generation fence)", async () => {
    const store = createInMemorySurfaceStore();
    const v1 = await store.create("s1", "same-content", { ownerId: "alice" });
    if (!v1.ok) return;
    const oldToken = surfaceEtag(v1.value);

    await store.delete("s1", "alice", oldToken);
    const v2 = await store.create("s1", "same-content", { ownerId: "alice" });
    if (!v2.ok) return;
    const newToken = surfaceEtag(v2.value);

    // Same content — same hash — but different generation, so the token
    // must not collide.
    expect(v1.value.contentHash).toBe(v2.value.contentHash);
    expect(newToken).not.toBe(oldToken);

    // Stale PATCH against the recreated surface is rejected
    const stalePatch = await store.update("s1", "v3", oldToken, "alice");
    expect(stalePatch.ok).toBe(false);
    if (stalePatch.ok) return;
    expect(stalePatch.error.code).toBe("CONFLICT");

    // Stale DELETE against the recreated surface is rejected
    const staleDel = await store.delete("s1", "alice", oldToken);
    expect(staleDel.ok).toBe(false);
    if (staleDel.ok) return;
    expect(staleDel.error.code).toBe("CONFLICT");

    // New token works
    const fresh = await store.update("s1", "v3", newToken, "alice");
    expect(fresh.ok).toBe(true);
  });

  test("no-op update (same content) advances etag — stale token rejected", async () => {
    const store = createInMemorySurfaceStore();
    const created = await store.create("s1", "v1");
    if (!created.ok) throw new Error("setup");
    const oldToken = surfaceEtag(created.value);

    // PATCH with identical content still bumps version → token changes
    const noop = await store.update("s1", "v1", oldToken);
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.value.version).toBe(created.value.version + 1);
    expect(surfaceEtag(noop.value)).not.toBe(oldToken);

    // Second PATCH with the OLD token must now be rejected
    const stale = await store.update("s1", "v2", oldToken);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("CONFLICT");

    // DELETE with the old token must also be rejected
    const staleDel = await store.delete("s1", undefined, oldToken);
    expect(staleDel.ok).toBe(false);
  });

  test("update with stale expectedEtag → CONFLICT", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1");

    const result = await store.update("s1", "v2", "stale-hash");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
  });

  test("update without expectedEtag → unconditional success", async () => {
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

  test("per-tenant quota — one tenant cannot exhaust create capacity for others", async () => {
    const store = createInMemorySurfaceStore({
      maxSurfaces: 100,
      maxSurfacesPerTenant: 2,
    });
    // Alice fills her own quota
    expect((await store.create("a1", "x", { ownerId: "alice" })).ok).toBe(true);
    expect((await store.create("a2", "x", { ownerId: "alice" })).ok).toBe(true);
    const aliceOver = await store.create("a3", "x", { ownerId: "alice" });
    expect(aliceOver.ok).toBe(false);
    if (!aliceOver.ok) {
      expect(aliceOver.error.code).toBe("RESOURCE_EXHAUSTED");
      expect(aliceOver.error.message).toContain("Per-tenant");
    }

    // Bob is unaffected — separate quota
    expect((await store.create("b1", "x", { ownerId: "bob" })).ok).toBe(true);
    expect((await store.create("b2", "x", { ownerId: "bob" })).ok).toBe(true);

    // Quota replenishes when alice deletes
    await store.delete("a1", "alice");
    expect((await store.create("a3", "x", { ownerId: "alice" })).ok).toBe(true);
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

  test("update across tenants → NOT_FOUND (tenant-scoped namespace)", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1", { ownerId: "alice" });

    // Mallory's update lookup uses key `mallory:s1` — never collides with
    // alice's `alice:s1`. Result: NOT_FOUND, not PERMISSION (which would
    // leak existence in the global-namespace world).
    const wrong = await store.update("s1", "v2", undefined, "mallory");
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.code).toBe("NOT_FOUND");

    // Alice's surface untouched
    const peek = await store.get("s1", "alice");
    if (!peek.ok) return;
    expect(peek.value.content).toBe("v1");

    const right = await store.update("s1", "v2", undefined, "alice");
    expect(right.ok).toBe(true);
  });

  test("update with ownerId on ownerless surface → NOT_FOUND (separate namespace)", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1"); // no ownerId — lives in unowned slot

    // Alice cannot reach the unowned entry; her tenant namespace doesn't
    // contain "s1".
    const result = await store.update("s1", "v2", undefined, "alice");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
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

  test("delete across tenants is a no-op (tenant-scoped namespace)", async () => {
    const store = createInMemorySurfaceStore();
    await store.create("s1", "v1", { ownerId: "alice" });

    // Mallory's delete looks up `mallory:s1` — not present, idempotent
    // false. Alice's `alice:s1` is untouched.
    const wrong = await store.delete("s1", "mallory");
    expect(wrong).toEqual({ ok: true, value: false });

    expect(await store.has("s1", "alice")).toEqual({ ok: true, value: true });

    const right = await store.delete("s1", "alice");
    expect(right).toEqual({ ok: true, value: true });
  });
});
