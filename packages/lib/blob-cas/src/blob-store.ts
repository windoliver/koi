/**
 * Pluggable blob storage contract + default filesystem implementation.
 *
 * CONSISTENCY REQUIREMENT: after put(h) resolves, every subsequent has(h) /
 * get(h) / list() MUST reflect its presence. After delete(h) resolves, every
 * subsequent has(h) / get(h) / list() MUST reflect its absence. Read-after-
 * write consistency is required; eventually-consistent backends are not
 * supported. Save-repair and startup recovery in @koi/artifacts rely on this.
 *
 * The FS impl meets this via fsync-then-rename in cas-store.ts. The S3 impl
 * in @koi/artifacts-s3 (Plan 5) meets it via S3's strong read-after-write
 * consistency (global since Dec 2020).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { blobPath, hasBlob, readBlob, writeBlobFromBytes } from "./cas-store.js";

export interface BlobStore {
  readonly put: (data: Uint8Array) => Promise<string>;
  readonly get: (hash: string) => Promise<Uint8Array | undefined>;
  readonly has: (hash: string) => Promise<boolean>;
  readonly delete: (hash: string) => Promise<boolean>;
  readonly list: () => AsyncIterable<string>;
}

/**
 * Create a BlobStore backed by the filesystem CAS layout (sharded by the
 * first two hex chars of the SHA-256 hash).
 */
export function createFilesystemBlobStore(blobDir: string): BlobStore {
  return {
    put: (data) => writeBlobFromBytes(blobDir, data),
    get: (hash) => readBlob(blobDir, hash),
    has: (hash) => Promise.resolve(hasBlob(blobDir, hash)),
    delete: (hash) => deleteBlob(blobDir, hash),
    list: () => listBlobs(blobDir),
  };
}

const HASH_SHARD_LEN = 2;
const HASH_HEX_LEN = 64;

async function deleteBlob(blobDir: string, hash: string): Promise<boolean> {
  if (hash.length !== HASH_HEX_LEN) return false;
  const path = blobPath(blobDir, hash);
  try {
    await Bun.file(path).unlink?.();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
}

async function* listBlobs(blobDir: string): AsyncIterable<string> {
  let shardDirs: readonly string[];
  try {
    shardDirs = readdirSync(blobDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
  for (const shard of shardDirs) {
    if (shard.length !== HASH_SHARD_LEN) continue;
    const shardPath = join(blobDir, shard);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(shardPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let entries: readonly string[];
    try {
      entries = readdirSync(shardPath);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.length === HASH_HEX_LEN && /^[0-9a-f]+$/.test(name)) {
        yield name;
      }
    }
  }
}
