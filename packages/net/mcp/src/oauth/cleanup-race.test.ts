/**
 * Regression: clearAllOAuthState and concurrent writers must not
 * interleave. Either the writer completes before cleanup (and its
 * record is deleted), or the writer waits for cleanup and writes
 * after stale state is gone — never both half-states at once.
 */

import { describe, expect, test } from "bun:test";
import type { SecureStorage } from "@koi/secure-storage";
import {
  clearAllOAuthState,
  computeOAuthIndexKey,
  computeServerKey,
  withTrackedWrite,
} from "./tokens.js";

function memStore(): SecureStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  const locks = new Map<string, Promise<void>>();
  const storage: SecureStorage & { readonly map: Map<string, string> } = {
    map,
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      return map.delete(key);
    },
    async withLock(key, fn) {
      const prev = locks.get(key) ?? Promise.resolve();
      let resolve: () => void = () => {};
      const next = new Promise<void>((r) => {
        resolve = r;
      });
      locks.set(
        key,
        prev.then(() => next),
      );
      await prev;
      try {
        return await fn();
      } finally {
        resolve();
      }
    },
  };
  return storage;
}

describe("OAuth cleanup vs concurrent writer", () => {
  const name = "test-server";
  const url = "https://example.com/mcp";
  const tokenKey = computeServerKey(name, url);
  const idxKey = computeOAuthIndexKey(name, url);

  test("cleanup running concurrently with a tracked write does not orphan the record", async () => {
    const storage = memStore();

    // Start a tracked write that holds the index lock for ~25ms.
    const writePromise = withTrackedWrite(storage, name, url, tokenKey, async () => {
      await new Promise((r) => setTimeout(r, 25));
      await storage.set(tokenKey, JSON.stringify({ accessToken: "fresh" }));
    });

    // Kick off cleanup almost simultaneously. It should queue behind the
    // writer's idx lock, then sweep AFTER the write completes — so the
    // freshly-persisted token gets deleted along with the index entry.
    await new Promise((r) => setTimeout(r, 5));
    const cleanupPromise = clearAllOAuthState(storage, name, url);

    await Promise.all([writePromise, cleanupPromise]);

    // Either ordering yields a clean final state: the token must not
    // outlive cleanup, and no orphaned index entry remains.
    expect(storage.map.has(tokenKey)).toBe(false);
    expect(storage.map.has(idxKey)).toBe(false);
  });

  test("writer that wins the race against cleanup leaves clean state after cleanup completes", async () => {
    const storage = memStore();

    // Pre-existing token + index from a prior write.
    await withTrackedWrite(storage, name, url, tokenKey, async () => {
      await storage.set(tokenKey, JSON.stringify({ accessToken: "old" }));
    });
    expect(storage.map.has(tokenKey)).toBe(true);
    expect(storage.map.has(idxKey)).toBe(true);

    // Cleanup now: must remove both.
    await clearAllOAuthState(storage, name, url);
    expect(storage.map.has(tokenKey)).toBe(false);
    expect(storage.map.has(idxKey)).toBe(false);
  });

  test("write that fails inside withTrackedWrite rolls back the index entry", async () => {
    const storage = memStore();
    await expect(
      withTrackedWrite(storage, name, url, tokenKey, async () => {
        throw new Error("simulated keychain failure");
      }),
    ).rejects.toThrow("simulated keychain failure");
    // Index should be empty (rolled back) — no phantom entry pointing
    // at a record that was never written.
    expect(storage.map.has(idxKey)).toBe(false);
    expect(storage.map.has(tokenKey)).toBe(false);
  });
});
