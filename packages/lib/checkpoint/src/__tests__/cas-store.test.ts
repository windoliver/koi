/**
 * CAS blob store tests.
 *
 * Verifies streaming-hash write, idempotent dedup, sharded layout, and the
 * memory-bound property: the same content always produces the same hash and
 * the same on-disk path regardless of file size.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobPath, hasBlob, readBlob, writeBlobFromFile } from "../cas-store.js";

function makeBlobDir(): string {
  const dir = join(tmpdir(), `koi-cas-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSourceFile(content: string | Uint8Array): string {
  const path = join(tmpdir(), `koi-cas-src-${crypto.randomUUID()}`);
  writeFileSync(path, content);
  return path;
}

describe("CAS blob store", () => {
  let blobDir: string;
  const created: string[] = [];

  beforeEach(() => {
    blobDir = makeBlobDir();
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
    for (const f of created) {
      try {
        rmSync(f, { force: true });
      } catch {
        // ignore
      }
    }
    created.length = 0;
  });

  test("hasBlob returns false for unknown hash", () => {
    expect(hasBlob(blobDir, "a".repeat(64))).toBe(false);
  });

  test("hasBlob returns false for malformed hash (length check)", () => {
    expect(hasBlob(blobDir, "not-a-real-hash")).toBe(false);
  });

  test("writeBlobFromFile writes a small file and returns its hash", async () => {
    const src = makeSourceFile("hello world");
    created.push(src);

    const hash = await writeBlobFromFile(blobDir, src);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hasBlob(blobDir, hash)).toBe(true);
  });

  test("writeBlobFromFile is deterministic — same content yields same hash", async () => {
    const src1 = makeSourceFile("identical content");
    const src2 = makeSourceFile("identical content");
    created.push(src1, src2);

    const h1 = await writeBlobFromFile(blobDir, src1);
    const h2 = await writeBlobFromFile(blobDir, src2);
    expect(h1).toBe(h2);
  });

  test("writeBlobFromFile is idempotent — second call is a no-op", async () => {
    const src = makeSourceFile("dedup me");
    created.push(src);

    const h1 = await writeBlobFromFile(blobDir, src);
    const h2 = await writeBlobFromFile(blobDir, src);
    expect(h1).toBe(h2);
    // The file is at the same path; no error thrown.
    expect(hasBlob(blobDir, h1)).toBe(true);
  });

  test("blob is stored under sharded path <blobDir>/<2-hex>/<full-hash>", async () => {
    const src = makeSourceFile("layout test");
    created.push(src);

    const hash = await writeBlobFromFile(blobDir, src);
    const expected = blobPath(blobDir, hash);
    expect(expected).toBe(join(blobDir, hash.slice(0, 2), hash));
    expect(hasBlob(blobDir, hash)).toBe(true);
  });

  test("readBlob returns the original bytes", async () => {
    const original = "round trip me";
    const src = makeSourceFile(original);
    created.push(src);

    const hash = await writeBlobFromFile(blobDir, src);
    const bytes = await readBlob(blobDir, hash);
    expect(bytes).toBeDefined();
    if (bytes === undefined) return;
    expect(new TextDecoder().decode(bytes)).toBe(original);
  });

  test("readBlob returns undefined for missing blob", async () => {
    const result = await readBlob(blobDir, "a".repeat(64));
    expect(result).toBeUndefined();
  });

  test("large file (10 MB) hashes correctly via streaming", async () => {
    // 10 MB of repeating bytes — verifies the streaming path doesn't OOM
    // and that the hash is content-based, not size-based.
    const size = 10 * 1024 * 1024;
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = i % 256;
    const src = makeSourceFile(buf);
    created.push(src);

    const hash = await writeBlobFromFile(blobDir, src);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hasBlob(blobDir, hash)).toBe(true);

    // Round-trip the bytes to confirm we wrote what we hashed.
    const back = await readBlob(blobDir, hash);
    expect(back?.length).toBe(size);
    expect(back?.[0]).toBe(0);
    expect(back?.[size - 1]).toBe((size - 1) % 256);
  });

  test("binary content (non-UTF8 bytes) is stored without corruption", async () => {
    // Bytes that would break a string-based store (unmatched UTF-8 surrogates).
    const buf = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x90, 0xa0]);
    const src = makeSourceFile(buf);
    created.push(src);

    const hash = await writeBlobFromFile(blobDir, src);
    const back = await readBlob(blobDir, hash);
    expect(back).toBeDefined();
    if (back === undefined) return;
    expect(Array.from(back)).toEqual([0xff, 0xfe, 0x00, 0x80, 0x90, 0xa0]);
  });

  test("empty file produces a stable, well-known SHA-256", async () => {
    const src = makeSourceFile(new Uint8Array(0));
    created.push(src);

    const hash = await writeBlobFromFile(blobDir, src);
    // SHA-256 of the empty string:
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
