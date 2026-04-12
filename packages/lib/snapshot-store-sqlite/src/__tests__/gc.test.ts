/**
 * Mark-and-sweep blob GC tests.
 *
 * Per #1625 design review issue 13A, prune sweeps orphan blobs from the
 * CAS blob directory. The tests cover:
 *
 *   - All-orphan: every blob is unreferenced → all deleted
 *   - None-orphan: every blob is referenced → none deleted
 *   - Partial: some referenced, some not → only orphans deleted
 *   - Head-protected: pruned chain head is still referenced via cache → blobs preserved
 *   - GC disabled when blobDir is omitted (no-op safe)
 *   - Sharded layout: <blobDir>/<2-hex>/<full-hash>
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainId } from "@koi/core";
import { chainId } from "@koi/core";
import { createSnapshotStoreSqlite } from "../sqlite-store.js";

interface BlobPayload {
  readonly label: string;
  readonly blobs: readonly string[];
}

function makeTempPath(): string {
  return join(tmpdir(), `koi-snapshot-store-gc-${crypto.randomUUID()}.db`);
}

function makeBlobDir(): string {
  const dir = join(tmpdir(), `koi-snapshot-store-blobs-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeBlob(blobDir: string, hash: string, content = ""): void {
  // Flat layout for tests: <blobDir>/<full-hash>
  writeFileSync(join(blobDir, hash), content);
}

function writeShardedBlob(blobDir: string, hash: string, content = ""): void {
  // Sharded layout: <blobDir>/<first-2>/<full-hash>
  const shardDir = join(blobDir, hash.slice(0, 2));
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(join(shardDir, hash), content);
}

describe("blob GC", () => {
  let blobDir: string;
  let dbPath: string;
  const c1: ChainId = chainId("chain-gc");
  let store: ReturnType<typeof createSnapshotStoreSqlite<BlobPayload>>;

  beforeEach(() => {
    blobDir = makeBlobDir();
    dbPath = makeTempPath();
  });

  afterEach(() => {
    store?.close();
    rmSync(blobDir, { recursive: true, force: true });
  });

  test("all-orphan: prune deletes every blob when nothing is referenced", () => {
    // No snapshots at all, but blobs sitting in the dir.
    store = createSnapshotStoreSqlite<BlobPayload>({
      path: dbPath,
      blobDir,
      extractBlobRefs: (p) => p.blobs,
    });
    writeBlob(blobDir, "a".repeat(64));
    writeBlob(blobDir, "b".repeat(64));

    // Put one snapshot referencing nothing, then prune (with default retain).
    store.put(c1, { label: "empty", blobs: [] }, []);
    const pruneResult = store.prune(c1, { retainCount: 100 });
    expect(pruneResult.ok).toBe(true);

    expect(readdirSync(blobDir).length).toBe(0);
  });

  test("none-orphan: prune preserves all referenced blobs", () => {
    store = createSnapshotStoreSqlite<BlobPayload>({
      path: dbPath,
      blobDir,
      extractBlobRefs: (p) => p.blobs,
    });
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    writeBlob(blobDir, hashA);
    writeBlob(blobDir, hashB);

    store.put(c1, { label: "uses-a-and-b", blobs: [hashA, hashB] }, []);
    store.prune(c1, { retainCount: 100 });

    const remaining = readdirSync(blobDir).sort();
    expect(remaining).toEqual([hashA, hashB]);
  });

  test("partial: only unreferenced blobs are deleted", () => {
    store = createSnapshotStoreSqlite<BlobPayload>({
      path: dbPath,
      blobDir,
      extractBlobRefs: (p) => p.blobs,
    });
    const hashLive = "1".repeat(64);
    const hashOrphan = "2".repeat(64);
    writeBlob(blobDir, hashLive);
    writeBlob(blobDir, hashOrphan);

    store.put(c1, { label: "uses-live", blobs: [hashLive] }, []);
    store.prune(c1, { retainCount: 100 });

    const remaining = readdirSync(blobDir);
    expect(remaining).toEqual([hashLive]);
  });

  test("head protection keeps the head's blobs after retainCount=0", () => {
    store = createSnapshotStoreSqlite<BlobPayload>({
      path: dbPath,
      blobDir,
      extractBlobRefs: (p) => p.blobs,
    });
    const hashOld = "3".repeat(64);
    const hashHead = "4".repeat(64);
    writeBlob(blobDir, hashOld);
    writeBlob(blobDir, hashHead);

    store.put(c1, { label: "old", blobs: [hashOld] }, []);
    store.put(c1, { label: "head", blobs: [hashHead] }, []);

    // retainCount=0 + default retainBranches=true → head survives, old is pruned.
    store.prune(c1, { retainCount: 0 });

    const remaining = readdirSync(blobDir);
    // Old blob is now an orphan (only the head's snapshot row remains alive).
    expect(remaining).toEqual([hashHead]);
  });

  test("GC is a no-op when blobDir is omitted", () => {
    // No blobDir → GC should never touch the filesystem; we verify this by
    // pre-populating a directory and confirming nothing changes.
    store = createSnapshotStoreSqlite<BlobPayload>({
      path: dbPath,
      // intentionally no blobDir or extractBlobRefs
    });
    const orphan = "5".repeat(64);
    writeBlob(blobDir, orphan);

    store.put(c1, { label: "x", blobs: [] }, []);
    store.prune(c1, { retainCount: 100 });

    // The orphan is still there because GC was disabled.
    expect(readdirSync(blobDir)).toEqual([orphan]);
  });

  test("sharded layout: walks <blobDir>/<2-hex>/<full-hash>", () => {
    store = createSnapshotStoreSqlite<BlobPayload>({
      path: dbPath,
      blobDir,
      extractBlobRefs: (p) => p.blobs,
    });
    const live = "ab".padEnd(64, "0");
    const orphan = "cd".padEnd(64, "0");
    writeShardedBlob(blobDir, live);
    writeShardedBlob(blobDir, orphan);

    store.put(c1, { label: "x", blobs: [live] }, []);
    store.prune(c1, { retainCount: 100 });

    // The live blob's shard dir should still hold its file; the orphan shard
    // dir is empty (we don't rmdir empty shards — that's a separate concern).
    const liveShard = readdirSync(join(blobDir, live.slice(0, 2)));
    expect(liveShard).toEqual([live]);
    const orphanShard = readdirSync(join(blobDir, orphan.slice(0, 2)));
    expect(orphanShard).toEqual([]);
  });
});
