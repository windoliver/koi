/**
 * Reusable contract test suite for BlobStore implementations.
 *
 * Asserts the read-after-write consistency requirement documented on the
 * BlobStore interface. Every backend — FS today, S3 in @koi/artifacts-s3,
 * any future adapter — must pass this suite.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BlobStore } from "./blob-store.js";

export interface BlobStoreContractFactory {
  readonly label: string;
  readonly createStore: () => Promise<{
    readonly store: BlobStore;
    readonly cleanup: () => void | Promise<void>;
  }>;
}

export function runBlobStoreContract(factory: BlobStoreContractFactory): void {
  // let declarations are justified: lifecycle hooks mutate these per test
  let store: BlobStore;
  let cleanup: () => void | Promise<void>;

  beforeEach(async () => {
    const created = await factory.createStore();
    store = created.store;
    cleanup = created.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  test(`[${factory.label}] put returns a 64-char hex hash`, async () => {
    const hash = await store.put(new TextEncoder().encode("hello"));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test(`[${factory.label}] put is idempotent on identical bytes`, async () => {
    const bytes = new TextEncoder().encode("dedup");
    const h1 = await store.put(bytes);
    const h2 = await store.put(bytes);
    expect(h1).toBe(h2);
  });

  test(`[${factory.label}] read-after-write: has/get reflect put immediately`, async () => {
    const bytes = new TextEncoder().encode("rw");
    const hash = await store.put(bytes);
    expect(await store.has(hash)).toBe(true);
    expect(await store.get(hash)).toEqual(bytes);
  });

  test(`[${factory.label}] read-after-write: has/get/list reflect delete immediately`, async () => {
    const hash = await store.put(new TextEncoder().encode("del-me"));
    expect(await store.delete(hash)).toBe(true);
    expect(await store.has(hash)).toBe(false);
    expect(await store.get(hash)).toBeUndefined();
    const listed: string[] = [];
    for await (const h of store.list()) listed.push(h);
    expect(listed).not.toContain(hash);
  });

  test(`[${factory.label}] get returns undefined for unknown hash`, async () => {
    expect(await store.get("0".repeat(64))).toBeUndefined();
  });

  test(`[${factory.label}] delete is idempotent on missing hash`, async () => {
    const absent = "0".repeat(64);
    expect(await store.delete(absent)).toBe(false);
  });

  test(`[${factory.label}] list yields every stored hash exactly once`, async () => {
    const hashes = await Promise.all([
      store.put(new TextEncoder().encode("a")),
      store.put(new TextEncoder().encode("b")),
      store.put(new TextEncoder().encode("c")),
    ]);
    const seen = new Set<string>();
    for await (const h of store.list()) {
      expect(seen.has(h)).toBe(false);
      seen.add(h);
    }
    expect(seen).toEqual(new Set(hashes));
  });

  test(`[${factory.label}] list on empty store yields nothing`, async () => {
    const seen: string[] = [];
    for await (const h of store.list()) seen.push(h);
    expect(seen).toEqual([]);
  });
}
