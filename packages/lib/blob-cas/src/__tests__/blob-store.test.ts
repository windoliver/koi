/**
 * Unit tests for the default filesystem BlobStore impl.
 * Full contract tests live in contract.test.ts (added in Task 5).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesystemBlobStore } from "../blob-store.js";

describe("createFilesystemBlobStore", () => {
  let blobDir: string;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-bs-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("put returns SHA-256 hex", async () => {
    const store = createFilesystemBlobStore(blobDir);
    const bytes = new TextEncoder().encode("hello");
    const hash = await store.put(bytes);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test("put is idempotent on identical bytes", async () => {
    const store = createFilesystemBlobStore(blobDir);
    const bytes = new TextEncoder().encode("dedup");
    const h1 = await store.put(bytes);
    const h2 = await store.put(bytes);
    expect(h1).toBe(h2);
  });

  test("get returns bytes or undefined", async () => {
    const store = createFilesystemBlobStore(blobDir);
    const bytes = new TextEncoder().encode("hello");
    const hash = await store.put(bytes);
    expect(await store.get(hash)).toEqual(bytes);
    expect(await store.get("0".repeat(64))).toBeUndefined();
  });

  test("has reflects put/delete", async () => {
    const store = createFilesystemBlobStore(blobDir);
    const bytes = new TextEncoder().encode("hello");
    const hash = await store.put(bytes);
    expect(await store.has(hash)).toBe(true);
    await store.delete(hash);
    expect(await store.has(hash)).toBe(false);
  });

  test("delete is idempotent on missing hash", async () => {
    const store = createFilesystemBlobStore(blobDir);
    expect(await store.delete("0".repeat(64))).toBe(false);
    const hash = await store.put(new TextEncoder().encode("x"));
    expect(await store.delete(hash)).toBe(true);
    expect(await store.delete(hash)).toBe(false);
  });

  test("list yields every stored hash exactly once", async () => {
    const store = createFilesystemBlobStore(blobDir);
    const h1 = await store.put(new TextEncoder().encode("a"));
    const h2 = await store.put(new TextEncoder().encode("b"));
    const h3 = await store.put(new TextEncoder().encode("c"));

    const seen = new Set<string>();
    for await (const hash of store.list()) {
      expect(seen.has(hash)).toBe(false);
      seen.add(hash);
    }
    expect(seen).toEqual(new Set([h1, h2, h3]));
  });

  test("put is visible to has/get immediately (read-after-write)", async () => {
    const store = createFilesystemBlobStore(blobDir);
    const bytes = new TextEncoder().encode("rw");
    const hash = await store.put(bytes);
    expect(await store.has(hash)).toBe(true);
    expect(await store.get(hash)).toEqual(bytes);
  });
});
