/**
 * Reusable contract test suite for any SurfaceStore implementation.
 *
 * Call `runSurfaceStoreContractTests(factory)` with a factory that
 * creates a fresh store per test group.
 */

import { describe, expect, test } from "bun:test";
import type { SurfaceStore } from "@koi/gateway-types";

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

export function runSurfaceStoreContractTests(
  createStore: () => SurfaceStore | Promise<SurfaceStore>,
): void {
  describe("SurfaceStore contract", () => {
    describe("create", () => {
      test("creates surface with content hash", async () => {
        const store = await createStore();
        const r = await store.create("s1", "<div>Hello</div>");
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.surfaceId).toBe("s1");
          expect(r.value.contentHash.length).toBe(64);
        }
      });

      test("rejects duplicate surfaceId", async () => {
        const store = await createStore();
        await store.create("s1", "content");
        const r = await store.create("s1", "other");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("CONFLICT");
      });

      test("stores metadata when provided", async () => {
        const store = await createStore();
        const r = await store.create("s1", "content", { key: "value" });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.metadata).toEqual({ key: "value" });
      });
    });

    describe("get", () => {
      test("returns created surface", async () => {
        const store = await createStore();
        await store.create("s1", "content");
        const r = await store.get("s1");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.content).toBe("content");
      });

      test("returns NOT_FOUND for missing surface", async () => {
        const store = await createStore();
        const r = await store.get("missing");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
      });
    });

    describe("update", () => {
      test("updates content with matching hash (CAS)", async () => {
        const store = await createStore();
        const created = await store.create("s1", "v1");
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        const r = await store.update("s1", "v2", created.value.contentHash);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.content).toBe("v2");
      });

      test("rejects update with stale hash", async () => {
        const store = await createStore();
        await store.create("s1", "v1");
        const r = await store.update("s1", "v2", "wrong-hash");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("CONFLICT");
      });

      test("unconditional update with undefined hash", async () => {
        const store = await createStore();
        await store.create("s1", "v1");
        const r = await store.update("s1", "v2", undefined);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.content).toBe("v2");
      });

      test("returns NOT_FOUND for missing surface", async () => {
        const store = await createStore();
        const r = await store.update("missing", "content", undefined);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
      });
    });

    describe("delete / has / size", () => {
      test("delete removes surface", async () => {
        const store = await createStore();
        await store.create("s1", "content");
        const r = await store.delete("s1");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(true);

        const has = await store.has("s1");
        expect(has).toEqual({ ok: true, value: false });
      });

      test("delete returns false for non-existent surface", async () => {
        const store = await createStore();
        const r = await store.delete("missing");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(false);
      });

      test("size tracks entries", async () => {
        const store = await createStore();
        expect(store.size()).toBe(0);
        await store.create("s1", "a");
        await store.create("s2", "b");
        expect(store.size()).toBe(2);
      });
    });
  });
}
